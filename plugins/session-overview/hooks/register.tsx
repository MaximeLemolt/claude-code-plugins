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

// Events refresh the row at once; these slow timers only catch changes no event announces
// (a branch switched from another terminal, a settings file edited by hand).
const CONFIG_POLL_MS = 30_000
const GIT_POLL_MS = 30_000

const EMPTY: Line = {
  model: '',
  configModel: '',
  effort: '',
  branch: '',
  percent: null,
  isStale: false,
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

// The host's own local estimate of the context (what /context sums up); free, but it can differ
// by a few points from the figure of the last response, so it is only a fallback.
async function estimatePercent($: EngineInterface): Promise<number | null> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const percentage = usage.context.breakdown?.percentage
    return typeof percentage === 'number' && Number.isFinite(percentage) ? Math.min(100, percentage) : null
  } catch {
    return null
  }
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Never replaces a figure with nothing: a missing value keeps the last one shown.
async function refreshUsage($: EngineInterface, isCurrent: () => boolean): Promise<void> {
  try {
    const usage = await $.session.usage()
    if (!isCurrent()) return
    const change: Partial<Line> = {}
    const percent = isPercent(usage.context.percent) ? usage.context.percent : await estimatePercent($)
    if (!isCurrent()) return
    if (percent !== null) {
      change.percent = percent
      change.isStale = false
    }
    const usd = usage.cost?.usd
    if (isPercent(usd)) change.cost = usd
    await patch($, change)
  } catch {
    // Keep the last valid usage values if the API is temporarily unavailable.
  }
}

let timers: { cancel(): void }[] = []
let generation = 0
let inTurn = false
// The plugin API exposes no getter for the session's effort, so remember the last /effort choice.
let selectedEffort = ''
let lastSavedEffort = ''
// The effort the engine really sent on the last turn of this session. A session-only choice (`max`,
// the app's selector) is saved nowhere, so between turns this is the best figure there is.
let lastTurnEffort = ''
let lastConfigModel = ''
const LEVELS = /^(low|medium|high|xhigh|max|auto)$/i

// Each refresh runs one at a time; a request that arrives meanwhile makes it run once more, so an
// event is never dropped (a plain "already running" guard would lose it until the next timer).
let isConfigRunning = false
let isConfigRequested = false
let isBranchRunning = false
let isBranchRequested = false

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

// The effort a model is saved with: its own `modelSettings` entry (what /effort and the app's
// selector write) beats the global `effortLevel`. Prefix match covers ids like `claude-sonnet-5-5[1m]`.
function savedEffortFor(modelSettings: unknown, model: string, globalEffort: unknown): string {
  const settings = modelSettings && typeof modelSettings === 'object'
    ? modelSettings as Record<string, { effortLevel?: unknown } | undefined>
    : {}
  const id = model.toLowerCase()
  const key = Object.keys(settings)
    .filter(name => id === name.toLowerCase() || id.startsWith(`${name.toLowerCase()}[`) || id.startsWith(`${name.toLowerCase()}-`))
    .sort((a, b) => b.length - a.length)[0]
  const perModel = key ? settings[key]?.effortLevel : undefined
  if (typeof perModel === 'string' && perModel) return perModel
  return typeof globalEffort === 'string' ? globalEffort : ''
}

// Refreshed on the events that change the model or effort, so a switch shows at once.
async function readConfig($: EngineInterface, currentGeneration: number): Promise<void> {
  const [rows, sessionModel, globalEffort, modelSettings] = await Promise.all([
    $.config.list(),
    $.session.model().catch(() => ''),
    $.settings.read({ key: 'effortLevel' }).catch(() => undefined),
    $.settings.read({ key: 'modelSettings' }).catch(() => undefined),
  ])
  if (currentGeneration !== generation) return
  // session.model() is what /model shows (with version); the config row may be a bare alias.
  const change: Partial<Line> = { configModel: sessionModel || rowValue(rows.find(isModelRow)) }
  // turn.step supplies the actual effort; only override it with a configured value, never with nothing.
  // The saved per-model level is what the picker and the app write. A level typed as `/effort <level>`
  // wins until the saved level changes, since that means another choice was made since.
  const savedEffort = savedEffortFor(modelSettings, sessionModel || change.configModel || '', globalEffort)
  const model = sessionModel || change.configModel || ''
  if (model !== lastConfigModel) {
    // Another model has its own effort: what the last turn sent for the previous one no longer applies.
    lastConfigModel = model
    lastTurnEffort = ''
  }
  if (savedEffort !== lastSavedEffort) {
    // A saved level changed after the last turn: it is the newest choice.
    lastSavedEffort = savedEffort
    selectedEffort = ''
    lastTurnEffort = ''
  }
  const configuredEffort = selectedEffort || rowValue(rows.find(isEffortRow)) || lastTurnEffort || savedEffort
  if (!inTurn && configuredEffort) change.effort = configuredEffort
  await patch($, change)
}

async function refreshConfig($: EngineInterface, currentGeneration: number): Promise<void> {
  if (isConfigRunning) {
    isConfigRequested = true
    return
  }
  isConfigRunning = true
  try {
    do {
      isConfigRequested = false
      await readConfig($, currentGeneration)
    } while (isConfigRequested)
  } finally {
    isConfigRunning = false
  }
}

// Git spawns a process: refreshed when the branch may have moved, not on every tick.
async function readBranch($: EngineInterface, currentGeneration: number): Promise<void> {
  const branch = await gitBranch($)
  if (currentGeneration !== generation) return
  await patch($, { branch })
}

async function refreshBranch($: EngineInterface, currentGeneration: number): Promise<void> {
  if (isBranchRunning) {
    isBranchRequested = true
    return
  }
  isBranchRunning = true
  try {
    do {
      isBranchRequested = false
      await readBranch($, currentGeneration)
    } while (isBranchRequested)
  } finally {
    isBranchRunning = false
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
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    inTurn = false
    // The old conversation's context figure no longer applies; start() fetches the new one.
    await patch($, { percent: null, isStale: false })
    start($)
    return next(e)
  })

  // `usage().context.percent` only follows the last model response, so it stays stale after
  // /compact until the next turn. Right after compaction, use the local estimate instead.
  on('classic.PostCompact', async ($, e, next) => {
    // The last figure predates the compaction: show it as stale until a fresh one replaces it.
    await patch($, { isStale: true })
    const percent = await estimatePercent($)
    if (percent !== null) await patch($, { percent, isStale: false })
    return next(e)
  })

  // Settings files changed (the effort picker and the app's selector write them).
  on('classic.ConfigChange', ($, e, next) => {
    void refreshConfig($, generation).catch(() => {})
    return next(e)
  })

  on('classic.PostModelSwitch', ($, e, next) => {
    inTurn = false
    void refreshConfig($, generation).catch(() => {})
    return next(e)
  })

  on('classic.CwdChanged', ($, e, next) => {
    void refreshBranch($, generation).catch(() => {})
    return next(e)
  })

  // A shell command may have switched branch (git checkout, git switch, git worktree...).
  on('classic.PostToolUse', ($, e, next) => {
    if (e.tool_name === 'Bash') void refreshBranch($, generation).catch(() => {})
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
    // The picker or the argument just made a newer choice than the last turn's effort.
    if (e.command === 'effort') lastTurnEffort = ''
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
    lastSavedEffort = ''
    lastTurnEffort = ''
    lastConfigModel = ''
    timers.forEach(timer => timer.cancel())
    timers = []
    generation++ // Ignore metadata requests started in the previous session.
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      inTurn = true
      if (e.effort !== undefined) lastTurnEffort = String(e.effort)
      await patch($, {
        model: e.model ?? '',
        ...(e.effort === undefined ? {} : { effort: String(e.effort) }),
      })
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    const change: Partial<Line> = {}
    if (isPercent(e.context.percent)) {
      change.percent = e.context.percent
      change.isStale = false
    } else {
      const currentGeneration = generation
      void refreshUsage($, () => currentGeneration === generation)
    }
    const usd = e.cost?.usd
    if (isPercent(usd)) change.cost = usd
    await patch($, change)
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
    const { branch, effort, percent, isStale, cost } = state
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
      // A stale figure is dimmed rather than colored: its severity is not known any more.
      const color = isStale ? undefined : contextColor(percent)
      const bar = contextBar(percent)
      add('context', (
        <Text key="context">
          <Text dimColor>{'context '}</Text>
          <Text color={color} dimColor={isStale}>{bar.filled}</Text>
          <Text dimColor>{bar.empty}</Text>
          <Text color={color} dimColor={isStale}>{` ${Math.round(percent)}%`}</Text>
        </Text>
      ))
    }
    if (cost !== null && Number.isFinite(cost)) {
      add('cost', <Text key="cost" color={COLORS.amber}>${cost.toFixed(2)}</Text>)
    }

    return <Box>{parts as any}</Box>
  })
}
