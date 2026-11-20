import { expect, test } from 'claude-code/testing'
import type { Line } from '../types'
import {
  COLORS, DEFAULT_DROP_ORDER, contextBar, contextColor, fitRow, formatTokens, modelLabel,
  readDisplay, readDropOrder, rowWidth, savedEffortFor,
} from '../hooks/row'
import type { Part, Texts } from '../hooks/row'

// A full row: "Opus 5.5 (high) | feature/long-branch-name | context ████░░░░░░ 42% (84k/200k) | $1.23",
// 86 cells: 15 + 24 + 33 + 5 for the parts, 3 for each of the three separators.
const TEXTS: Texts = {
  model: 'Opus 5.5',
  effort: 'high',
  branch: 'feature/long-branch-name',
  bar: 'bar',
  percent: '42%',
  tokens: '84k/200k',
  cost: '$1.23',
}
const ALL = new Set<Part>(['model', 'effort', 'branch', 'bar', 'percent', 'tokens', 'cost'])

const sorted = (parts: Set<Part>) => [...parts].sort()

test('the row width counts every part and separator', async () => {
  expect(rowWidth(TEXTS, ALL)).toBe(86)
  expect(rowWidth(TEXTS, new Set<Part>(['model', 'percent']))).toBe('Opus 5.5 | context 42%'.length)
  // Effort and tokens only count beside the model and the context.
  expect(rowWidth(TEXTS, new Set<Part>(['effort', 'tokens', 'cost']))).toBe(5)
})

test('a row that fits keeps every part', async () => {
  const { shown, branch } = fitRow(TEXTS, 86, DEFAULT_DROP_ORDER)
  expect(sorted(shown)).toEqual(sorted(ALL))
  expect(branch).toBe(TEXTS.branch)
})

test('parts are hidden in the default order until the row fits', async () => {
  expect(sorted(fitRow(TEXTS, 80, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'branch', 'bar', 'percent', 'cost'])))
  expect(sorted(fitRow(TEXTS, 70, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'branch', 'bar', 'percent'])))
  expect(sorted(fitRow(TEXTS, 60, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'bar', 'percent'])))
  expect(sorted(fitRow(TEXTS, 30, DEFAULT_DROP_ORDER).shown)).toEqual(sorted(new Set<Part>(['model', 'effort', 'percent'])))
})

test('model and percent are never hidden', async () => {
  expect(sorted(fitRow(TEXTS, 5, DEFAULT_DROP_ORDER).shown)).toEqual(['model', 'percent'])
})

test('a branch still too long is shortened with an ellipsis', async () => {
  // Tokens and cost gone, the row is 67 wide: 7 cells too many for 60.
  const { shown, branch } = fitRow(TEXTS, 60, ['tokens', 'cost'])
  expect(branch).toBe('feature/long-bra…')
  expect(rowWidth({ ...TEXTS, branch }, shown)).toBe(60)
})

test('a branch with no character left is removed', async () => {
  const { shown } = fitRow({ ...TEXTS, branch: 'ab' }, 10, ['tokens', 'cost'])
  expect(shown.has('branch')).toBe(false)
})

test('none hides no part, the branch is still shortened', async () => {
  const { shown, branch } = fitRow(TEXTS, 80, readDropOrder('none'))
  expect(sorted(shown)).toEqual(sorted(ALL))
  expect(branch.endsWith('…')).toBe(true)
  expect(rowWidth({ ...TEXTS, branch }, shown)).toBe(80)
})

test('a part with nothing to show takes no room', async () => {
  const { shown } = fitRow({ ...TEXTS, cost: '', tokens: '' }, 200, DEFAULT_DROP_ORDER)
  expect(shown.has('cost')).toBe(false)
  expect(shown.has('tokens')).toBe(false)
})

test('the hide order reads each preset of the picker', async () => {
  expect(readDropOrder('tokens, cost, branch, bar, effort')).toEqual(['tokens', 'cost', 'branch', 'bar', 'effort'])
  expect(readDropOrder('tokens, branch, bar, effort, cost')).toEqual(['tokens', 'branch', 'bar', 'effort', 'cost'])
  expect(readDropOrder('tokens, cost, bar, effort, branch')).toEqual(['tokens', 'cost', 'bar', 'effort', 'branch'])
  expect(readDropOrder('none')).toEqual([])
})

test('a missing or unknown hide order falls back to the default', async () => {
  expect(readDropOrder(undefined)).toEqual(DEFAULT_DROP_ORDER)
  expect(readDropOrder('foo, bar baz')).toEqual(['bar'])
  expect(readDropOrder('foo')).toEqual(DEFAULT_DROP_ORDER)
  // Unknown and repeated parts are dropped, case does not matter.
  expect(readDropOrder('TOKENS cost tokens foo')).toEqual(['tokens', 'cost'])
})

test('the display settings default to showing everything', async () => {
  expect(readDisplay({})).toEqual({
    model: true, effort: true, branch: true, context: 'both', tokens: 'on', cost: true, dropOrder: DEFAULT_DROP_ORDER,
  })
})

test('the display settings follow /config', async () => {
  expect(readDisplay({
    showModel: false, showEffort: false, showBranch: false, context: 'bar', tokens: 'off', showCost: false, dropOrder: 'none',
  })).toEqual({
    model: false, effort: false, branch: false, context: 'bar', tokens: 'off', cost: false, dropOrder: [],
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
