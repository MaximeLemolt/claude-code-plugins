import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'
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
  tokens: null,
  window: null,
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

// 64000 -> "64k", 1000000 -> "1M": short enough to sit beside the bar.
function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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

// Right after /compact the host still reports the pre-compaction figures: look again a few times
// until the estimate moves, instead of waiting for the next turn.
async function refreshAfterCompact($: EngineInterface, isCurrent: () => boolean, previous: number | null): Promise<void> {
  for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
    await $.process.run(['sleep', String(delay / 1_000)], { timeoutMs: delay + 2_000 } as any).catch(() => undefined)
    if (!isCurrent()) return
    const context = await estimateContext($)
    if (!isCurrent()) return
    if (context && context.tokens !== previous) {
      await patch($, { ...context, isStale: false })
      return
    }
  }
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
  if (!isTerminal) return
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
  if (!isTerminal) return
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

// What the person chose to show (plugin.json userConfig); a change reloads the module.
type Display = {
  model: boolean
  effort: boolean
  branch: boolean
  context: 'both' | 'bar' | 'percent' | 'off'
  tokens: 'on' | 'off'
  cost: boolean
  // Parts removed one by one, in this order, while the row is wider than the terminal.
  dropOrder: readonly Part[]
}

type Part = 'model' | 'effort' | 'branch' | 'bar' | 'percent' | 'tokens' | 'cost'
const PARTS: readonly Part[] = ['model', 'effort', 'branch', 'bar', 'percent', 'tokens', 'cost']
const DEFAULT_DROP_ORDER: readonly Part[] = ['tokens', 'cost', 'branch', 'bar', 'effort']

function readDropOrder(value: unknown): readonly Part[] {
  if (typeof value !== 'string') return DEFAULT_DROP_ORDER
  if (value === 'none') return []
  const parts = value.split(/[\s,]+/).map(part => part.toLowerCase())
    .filter((part, index, all): part is Part => PARTS.includes(part as Part) && all.indexOf(part) === index)
  return parts.length ? parts : DEFAULT_DROP_ORDER
}

// The text of each part the settings and the state allow, '' for a part with nothing to show.
type Texts = Record<Part, string>

// Width of the row in cells, as the render below lays it out (every character is one cell wide).
function rowWidth(texts: Texts, shown: ReadonlySet<Part>): number {
  const has = (part: Part) => shown.has(part) && texts[part] !== ''
  const segments: number[] = []
  if (has('model')) segments.push(texts.model.length + (has('effort') ? ` (${texts.effort})`.length : 0))
  if (has('branch')) segments.push(texts.branch.length)
  if (has('bar') || has('percent')) {
    segments.push('context '.length +
      (has('bar') ? BAR_WIDTH : 0) +
      (has('percent') ? (has('bar') ? 1 : 0) + texts.percent.length : 0) +
      (has('tokens') ? ` (${texts.tokens})`.length : 0))
  }
  if (has('cost')) segments.push(texts.cost.length)
  return segments.reduce((sum, width) => sum + width, 0) + ' | '.length * Math.max(0, segments.length - 1)
}

// Drops parts in the chosen order until the row fits, then shortens the branch if it still does not.
function fitRow(texts: Texts, columns: number, dropOrder: readonly Part[]): { shown: Set<Part>; branch: string } {
  const shown = new Set(PARTS.filter(part => texts[part] !== ''))
  for (const part of dropOrder) {
    if (rowWidth(texts, shown) <= columns) break
    shown.delete(part)
  }
  let branch = texts.branch
  const overflow = rowWidth(texts, shown) - columns
  if (overflow > 0 && shown.has('branch')) {
    const keep = branch.length - overflow - 1
    if (keep >= 1) branch = `${branch.slice(0, keep)}…`
    else shown.delete('branch')
  }
  return { shown, branch }
}

let display: Display = readDisplay({})

function readDisplay(options: PluginOptions): Display {
  const flag = (key: string) => options[key] !== false
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T =>
    allowed.includes(options[key] as T) ? options[key] as T : fallback
  return {
    model: flag('showModel'),
    effort: flag('showEffort'),
    branch: flag('showBranch'),
    context: pick('context', ['both', 'bar', 'percent', 'off'] as const, 'both'),
    tokens: pick('tokens', ['on', 'off'] as const, 'on'),
    cost: flag('showCost'),
    dropOrder: readDropOrder(options.dropOrder),
  }
}

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
  // /compact until the next turn. Right after compaction, use the local estimate instead.
  on('classic.PostCompact', async ($, e, next) => {
    if (!isTerminal) return next(e)
    // The last figure predates the compaction: show it as stale until a fresh one replaces it.
    await patch($, { isStale: true })
    const before = await $.session.usage().catch(() => undefined)
    figureBeforeCompact = before ? contextKey(before.context) : null
    const context = await estimateContext($)
    if (context) await patch($, { ...context, isStale: false })
    const currentGeneration = generation
    void refreshAfterCompact($, () => currentGeneration === generation, context?.tokens ?? null)
    return next(e)
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
      branch: display.branch ? state.branch : '',
      bar: percent !== null && display.context !== 'percent' ? 'bar' : '',
      percent: percent !== null && display.context !== 'bar' ? `${Math.round(percent)}%` : '',
      tokens: percent !== null && display.tokens === 'on' && tokens !== null && window !== null && window > 0
        ? `${formatTokens(tokens)}/${formatTokens(window)}`
        : '',
      cost: display.cost && isPercent(state.cost) ? `$${state.cost.toFixed(2)}` : '',
    }
    const columns = isPercent(e.props.bodyColumns) ? e.props.bodyColumns : Infinity
    const { shown, branch } = fitRow(texts, columns, display.dropOrder)
    if (!shown.size) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const parts: unknown[] = []
    const add = (key: string, part: unknown) => {
      if (parts.length) parts.push(<Text key={`sep-${key}`} dimColor>{' | '}</Text>)
      parts.push(part)
    }

    if (shown.has('model')) {
      add('model', <Text key="model" color={COLORS.cyan}>{texts.model}</Text>)
      if (shown.has('effort')) parts.push(<Text key="effort" dimColor>{` (${texts.effort})`}</Text>)
    }
    if (shown.has('branch')) add('branch', <Text key="branch" color={COLORS.magenta}>{branch}</Text>)
    if (percent !== null && (shown.has('bar') || shown.has('percent'))) {
      // A stale figure is dimmed rather than colored: its severity is not known any more.
      const color = isStale ? undefined : contextColor(percent)
      const bar = contextBar(percent)
      const showBar = shown.has('bar')
      add('context', (
        <Text key="context">
          <Text dimColor>{'context '}</Text>
          {showBar ? <Text color={color} dimColor={isStale}>{bar.filled}</Text> : null}
          {showBar ? <Text dimColor>{bar.empty}</Text> : null}
          {shown.has('percent') ? <Text color={color} dimColor={isStale}>{`${showBar ? ' ' : ''}${texts.percent}`}</Text> : null}
          {shown.has('tokens')
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
    if (shown.has('cost')) add('cost', <Text key="cost" color={COLORS.amber}>{texts.cost}</Text>)

    return <Box>{parts as any}</Box>
  })
}
