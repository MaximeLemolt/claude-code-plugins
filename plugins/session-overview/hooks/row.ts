// Pure functions of the row: no `$`, no state, so the tests can call them directly.
import type { PluginOptions } from 'claude-code'
import type { Line } from '../types'

// Theme keys, not raw colors: the terminal paints each from the theme picked with /theme
// (dark, light, colorblind-friendly, ANSI, or following the system).
export const COLORS = {
  model: 'suggestion',
  branch: 'merged',
  cost: 'warning',
  // The context, by how full it is.
  roomy: 'success',
  filling: 'warning',
  handoff: 'claude',
  critical: 'error',
} as const

const FAMILY = /(opus|sonnet|haiku|fable)/i

export function prettyModel(id: string): string {
  const match = /(?:^|[-\s])(opus|sonnet|haiku|fable)(?:[-\s]+(\d+)(?:[-.](\d{1,2}))?)?(?=$|[-\s])/i.exec(id)
  if (!match) return id

  const family = match[1]!
  const name = family[0]!.toUpperCase() + family.slice(1).toLowerCase()
  return match[2] ? `${name} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : name
}

export function modelLabel({ model, configModel }: Line): string {
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

// Past 60% it is recommended to hand the work off to a fresh agent: the warning color comes before that.
export const CONTEXT_THRESHOLDS = { warn: 45, handoff: 60, critical: 80 } as const
export const BAR_WIDTH = 10

export function contextColor(percent: number): string {
  if (percent < CONTEXT_THRESHOLDS.warn) return COLORS.roomy
  if (percent < CONTEXT_THRESHOLDS.handoff) return COLORS.filling
  if (percent < CONTEXT_THRESHOLDS.critical) return COLORS.handoff
  return COLORS.critical
}

export function contextBar(percent: number): { filled: string; empty: string } {
  const cells = Math.round(Math.min(100, Math.max(0, percent)) / 100 * BAR_WIDTH)
  return { filled: '█'.repeat(cells), empty: '░'.repeat(BAR_WIDTH - cells) }
}

// 64000 -> "64k", 1000000 -> "1M": short enough to sit beside the bar.
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// The effort a model is saved with: its own `modelSettings` entry (what /effort and the app's
// selector write) beats the global `effortLevel`. Prefix match covers ids like `claude-sonnet-5-5[1m]`.
export function savedEffortFor(modelSettings: unknown, model: string, globalEffort: unknown): string {
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

// What the person chose to show (plugin.json userConfig); a change reloads the module.
export type Display = {
  model: boolean
  effort: boolean
  branch: boolean
  context: 'both' | 'bar' | 'percent' | 'off'
  contextLabel: boolean
  contextTokens: boolean
  cost: boolean
  // Drawn between the parts, with a space on each side.
  separator: string
  // Parts removed one by one, in this order, while the row is wider than the terminal.
  dropOrder: readonly Part[]
}

export type Part = 'model' | 'effort' | 'git-branch' | 'ctx-label' | 'ctx-bar' | 'ctx-percent' | 'ctx-tokens' | 'cost'
export const PARTS: readonly Part[] = ['model', 'effort', 'git-branch', 'ctx-label', 'ctx-bar', 'ctx-percent', 'ctx-tokens', 'cost']
export const DEFAULT_DROP_ORDER: readonly Part[] = ['ctx-tokens', 'cost', 'git-branch', 'ctx-bar', 'effort']

// Names an older version stored, still read and saved under their new name.
const RENAMED: Readonly<Record<string, Part>> = {
  'bar': 'ctx-bar', 'percent': 'ctx-percent', 'tokens': 'ctx-tokens', 'branch': 'git-branch',
  'ctx_bar': 'ctx-bar', 'ctx_percent': 'ctx-percent', 'ctx_tokens': 'ctx-tokens',
}

function words(value: string): string[] {
  return value.split(/[\s,]+/).map(word => word.toLowerCase()).filter(Boolean)
    .map(word => RENAMED[word] ?? word)
}

// What the stored setting means. A value edited by hand is read leniently: unknown words are
// skipped, and nothing valid left means the default.
export function readDropOrder(value: unknown): readonly Part[] {
  if (typeof value !== 'string') return DEFAULT_DROP_ORDER
  const listed = words(value)
  if (listed.length === 1 && listed[0] === 'none') return []
  const parts = listed
    .filter((part, index, all): part is Part => PARTS.includes(part as Part) && all.indexOf(part) === index)
  return parts.length ? parts : DEFAULT_DROP_ORDER
}

// What /config stores for a typed hide order: the parts in a clean form, `ctx-tokens, cost, git-branch`,
// or why it is refused. Separators and case do not matter, repeats are dropped, empty is the default.
export function normalizeDropOrder(value: string): { value: string } | { error: string } {
  const listed = words(value)
  if (!listed.length) return { value: DEFAULT_DROP_ORDER.join(', ') }
  if (listed.includes('none')) {
    return listed.length === 1 ? { value: 'none' } : { error: 'none cannot be combined with parts.' }
  }
  const unknown = [...new Set(listed.filter(word => !PARTS.includes(word as Part)))]
  if (unknown.length) {
    return { error: `Unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use ${PARTS.join(', ')}, or none.` }
  }
  return { value: [...new Set(listed)].join(', ') }
}

// The text of each part the settings and the state allow, '' for a part with nothing to show.
export type Texts = Record<Part, string>

// Width of the row in cells, as the render below lays it out (every character is one cell wide).
export function rowWidth(texts: Texts, shown: ReadonlySet<Part>, separator = DEFAULT_SEPARATOR): number {
  const has = (part: Part) => shown.has(part) && texts[part] !== ''
  const segments: number[] = []
  if (has('model')) segments.push(texts.model.length + (has('effort') ? ` (${texts.effort})`.length : 0))
  if (has('git-branch')) segments.push(texts['git-branch'].length)
  if (has('ctx-bar') || has('ctx-percent')) {
    segments.push((has('ctx-label') ? `${texts['ctx-label']} `.length : 0) +
      (has('ctx-bar') ? BAR_WIDTH : 0) +
      (has('ctx-percent') ? (has('ctx-bar') ? 1 : 0) + texts['ctx-percent'].length : 0) +
      (has('ctx-tokens') ? ` (${texts['ctx-tokens']})`.length : 0))
  }
  if (has('cost')) segments.push(texts.cost.length)
  return segments.reduce((sum, width) => sum + width, 0) + ` ${separator} `.length * Math.max(0, segments.length - 1)
}

// Drops parts in the chosen order until the row fits, then shortens the branch if it still does not.
export function fitRow(
  texts: Texts, columns: number, dropOrder: readonly Part[], separator = DEFAULT_SEPARATOR,
): { shown: Set<Part>; branch: string } {
  const shown = new Set(PARTS.filter(part => texts[part] !== ''))
  for (const part of dropOrder) {
    if (rowWidth(texts, shown, separator) <= columns) break
    shown.delete(part)
  }
  // The effort sits beside the model, the label and the tokens beside the context: they go with
  // them, so a row with every part hidden is empty and not drawn at all.
  if (!shown.has('model')) shown.delete('effort')
  if (!shown.has('ctx-bar') && !shown.has('ctx-percent')) {
    shown.delete('ctx-label')
    shown.delete('ctx-tokens')
  }
  let branch = texts['git-branch']
  const overflow = rowWidth(texts, shown, separator) - columns
  if (overflow > 0 && shown.has('git-branch')) {
    const keep = branch.length - overflow - 1
    if (keep >= 1) branch = `${branch.slice(0, keep)}…`
    else shown.delete('git-branch')
  }
  return { shown, branch }
}

export const DEFAULT_SEPARATOR = '|'

// The separator as typed, without the spaces around it; nothing typed means the default.
export function readSeparator(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SEPARATOR
}

export function readDisplay(options: PluginOptions): Display {
  const flag = (key: string) => options[key] !== false
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T =>
    allowed.includes(options[key] as T) ? options[key] as T : fallback
  return {
    model: flag('showModel'),
    effort: flag('showEffort'),
    branch: flag('showBranch'),
    context: pick('context', ['both', 'bar', 'percent', 'off'] as const, 'both'),
    contextLabel: flag('showContextLabel'),
    contextTokens: flag('showContextTokens'),
    cost: flag('showCost'),
    separator: readSeparator(options.separator),
    dropOrder: readDropOrder(options.dropOrder),
  }
}
