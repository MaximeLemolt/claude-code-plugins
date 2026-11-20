// Pure functions of the row: no `$`, no state, so the tests can call them directly.
import type { PluginOptions } from 'claude-code'
import type { Line } from '../types'

export const COLORS = {
  green: '#5faf5f',
  orange: '#ff8700',
  yellow: '#d7d75f',
  amber: '#ffaf00',
  red: '#ff5f5f',
  cyan: '#5fafd7',
  magenta: '#af87d7',
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

// Past 60% it is recommended to hand the work off to a fresh agent: yellow warns before that.
export const CONTEXT_THRESHOLDS = { warn: 45, handoff: 60, critical: 80 } as const
export const BAR_WIDTH = 10

export function contextColor(percent: number): string {
  if (percent < CONTEXT_THRESHOLDS.warn) return COLORS.green
  if (percent < CONTEXT_THRESHOLDS.handoff) return COLORS.yellow
  if (percent < CONTEXT_THRESHOLDS.critical) return COLORS.orange
  return COLORS.red
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
  tokens: 'on' | 'off'
  cost: boolean
  // Parts removed one by one, in this order, while the row is wider than the terminal.
  dropOrder: readonly Part[]
}

export type Part = 'model' | 'effort' | 'branch' | 'bar' | 'percent' | 'tokens' | 'cost'
export const PARTS: readonly Part[] = ['model', 'effort', 'branch', 'bar', 'percent', 'tokens', 'cost']
export const DEFAULT_DROP_ORDER: readonly Part[] = ['tokens', 'cost', 'branch', 'bar', 'effort']

export function readDropOrder(value: unknown): readonly Part[] {
  if (typeof value !== 'string') return DEFAULT_DROP_ORDER
  if (value === 'none') return []
  const parts = value.split(/[\s,]+/).map(part => part.toLowerCase())
    .filter((part, index, all): part is Part => PARTS.includes(part as Part) && all.indexOf(part) === index)
  return parts.length ? parts : DEFAULT_DROP_ORDER
}

// The text of each part the settings and the state allow, '' for a part with nothing to show.
export type Texts = Record<Part, string>

// Width of the row in cells, as the render below lays it out (every character is one cell wide).
export function rowWidth(texts: Texts, shown: ReadonlySet<Part>): number {
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
export function fitRow(texts: Texts, columns: number, dropOrder: readonly Part[]): { shown: Set<Part>; branch: string } {
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

export function readDisplay(options: PluginOptions): Display {
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
