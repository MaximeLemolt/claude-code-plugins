import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// What the engine answers beneath the plugin. `context` is the last response's figure,
// `estimate` the host's own local estimate (`usage({ breakdown: 'summary' })`).
type World = {
  surfaces: string[]
  context: { percent: number; tokens: number }
  estimate: { percentage: number; totalTokens: number }
  // How many times the plugin read the usage or ran git.
  reads?: number
  // The directory session.cwd() answers, and the branch git finds checked out in each one.
  cwd?: string
  branches?: Record<string, string>
  // Makes the settings slow to read, as in a real session: waits on the mocked clock.
  slowConfig?: { sleep: (ms: number) => Promise<void> }
}

function engine(on: On, world: World): void {
  world.reads = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: world.surfaces as any }))
  on('session.cwd', () => ({ value: world.cwd ?? '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  // A partial usage: only the fields the plugin reads.
  on('session.usage', (_, e) => (world.reads!++, {
    value: {
      context: {
        ...world.context,
        window: 1_000_000,
        ...(e.breakdown ? { breakdown: world.estimate } : {}),
      },
      cost: { usd: 1.23 },
    } as any,
  }))
  on('config.list', async () => {
    await world.slowConfig?.sleep(100)
    return { value: [] }
  })
  on('settings.read', () => ({ value: {} }))
  on('process.run', (_, e) => {
    world.reads!++
    // `git -C <dir> ...`: each worktree has its own checked-out branch.
    const dir = e.argv[2] ?? ''
    const stdout = `${world.branches?.[dir] ?? 'main'}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.CwdChanged', () => ({}))
}

const BAND = {
  plugin: 'session-overview',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the terminal shows the row', async ($, on) => {
  mock.clock(on)
  engine(on, {
    surfaces: ['terminal'],
    context: { percent: 12, tokens: 120_000 },
    estimate: { percentage: 12, totalTokens: 120_000 },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text).toContain('Opus 5.5')
  expect(await ui.find({ type: 'Text', text: /12%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^context $/ })).toBeDefined()

  // Each part is painted with a /theme key, so it follows the person's theme.
  const color = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props.color
  expect(await color(/^█+$/)).toBe('success')
  expect(await color(/^ ?12%$/)).toBe('success')
  expect(await color(/^Opus 5\.5$/)).toBe('suggestion')
  expect(await color(/^main$/)).toBe('merged')
  expect(await color(/^\$1\.23$/)).toBe('warning')
  await ui.unmount()
})

test('a row drawn before the session starts still shows the model and branch at once', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, {
    surfaces: ['terminal'],
    context: { percent: 2, tokens: 24_000 },
    estimate: { percentage: 2, totalTokens: 24_000 },
    slowConfig: clock,
  })
  // The terminal draws the band while the first read is still under way, then session.start
  // asks for another: the model and branch must not wait for the 30 s poll.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)

  expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
  await ui.unmount()
})

test('the desktop app gets no row, and the plugin stays idle', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = {
    surfaces: ['desktop'],
    context: { percent: 12, tokens: 120_000 },
    estimate: { percentage: 12, totalTokens: 120_000 },
  }
  engine(on, world)
  // What the engine draws when no plugin draws the band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  // No timer reads git or the usage, even after the polls would have run.
  await clock.advance(60_000)
  expect(world.reads).toBe(0)
  await ui.unmount()
})

test('after /compact the row shows the compacted context without a new turn', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = {
    surfaces: ['terminal'],
    context: { percent: 40, tokens: 400_000 },
    estimate: { percentage: 40, totalTokens: 400_000 },
  }
  engine(on, world)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /40%/ })).toBeDefined()

  // The host keeps the last response's figure, and its estimate only moves about a second later.
  await $.command.run({ command: 'compact', args: '' } as any)
  world.estimate = { percentage: 8, totalTokens: 80_000 }
  await clock.advance(1_000)

  expect(await ui.find({ type: 'Text', text: /8%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /40%/ })).toBeUndefined()
  await ui.unmount()
})

test('/config stores a typed hide order in a clean form, or refuses it', async ($, on) => {
  const stored: unknown[] = []
  // The engine beneath writes the row and answers what it stored.
  on('config.set', (_, e) => {
    stored.push(e.value)
    return { value: e.value }
  })

  const key = 'session-overview.dropOrder'
  expect(await $.config.set({ key, value: 'CTX-TOKENS ,cost   git-branch,git-branch' } as any)).toEqual({ value: 'ctx-tokens, cost, git-branch' })
  const refused = await $.config.set({ key, value: 'ctx-tokens, foo' } as any)
  expect(refused.deny).toBe('Unknown part: foo. Use model, effort, git-branch, ctx-label, ctx-bar, ctx-percent, ctx-tokens, cost, or none.')
  expect(stored).toEqual(['ctx-tokens, cost, git-branch'])
})

test('the context label follows its setting', { options: { showContextLabel: false } }, async ($, on) => {
  mock.clock(on)
  engine(on, {
    surfaces: ['terminal'],
    context: { percent: 12, tokens: 120_000 },
    estimate: { percentage: 12, totalTokens: 120_000 },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /12%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^context $/ })).toBeUndefined()
  await ui.unmount()
})

// The main working tree is on develop; the session works in a linked worktree, and a subagent in another.
const WORKTREES: World = {
  surfaces: ['terminal'],
  context: { percent: 12, tokens: 120_000 },
  estimate: { percentage: 12, totalTokens: 120_000 },
  cwd: '/orca/workspaces/repo/MER-485',
  branches: {
    '/src/repo': 'develop',
    '/orca/workspaces/repo/MER-485': 'MER-587-logs',
    '/src/repo/.claude/worktrees/agent-1': 'worktree-agent-1',
  },
}

test('in a linked worktree the row shows the branch checked out there', async ($, on) => {
  mock.clock(on)
  engine(on, { ...WORKTREES })
  await $.session.start({ cwd: '/orca/workspaces/repo/MER-485', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /^MER-587-logs$/ }))?.props.color).toBe('merged')
  expect(await ui.find({ type: 'Text', text: /develop/ })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's shell command leaves the session's branch on the row", async ($, on) => {
  const clock = mock.clock(on)
  const world: World = { ...WORKTREES }
  engine(on, world)
  await $.session.start({ cwd: '/orca/workspaces/repo/MER-485', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^MER-587-logs$/ })).toBeDefined()

  // In a subagent's hook, session.cwd() answers the subagent's own directory: its worktree.
  world.cwd = '/src/repo/.claude/worktrees/agent-1'
  const bash = { tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: {}, tool_use_id: 't1' }
  await $.classic.PostToolUse({ ...bash, agent_id: 'agent-1', agent_type: 'general-purpose' } as any)
  await $.classic.CwdChanged({ old_cwd: '/src/repo', new_cwd: world.cwd, agent_id: 'agent-1' } as any)
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /^MER-587-logs$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent-1/ })).toBeUndefined()

  // The session's own shell command still refreshes the branch.
  world.cwd = '/orca/workspaces/repo/MER-485'
  world.branches!['/orca/workspaces/repo/MER-485'] = 'MER-600-next'
  await $.classic.PostToolUse(bash as any)
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /^MER-600-next$/ })).toBeDefined()
  await ui.unmount()
})
