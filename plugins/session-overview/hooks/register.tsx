import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Line } from '../types'
import {
  BAR_WIDTH, COLORS, contextBar, contextColor, fitRow, formatTokens, isPercent, modelLabel,
  normalizeDropOrder, readDisplay, savedEffortFor,
} from './row'
import type { Display, Texts } from './row'

// This plugin's Hide order row in /config: `<plugin>.<field>`.
function isDropOrderRow(key: string): boolean {
  return /^session-overview(@[^.]+)?\.dropOrder$/.test(key)
}

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
  tokens: null,
  window: null,
  cost: null,
}

const line = atom({ plugin: 'session-overview', key: 'line' } as const, EMPTY)
// update() retries concurrent writes; returning the old object avoids unnecessary redraws.
async function patch($: EngineInterface, change: Partial<Line>): Promise<void> {
  if (!isTerminal) return
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
async function estimateContext($: EngineInterface): Promise<{ percent: number; tokens: number | null } | null> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    if (!breakdown || !isPercent(breakdown.percentage)) return null
    return {
      percent: Math.min(100, breakdown.percentage),
      tokens: isPercent(breakdown.totalTokens) ? breakdown.totalTokens : null,
    }
  } catch {
    return null
  }
}

// After a compaction the host keeps reporting the last response's figure until a new response
// arrives; remember it so it is not mistaken for the compacted context.
let figureBeforeCompact: number | null = null

function contextKey(context: { percent?: number; tokens?: number }): number | null {
  return isPercent(context.tokens) ? context.tokens : isPercent(context.percent) ? context.percent : null
}

// The host's figure for the last response, or null when there is none or it predates a compaction.
function freshContext(context: { percent?: number; tokens?: number }): { percent: number; tokens: number | null } | null {
  if (!isPercent(context.percent)) return null
  if (figureBeforeCompact !== null) {
    if (contextKey(context) === figureBeforeCompact) return null
    figureBeforeCompact = null
  }
  return { percent: context.percent, tokens: isPercent(context.tokens) ? context.tokens : null }
}

// Never replaces a figure with nothing: a missing value keeps the last one shown.
async function refreshUsage($: EngineInterface, isCurrent: () => boolean): Promise<void> {
  if (!isTerminal) return
  try {
    const usage = await $.session.usage()
    if (!isCurrent()) return
    const change: Partial<Line> = {}
    const context = freshContext(usage.context) ?? await estimateContext($)
    if (!isCurrent()) return
    if (context) {
      change.percent = context.percent
      change.tokens = context.tokens
      change.isStale = false
    }
    if (isPercent(usage.context.window)) change.window = usage.context.window
    const usd = usage.cost?.usd
    if (isPercent(usd)) change.cost = usd
    await patch($, change)
  } catch {
    // Keep the last valid usage values if the API is temporarily unavailable.
  }
}

// Right after /compact the host still reports the pre-compaction figures, and its estimate moves about
// a second later: show the old figure as stale, then look again a few times until the estimate moves,
// instead of waiting for the next turn. `$.clock.after` timers outlive the hook that sets them.
async function afterCompact($: EngineInterface): Promise<void> {
  if (!isTerminal) return
  const before = await $.session.usage().catch(() => undefined)
  // The host keeps this figure until the next response: it must not replace the compacted one.
  figureBeforeCompact = before ? contextKey(before.context) : null
  await patch($, { isStale: true })
  const context = await estimateContext($)
  if (context) await patch($, { ...context, isStale: false })
  const currentGeneration = generation
  refreshAfterCompact($, () => currentGeneration === generation, context?.tokens ?? null)
}

const COMPACT_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000]
let compactRetry: { cancel(): void } | null = null

function refreshAfterCompact($: EngineInterface, isCurrent: () => boolean, previous: number | null, attempt = 0): void {
  compactRetry?.cancel()
  compactRetry = null
  const delay = COMPACT_RETRY_DELAYS[attempt]
  if (delay === undefined) return
  compactRetry = $.clock.after(delay, () => void retryAfterCompact($, isCurrent, previous, attempt).catch(() => {}))
}

async function retryAfterCompact($: EngineInterface, isCurrent: () => boolean, previous: number | null, attempt: number): Promise<void> {
  if (!isCurrent()) return
  const context = await estimateContext($)
  if (!isCurrent()) return
  if (context && context.tokens !== previous) await patch($, { ...context, isStale: false })
  else refreshAfterCompact($, isCurrent, previous, attempt + 1)
}

let timers: { cancel(): void }[] = []
// The row is for the terminal only: in the desktop app (no terminal attached) the plugin stays idle.
let isTerminal = true
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
  if (!isTerminal) return
  if (isConfigRunning) {
    isConfigRequested = true
    return
  }
  isConfigRunning = true
  try {
    // A read asked for while one runs is done again after it, for the session current by then:
    // the one under way may belong to a start() that a newer one replaced.
    let readGeneration = currentGeneration
    do {
      isConfigRequested = false
      await readConfig($, readGeneration)
      readGeneration = generation
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
  if (!isTerminal) return
  if (isBranchRunning) {
    isBranchRequested = true
    return
  }
  isBranchRunning = true
  try {
    // As for the config: a read asked for meanwhile runs for the session current by then.
    let readGeneration = currentGeneration
    do {
      isBranchRequested = false
      await readBranch($, readGeneration)
      readGeneration = generation
    } while (isBranchRequested)
  } finally {
    isBranchRunning = false
  }
}

function refreshMetadata($: EngineInterface, currentGeneration: number): void {
  void refreshConfig($, currentGeneration).catch(() => {})
  void refreshBranch($, currentGeneration).catch(() => {})
}

async function hasTerminal($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).includes('terminal')
}

function start($: EngineInterface): void {
  timers.forEach(timer => timer.cancel())
  timers = []
  if (!isTerminal) return
  const currentGeneration = ++generation
  timers = [
    $.clock.every(CONFIG_POLL_MS, () => void refreshConfig($, currentGeneration).catch(() => {})),
    $.clock.every(GIT_POLL_MS, () => void refreshBranch($, currentGeneration).catch(() => {})),
  ]
  refreshMetadata($, currentGeneration)
  void refreshUsage($, () => currentGeneration === generation)
}

let display: Display = readDisplay({})

export const register: Register = (on, options) => {
  display = readDisplay(options)
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    inTurn = false
    isTerminal = await hasTerminal($)
    start($)
    return result
  })

  // /clear, /resume and /branch reset session state without firing session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    inTurn = false
    // The old conversation's context figure no longer applies; start() fetches the new one.
    figureBeforeCompact = null
    await patch($, { percent: null, tokens: null, isStale: false })
    start($)
    return next(e)
  })

  // `usage().context.percent` only follows the last model response, so it stays stale after
  // /compact until the next turn. In the terminal the CLI's built-in cc-plugin-sec-default sends
  // session.compact and classic.PostCompact on past this plugin; the end of the /compact command
  // reaches it. An automatic compaction happens within a turn, whose response refreshes the figure.
  on('command.run', { command: ['compact'] }, async ($, e, next) => {
    const result = await next(e)
    await afterCompact($)
    return result
  })

  // Settings files changed (the effort picker and the app's selector write them).
  on('classic.ConfigChange', ($, e, next) => {
    void refreshConfig($, generation).catch(() => {})
    return next(e)
  })

  // Another model may have another window (Haiku 4.5: 200k): read the usage again at once
  // instead of waiting for the end of the next turn.
  on('classic.PostModelSwitch', ($, e, next) => {
    inTurn = false
    void refreshConfig($, generation).catch(() => {})
    const currentGeneration = generation
    void refreshUsage($, () => currentGeneration === generation)
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
    // The hide order is typed freely in /config: store it in a clean form, or refuse it with why.
    if (isDropOrderRow(e.key) && typeof e.value === 'string') {
      const checked = normalizeDropOrder(e.value)
      if ('error' in checked) return { deny: checked.error }
      return next({ ...e, value: checked.value })
    }
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
    if (e.command === 'model') {
      const currentGeneration = generation
      void refreshUsage($, () => currentGeneration === generation)
    }
    return result
  })

  on('session.end', ($, e, next) => {
    selectedEffort = ''
    lastSavedEffort = ''
    lastTurnEffort = ''
    lastConfigModel = ''
    figureBeforeCompact = null
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
    if (isPercent(e.context.window)) change.window = e.context.window
    const context = freshContext(e.context)
    if (context) {
      change.percent = context.percent
      change.tokens = context.tokens
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
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    // Safety net: a terminal drawing the row means the plugin is wanted, whatever session.start saw;
    // and if /clear did not deliver a SessionStart event, restart polling on first render.
    if (!isTerminal || !timers.length) {
      isTerminal = true
      start($)
    }

    const state = await read($, line)
    const { isStale, tokens, window } = state
    const percent = display.context !== 'off' && isPercent(state.percent) ? state.percent : null
    const model = display.model ? modelLabel(state) : ''
    const texts: Texts = {
      model,
      effort: model && display.effort ? state.effort : '',
      'git-branch': display.branch ? state.branch : '',
      'ctx-label': percent !== null && display.contextLabel ? 'context' : '',
      'ctx-bar': percent !== null && display.context !== 'percent' ? 'bar' : '',
      'ctx-percent': percent !== null && display.context !== 'bar' ? `${Math.round(percent)}%` : '',
      'ctx-tokens': percent !== null && display.contextTokens && tokens !== null && window !== null && window > 0
        ? `${formatTokens(tokens)}/${formatTokens(window)}`
        : '',
      cost: display.cost && isPercent(state.cost) ? `$${state.cost.toFixed(2)}` : '',
    }
    const columns = isPercent(e.props.bodyColumns) ? e.props.bodyColumns : Infinity
    const { shown, branch } = fitRow(texts, columns, display.dropOrder, display.separator)
    if (!shown.size) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const parts: unknown[] = []
    const add = (key: string, part: unknown) => {
      if (parts.length) parts.push(<Text key={`sep-${key}`} dimColor>{` ${display.separator} `}</Text>)
      parts.push(part)
    }

    if (shown.has('model')) {
      add('model', <Text key="model" color={COLORS.model}>{texts.model}</Text>)
      if (shown.has('effort')) parts.push(<Text key="effort" dimColor>{` (${texts.effort})`}</Text>)
    }
    if (shown.has('git-branch')) add('branch', <Text key="branch" color={COLORS.branch}>{branch}</Text>)
    if (percent !== null && (shown.has('ctx-bar') || shown.has('ctx-percent'))) {
      // A stale figure is dimmed rather than colored: its severity is not known any more.
      const color = isStale ? undefined : contextColor(percent)
      const bar = contextBar(percent)
      const showBar = shown.has('ctx-bar')
      add('context', (
        <Text key="context">
          {shown.has('ctx-label') ? <Text dimColor>{`${texts['ctx-label']} `}</Text> : null}
          {showBar ? <Text color={color} dimColor={isStale}>{bar.filled}</Text> : null}
          {showBar ? <Text dimColor>{bar.empty}</Text> : null}
          {shown.has('ctx-percent') ? <Text color={color} dimColor={isStale}>{`${showBar ? ' ' : ''}${texts['ctx-percent']}`}</Text> : null}
          {shown.has('ctx-tokens')
            ? (
              <Text>
                <Text dimColor>{' ('}</Text>
                <Text color={color} dimColor={isStale}>{formatTokens(tokens!)}</Text>
                <Text dimColor>{`/${formatTokens(window!)})`}</Text>
              </Text>
            )
            : null}
        </Text>
      ))
    }
    if (shown.has('cost')) add('cost', <Text key="cost" color={COLORS.cost}>{texts.cost}</Text>)

    return <Box>{parts as any}</Box>
  })
}
