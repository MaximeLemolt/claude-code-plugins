import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Line } from '../types'

const COLORS = {
  green: '#5faf5f',
  orange: '#ff8700',
  yellow: '#d7d75f',
  amber: '#ffaf00',
  red: '#ff5f5f',
  cyan: '#5fafd7',
  magenta: '#af87d7',
} as const

const CONFIG_POLL_MS = 1_000
const GIT_POLL_MS = 5_000

const EMPTY: Line = {
  model: '',
  configModel: '',
  effort: '',
  branch: '',
  percent: null,
  cost: null,
}

const line = atom({ plugin: 'session-overview', key: 'line' } as const, EMPTY)
const FAMILY = /(opus|sonnet|haiku|fable)/i

function prettyModel(id: string): string {
  const match = /(?:^|[-\s])(opus|sonnet|haiku|fable)(?:[-\s]+(\d+)(?:[-.](\d{1,2}))?)?(?=$|[-\s])/i.exec(id)
  if (!match) return id

  const family = match[1]!
  const name = family[0]!.toUpperCase() + family.slice(1).toLowerCase()
  return match[2] ? `${name} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : name
}

function modelLabel({ model, configModel }: Line): string {
  if (!model) return prettyModel(configModel)
  if (!configModel) return prettyModel(model)

  const resolved = prettyModel(model)
  const chosen = prettyModel(configModel)
  const resolvedFamily = FAMILY.exec(model)?.[1]?.toLowerCase()
  const chosenFamily = FAMILY.exec(configModel)?.[1]?.toLowerCase()
  const explicitVersion = /(?:opus|sonnet|haiku|fable)[-\s]+\d/i.test(configModel)

  // A changed selection wins; an unversioned alias retains the resolved version.
  return (resolvedFamily && chosenFamily && resolvedFamily !== chosenFamily) ||
    (explicitVersion && resolved !== chosen)
    ? chosen
    : resolved
}

// Past 60% it is recommended to hand the work off to a fresh agent: yellow warns before that.
const CONTEXT_THRESHOLDS = { warn: 45, handoff: 60, critical: 80 } as const
const BAR_WIDTH = 10

function contextColor(percent: number): string {
  if (percent < CONTEXT_THRESHOLDS.warn) return COLORS.green
  if (percent < CONTEXT_THRESHOLDS.handoff) return COLORS.yellow
  if (percent < CONTEXT_THRESHOLDS.critical) return COLORS.orange
  return COLORS.red
}

function contextBar(percent: number): { filled: string; empty: string } {
  const cells = Math.round(Math.min(100, Math.max(0, percent)) / 100 * BAR_WIDTH)
  return { filled: '█'.repeat(cells), empty: '░'.repeat(BAR_WIDTH - cells) }
}

// update() retries concurrent writes; returning the old object avoids unnecessary redraws.
async function patch($: EngineInterface, change: Partial<Line>): Promise<void> {
  await update($, line, current => {
    const changed = (Object.keys(change) as (keyof Line)[])
      .some(key => current[key] !== change[key])
    return changed ? { ...current, ...change } : current
  })
}

async function gitBranch($: EngineInterface): Promise<string> {
  try {
    const cwd = await $.session.cwd()
    const git = async (...args: string[]) => {
      const result = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 2_000 })
      return result.exitCode === 0 ? result.stdout.trim() : ''
    }

    return (await git('symbolic-ref', '--quiet', '--short', 'HEAD')) ||
      (await git('rev-parse', '--short', 'HEAD'))
  } catch {
    return ''
  }
}

async function refreshUsage($: EngineInterface, isCurrent: () => boolean): Promise<void> {
  try {
    const usage = await $.session.usage()
    if (!isCurrent()) return
    await patch($, {
      percent: usage.context.percent ?? null,
      cost: usage.cost?.usd ?? null,
    })
  } catch {
    // Keep the last valid usage values if the API is temporarily unavailable.
  }
}

let timers: { cancel(): void }[] = []
let configPolling: number | undefined
let gitPolling: number | undefined
let generation = 0
let inTurn = false
// The plugin API exposes no getter for the session's effort, so remember the last /effort choice.
let selectedEffort = ''
const LEVELS = /^(low|medium|high|xhigh|max|auto)$/i

type Row = { key: unknown; label?: unknown; value: unknown }

function isModelRow(row: Row): boolean {
  return String(row.key).toLowerCase() === 'model'
}

// The effort row's id varies across versions (effort, effortLevel), so match loosely.
function isEffortRow(row: Row): boolean {
  return /effort/i.test(String(row.key)) || /effort/i.test(String(row.label ?? ''))
}

function rowValue(row: Row | undefined): string {
  const value = row?.value
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

// Reading the config is in-memory, so it can be polled often for a quick model/effort switch.
async function refreshConfig($: EngineInterface, currentGeneration: number): Promise<void> {
  if (configPolling === currentGeneration) return
  configPolling = currentGeneration
  try {
    const [rows, sessionModel, savedEffort] = await Promise.all([
      $.config.list(),
      $.session.model().catch(() => ''),
      $.settings.read({ key: 'effortLevel' }).catch(() => undefined),
    ])
    if (currentGeneration !== generation) return
    // session.model() is what /model shows (with version); the config row may be a bare alias.
    const change: Partial<Line> = { configModel: sessionModel || rowValue(rows.find(isModelRow)) }
    // turn.step supplies the actual effort; only override it with a configured value, never with nothing.
    // A level chosen with /effort (session override) wins over the saved/configured one.
    const configuredEffort = selectedEffort ||
      rowValue(rows.find(isEffortRow)) ||
      (typeof savedEffort === 'string' ? savedEffort : '')
    if (!inTurn && configuredEffort) change.effort = configuredEffort
    await patch($, change)
  } finally {
    if (configPolling === currentGeneration) configPolling = undefined
  }
}

// Git spawns a process, so it stays on a slower cadence.
async function refreshBranch($: EngineInterface, currentGeneration: number): Promise<void> {
  if (gitPolling === currentGeneration) return
  gitPolling = currentGeneration
  try {
    const branch = await gitBranch($)
    if (currentGeneration !== generation) return
    await patch($, { branch })
  } finally {
    if (gitPolling === currentGeneration) gitPolling = undefined
  }
}

function refreshMetadata($: EngineInterface, currentGeneration: number): void {
  void refreshConfig($, currentGeneration).catch(() => {})
  void refreshBranch($, currentGeneration).catch(() => {})
}

function start($: EngineInterface): void {
  timers.forEach(timer => timer.cancel())
  const currentGeneration = ++generation
  timers = [
    $.clock.every(CONFIG_POLL_MS, () => void refreshConfig($, currentGeneration).catch(() => {})),
    $.clock.every(GIT_POLL_MS, () => void refreshBranch($, currentGeneration).catch(() => {})),
  ]
  refreshMetadata($, currentGeneration)
  void refreshUsage($, () => currentGeneration === generation)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    inTurn = false
    start($)
    return result
  })

  // /clear, /resume and /branch reset session state without firing session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, ($, e, next) => {
    inTurn = false
    start($)
    return next(e)
  })

  // `usage().context.percent` only follows the last model response, so it stays stale after
  // /compact until the next turn. Right after compaction, use the local estimate instead.
  on('classic.PostCompact', async ($, e, next) => {
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percentage = usage.context.breakdown?.percentage
      if (typeof percentage === 'number' && Number.isFinite(percentage)) {
        await patch($, { percent: Math.min(100, percentage) })
      }
    } catch {
      // Keep the previous value; the next turn corrects it.
    }
    return next(e)
  })

  on('config.set', async ($, e, next) => {
    const result = await next(e)
    if (isModelRow(e) || isEffortRow(e)) {
      inTurn = false
      void refreshConfig($, generation).catch(() => {})
    }
    return result
  })

  // /effort <level> changes the session's effort at once; show it before the next request.
  on('command.run', { command: ['effort', 'model'] }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim().split(/\s+/)[0] ?? ''
    if (e.command === 'effort' && LEVELS.test(level)) {
      selectedEffort = level.toLowerCase() === 'auto' ? '' : level.toLowerCase()
      inTurn = false
      if (selectedEffort) await patch($, { effort: selectedEffort })
    }
    void refreshConfig($, generation).catch(() => {})
    return result
  })

  on('session.end', ($, e, next) => {
    selectedEffort = ''
    timers.forEach(timer => timer.cancel())
    timers = []
    generation++ // Ignore metadata requests started in the previous session.
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      inTurn = true
      await patch($, {
        model: e.model ?? '',
        ...(e.effort === undefined ? {} : { effort: String(e.effort) }),
      })
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await patch($, {
      percent: e.context.percent ?? null,
      cost: e.cost?.usd ?? null,
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      inTurn = false
      if (e.usage?.model) await patch($, { model: e.usage.model })
      const currentGeneration = generation
      void refreshUsage($, () => currentGeneration === generation)
      refreshMetadata($, generation)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Safety net: if /clear did not deliver a SessionStart event, restart polling on first render.
    if (!timers.length) start($)

    const state = await read($, line)
    const model = modelLabel(state)
    const { branch, effort, percent, cost } = state
    if (!model && !branch && percent === null && cost === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const parts: unknown[] = []
    const add = (key: string, part: unknown) => {
      if (parts.length) parts.push(<Text key={`sep-${key}`} dimColor>{' | '}</Text>)
      parts.push(part)
    }

    if (model) {
      add('model', <Text key="model" color={COLORS.cyan}>{model}</Text>)
      if (effort) parts.push(<Text key="effort" dimColor>{` (${effort})`}</Text>)
    }
    if (branch) add('branch', <Text key="branch" color={COLORS.magenta}>{branch}</Text>)
    if (percent !== null && Number.isFinite(percent)) {
      const color = contextColor(percent)
      const bar = contextBar(percent)
      add('context', (
        <Text key="context">
          <Text dimColor>{'context '}</Text>
          <Text color={color}>{bar.filled}</Text>
          <Text dimColor>{bar.empty}</Text>
          <Text color={color}>{` ${Math.round(percent)}%`}</Text>
        </Text>
      ))
    }
    if (cost !== null && Number.isFinite(cost)) {
      add('cost', <Text key="cost" color={COLORS.amber}>${cost.toFixed(2)}</Text>)
    }

    return <Box>{parts as any}</Box>
  })
}
