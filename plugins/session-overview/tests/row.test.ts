import { expect, test } from 'claude-code/testing'
import type { Line } from '../types'
import {
  COLORS, DEFAULT_DROP_ORDER, contextBar, contextColor, fitRow, formatTokens, modelLabel,
  normalizeDropOrder, readDisplay, readSeparator, readDropOrder, rowWidth, savedEffortFor,
} from '../hooks/row'
import type { Part, Texts } from '../hooks/row'

// A full row: "Opus 5.5 (high) | feature/long-branch-name | context ████░░░░░░ 42% (84k/200k) | $1.23",
// 86 cells: 15 + 24 + 33 + 5 for the parts, 3 for each of the three separators.
const TEXTS: Texts = {
  model: 'Opus 5.5',
  effort: 'high',
  'git-branch': 'feature/long-branch-name',
  'ctx-label': 'context',
  'ctx-bar': 'bar',
  'ctx-percent': '42%',
  'ctx-tokens': '84k/200k',
  cost: '$1.23',
}
const ALL = new Set<Part>(['model', 'effort', 'git-branch', 'ctx-label', 'ctx-bar', 'ctx-percent', 'ctx-tokens', 'cost'])

const sorted = (parts: Set<Part>) => [...parts].sort()

test('the row width counts every part and separator', async () => {
  expect(rowWidth(TEXTS, ALL)).toBe(86)
  expect(rowWidth(TEXTS, new Set<Part>(['model', 'ctx-label', 'ctx-percent']))).toBe('Opus 5.5 | context 42%'.length)
  // Effort and tokens only count beside the model and the context.
  expect(rowWidth(TEXTS, new Set<Part>(['effort', 'ctx-tokens', 'cost']))).toBe(5)
})

test('the separator sets the room between the parts', async () => {
  // Three separators: "•" takes as much room as "|", "<->" two more cells each.
  expect(rowWidth(TEXTS, ALL, '•')).toBe(86)
  expect(rowWidth(TEXTS, ALL, '<->')).toBe(86 + 6)
  // The longer separator makes the row too wide for 86 columns: the tokens go first.
  expect(fitRow(TEXTS, 86, DEFAULT_DROP_ORDER, '<->').shown.has('ctx-tokens')).toBe(false)
  expect(fitRow(TEXTS, 92, DEFAULT_DROP_ORDER, '<->').shown.has('ctx-tokens')).toBe(true)
  expect(readSeparator('  ')).toBe('|')
  expect(readSeparator(undefined)).toBe('|')
  expect(readSeparator(' / ')).toBe('/')
})

test('a row that fits keeps every part', async () => {
  const { shown, branch } = fitRow(TEXTS, 86, DEFAULT_DROP_ORDER)
  expect(sorted(shown)).toEqual(sorted(ALL))
  expect(branch).toBe(TEXTS['git-branch'])
})

test('parts are hidden in the default order until the row fits', async () => {
  expect(sorted(fitRow(TEXTS, 80, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'git-branch', 'ctx-label', 'ctx-bar', 'ctx-percent', 'cost'])))
  expect(sorted(fitRow(TEXTS, 70, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'git-branch', 'ctx-label', 'ctx-bar', 'ctx-percent'])))
  expect(sorted(fitRow(TEXTS, 60, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'ctx-label', 'ctx-bar', 'ctx-percent'])))
  expect(sorted(fitRow(TEXTS, 30, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'ctx-label', 'ctx-percent'])))
})

test('the context label can be hidden on its own', async () => {
  // "context " is 8 cells: without it the full row is 78 wide.
  const { shown } = fitRow(TEXTS, 80, ['ctx-label', 'ctx-tokens'])
  expect(shown.has('ctx-label')).toBe(false)
  expect(shown.has('ctx-tokens')).toBe(true)
  expect(rowWidth(TEXTS, shown)).toBe(78)
})

test('a part left out of the hide order is never hidden', async () => {
  // The default order leaves out the model and the percentage.
  expect(sorted(fitRow(TEXTS, 5, DEFAULT_DROP_ORDER).shown)).toEqual(['ctx-label', 'ctx-percent', 'model'])
})

test('every part can be hidden, the model and the percentage too', async () => {
  // The model gone, the row is "feature/long-branch-name | context ████░░░░░░ 42% (84k/200k) | $1.23".
  const { shown } = fitRow(TEXTS, 70, ['model', 'cost'])
  expect(shown.has('model')).toBe(false)
  expect(shown.has('cost')).toBe(true)
  expect(sorted(fitRow(TEXTS, 3, ['model', 'effort', 'git-branch', 'ctx-label', 'ctx-bar', 'ctx-percent', 'ctx-tokens', 'cost']).shown)).toEqual([])
  // The effort, the label and the tokens go with the model and the context they sit beside.
  expect(sorted(fitRow(TEXTS, 5, ['model', 'git-branch', 'ctx-bar', 'ctx-percent']).shown)).toEqual(['cost'])
})

test('a branch still too long is shortened with an ellipsis', async () => {
  // Tokens and cost gone, the row is 67 wide: 7 cells too many for 60.
  const { shown, branch } = fitRow(TEXTS, 60, ['ctx-tokens', 'cost'])
  expect(branch).toBe('feature/long-bra…')
  expect(rowWidth({ ...TEXTS, 'git-branch': branch }, shown)).toBe(60)
})

test('a branch with no character left is removed', async () => {
  const { shown } = fitRow({ ...TEXTS, 'git-branch': 'ab' }, 10, ['ctx-tokens', 'cost'])
  expect(shown.has('git-branch')).toBe(false)
})

test('none hides no part, the branch is still shortened', async () => {
  const { shown, branch } = fitRow(TEXTS, 80, readDropOrder('none'))
  expect(sorted(shown)).toEqual(sorted(ALL))
  expect(branch.endsWith('…')).toBe(true)
  expect(rowWidth({ ...TEXTS, 'git-branch': branch }, shown)).toBe(80)
})

test('a part with nothing to show takes no room', async () => {
  const { shown } = fitRow({ ...TEXTS, cost: '', 'ctx-tokens': '' }, 200, DEFAULT_DROP_ORDER)
  expect(shown.has('cost')).toBe(false)
  expect(shown.has('ctx-tokens')).toBe(false)
})

test('the hide order reads any order of the parts', async () => {
  expect(readDropOrder('ctx-tokens, cost, git-branch, ctx-bar, effort')).toEqual(['ctx-tokens', 'cost', 'git-branch', 'ctx-bar', 'effort'])
  expect(readDropOrder('cost, effort')).toEqual(['cost', 'effort'])
  expect(readDropOrder('model, ctx-percent, cost')).toEqual(['model', 'ctx-percent', 'cost'])
  expect(readDropOrder('git-branch')).toEqual(['git-branch'])
  expect(readDropOrder('none')).toEqual([])
})

test('a hide order with the names of an older version still reads', async () => {
  expect(readDropOrder('tokens, cost, branch, bar, effort')).toEqual(['ctx-tokens', 'cost', 'git-branch', 'ctx-bar', 'effort'])
  expect(readDropOrder('percent')).toEqual(['ctx-percent'])
  expect(readDropOrder('ctx_bar, ctx_tokens')).toEqual(['ctx-bar', 'ctx-tokens'])
})

test('a hide order edited by hand is read leniently', async () => {
  expect(readDropOrder(undefined)).toEqual(DEFAULT_DROP_ORDER)
  expect(readDropOrder('foo, ctx-bar baz')).toEqual(['ctx-bar'])
  expect(readDropOrder('foo')).toEqual(DEFAULT_DROP_ORDER)
  // Unknown and repeated parts are dropped, case does not matter.
  expect(readDropOrder('CTX-TOKENS cost ctx-tokens foo')).toEqual(['ctx-tokens', 'cost'])
})

test('a typed hide order is stored in a clean form', async () => {
  expect(normalizeDropOrder('CTX-TOKENS ,cost   git-branch,git-branch')).toEqual({ value: 'ctx-tokens, cost, git-branch' })
  expect(normalizeDropOrder(' Effort ')).toEqual({ value: 'effort' })
  expect(normalizeDropOrder('Model ctx-percent')).toEqual({ value: 'model, ctx-percent' })
  // An old name is stored under its new one.
  expect(normalizeDropOrder('tokens bar')).toEqual({ value: 'ctx-tokens, ctx-bar' })
  expect(normalizeDropOrder('NONE')).toEqual({ value: 'none' })
  // Empty restores the default.
  expect(normalizeDropOrder('  , ')).toEqual({ value: 'ctx-tokens, cost, git-branch, ctx-bar, effort' })
})

test('a typed hide order with a wrong part is refused, saying why', async () => {
  expect(normalizeDropOrder('ctx-tokens, foo, baz')).toEqual({
    error: 'Unknown parts: foo, baz. Use model, effort, git-branch, ctx-label, ctx-bar, ctx-percent, ctx-tokens, cost, or none.',
  })
  expect(normalizeDropOrder('none, cost')).toEqual({ error: 'none cannot be combined with parts.' })
})

test('the display settings default to showing everything', async () => {
  expect(readDisplay({})).toEqual({
    model: true, effort: true, branch: true, context: 'both', contextLabel: true, tokens: 'on', cost: true,
    separator: '|', dropOrder: DEFAULT_DROP_ORDER,
  })
})

test('the display settings follow /config', async () => {
  expect(readDisplay({
    showModel: false, showEffort: false, showBranch: false, context: 'bar', showContextLabel: false, tokens: 'off',
    showCost: false, separator: ' • ', dropOrder: 'none',
  })).toEqual({
    model: false, effort: false, branch: false, context: 'bar', contextLabel: false, tokens: 'off', cost: false,
    separator: '•', dropOrder: [],
  })
  // A value outside the picker keeps the default.
  expect(readDisplay({ context: 'wide', tokens: 'auto' })).toMatchObject({ context: 'both', tokens: 'on' })
})

test('tokens are shortened to sit beside the bar', async () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1_000)).toBe('1k')
  expect(formatTokens(64_000)).toBe('64k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

test('the context color changes at 45, 60 and 80%', async () => {
  expect(contextColor(44.9)).toBe(COLORS.roomy)
  expect(contextColor(45)).toBe(COLORS.filling)
  expect(contextColor(60)).toBe(COLORS.handoff)
  expect(contextColor(80)).toBe(COLORS.critical)
})

test('the context bar has ten cells, clamped to 0 and 100%', async () => {
  expect(contextBar(42)).toEqual({ filled: '████', empty: '░░░░░░' })
  expect(contextBar(-5)).toEqual({ filled: '', empty: '░'.repeat(10) })
  expect(contextBar(150)).toEqual({ filled: '█'.repeat(10), empty: '' })
})

const LINE: Line = {
  model: '', configModel: '', effort: '', branch: '', percent: null, isStale: false, tokens: null, window: null, cost: null,
}

test('the model label follows the selection', async () => {
  expect(modelLabel({ ...LINE, model: 'claude-opus-5-5' })).toBe('Opus 5.5')
  // An alias of the same family keeps the resolved version; another family wins at once.
  expect(modelLabel({ ...LINE, model: 'claude-opus-5-5', configModel: 'opus' })).toBe('Opus 5.5')
  expect(modelLabel({ ...LINE, model: 'claude-opus-5-5', configModel: 'sonnet' })).toBe('Sonnet')
})

test('the saved effort of a model beats the global one', async () => {
  const settings = { 'claude-opus-5-5': { effortLevel: 'max' } }
  expect(savedEffortFor(settings, 'claude-opus-5-5[1m]', 'high')).toBe('max')
  expect(savedEffortFor(settings, 'claude-sonnet-5-5', 'high')).toBe('high')
  expect(savedEffortFor(undefined, 'claude-opus-5-5', undefined)).toBe('')
})
