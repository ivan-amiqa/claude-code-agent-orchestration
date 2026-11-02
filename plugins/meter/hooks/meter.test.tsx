import { expect, mock, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { MeterData, MeterGroup, MeterPr } from '../types'

import { addToGroups, agentRowText, barSvg, beforeLoaded, columnColors, dollarsSvg, esc, gaugeSvg, groupAgents, labelRow, labelStart, mergePairs, niceTicks, niceTop, PALETTES, paletteFor, PRICE_RATIO, prUrlsIn, ringSvg, rollup, sane, sanePrs, shares, splitCost, splitParts, stackCells, tokens, truncate } from './register'

const PANE = {
  plugin: 'meter',
  component: 'Pane',
  requestId: 'meter',
  props: {
    title: 'Meter',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const MIN = 60_000
const NOW = 1_000_000_000_000

// A PR row as the live hooks write it once `gh pr view` answered.
const pr = (over: Partial<MeterPr> = {}): MeterPr => ({
  url: 'https://github.com/acme/web-api/pull/7',
  label: 'acme/web-api#7',
  title: 'fix: the Blue onboarding fixes',
  kind: 'open',
  adds: 12,
  dels: 3,
  pass: 2,
  fail: 1,
  pending: 2,
  failing: ['lint'],
  fetch: 'ok',
  misses: 0,
  checkedAt: NOW,
  addedAt: NOW,
  ...over,
})

// A chart column: dollars re-read, new: stored, and its answer, for steps `from`..`to`.
const grp = (from: number, read: number, nw: number, ans: number, to = from): MeterGroup => ({ fromStep: from, toStep: to, readUsd: read, newUsd: nw, answerUsd: ans })

// The pane's stored state: `data` (MeterData) and, in an atom of its own, the tracked PRs.
type Fixture = MeterData & { ci: MeterPr[] }

// A value shaped like what the live hooks write.
const live = (over: Partial<Fixture> = {}): Fixture => ({
  costUsd: 3.4,
  contextTokens: 142_000,
  mainModel: 'Opus',
  nowMs: NOW,
  lastResponseAt: NOW - 19 * MIN,
  cacheTtl: '1h',
  cacheTtlSource: 'engine',
  coldToasted: false,
  crossed: 0,
  costCursor: 3.4,
  spend: { 'opus-main': 1.32, haiku: 0.12, sonnet: 0.92, 'opus-checks': 1.04 },
  written: { 'opus-main': 21_000, haiku: 2_000, sonnet: 48_000, 'opus-checks': 9_000 },
  agents: [
    { id: 'a1', name: 'scout', model: 'Haiku', bucket: 'haiku', read: 38_000, written: 900, usd: 0.06, status: 'done', startedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN, warned: false },
    { id: 'a2', name: 'implementer', model: 'Sonnet', bucket: 'sonnet', read: 1_100_000, written: 48_000, usd: 0.92, status: 'done', startedAt: NOW - 28 * MIN, endedAt: NOW - 25 * MIN, warned: false },
    { id: 'a3', name: 'verifier', model: 'Opus', bucket: 'opus-checks', read: 120_000, written: 9_000, usd: 1.04, status: 'running', startedAt: NOW - MIN, endedAt: null, warned: false },
  ],
  // Re-reading grows every step; /compact after step 7 cuts it (the purple part drops).
  groups: [
    grp(1, 0.0, 0.02, 0.01),
    grp(2, 0.02, 0.03, 0.01),
    grp(3, 0.06, 0.02, 0.02),
    grp(4, 0.1, 0.03, 0.02),
    grp(5, 0.16, 0.02, 0.02),
    grp(6, 0.22, 0.03, 0.03),
    grp(7, 0.3, 0.04, 0.04),
    grp(8, 0.04, 0.12, 0.03),
    grp(9, 0.07, 0.02, 0.02),
    grp(10, 0.1, 0.02, 0.02),
  ],
  groupSize: 1,
  compactAt: 7,
  guardLines: [
    { kind: 'blocked', text: 'Blocked: nested agent' },
    { kind: 'switched', text: 'Explore → switched to Haiku' },
  ],
  ci: [pr()],
  lastVerifierAt: NOW - MIN,
  ...over,
})

// What the engine answers beneath the plugin, for the events a test does not care about.
const quiet = (on: On) => {
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
}

// What `state.get` answers for each of the two atoms: pass the event, so the right one is served.
const stored = (fixture: Fixture, e: { key: string }) => {
  const { ci, ...value } = fixture

  return e.key === 'ci' ? { value: { version: 1, value: { shape: 'ci-1', value: ci } } } : { value: { version: 1, value: { shape: 'meter-6', value } } }
}

test('the pane draws live-shaped data on terminal and desktop', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /\$3\.40/ }))?.text).toBe('$3.40')
    expect((await ui.find({ type: 'Text', text: /142k/ }))?.text).toBe('142k')
    expect(await ui.find({ type: 'Text', text: /warm · 41 min left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /implementer · Sonnet · 1\.1M read · 48k written · ≈\$0\.92/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /350k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\/compact/ })).toBeDefined()
      expect(await ui.find({ type: 'Svg' })).toBeUndefined() // no Svg on the terminal
    } else {
      // the charts are SVG: the marks and /compact are drawn inside them
      expect(await svgSource(ui, /^Context/)).toContain('350k')
      expect(await svgSource(ui, /^Dollars per step/)).toContain('/compact')
    }
    expect(await ui.find({ type: 'Text', text: /Blocked: nested agent/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\/5/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /#7/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an expanded pane draws wider charts: 8 px a cell', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))

  const widthOf = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    const gauge = (await ui.findAll({ type: 'Svg' })).find(x => /^Context/.test(String(x.props.alt)))
    await ui.unmount()

    return gauge?.props.width
  }
  expect(await widthOf(44)).toBe(42 * 8)
  expect(await widthOf(100)).toBe(98 * 8)
})

test('/meter opens the pane and answers with one line of real values', async ($, on) => {
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 142_000, window: 1_000_000, percent: 14 }, rateLimits: [], cost: { usd: 3.4 } },
  }))
  quiet(on)
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('process.run', () => gh('[]'))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 4 --repo a/b' })
  const ran = await $.command.run({
    command: 'meter',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toContain('$3.40')
  expect(ran.text).toContain('142k')
  expect(ran.text).toContain('CI: 1 PR, ')
  expect(ran.text?.includes('\n')).toBe(false)
})

test('a cold cache says what the next call costs', async ($, on) => {
  on('state.get', (_, e) => stored(live({ contextTokens: 142_000, lastResponseAt: NOW - 90 * MIN }), e))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /cold — next call re-writes 142k\. A fresh session is cheaper\./ })).toBeDefined()
  await ui.unmount()
})

test('crossing 350k raises one toast, however many measurements follow', async ($, on) => {
  const toasts: string[] = []
  quiet(on)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const at = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], cost: { usd: 2 }, changed: ['context', 'cost'] })

  await at(100_000)
  await at(360_000)
  await at(370_000)
  await at(380_000)
  expect(toasts.filter(t => t.includes('350k'))).toHaveLength(1)
  expect(toasts.filter(t => t.includes('500k'))).toHaveLength(0)

  await at(510_000)
  await at(520_000)
  expect(toasts.filter(t => t.includes('500k'))).toHaveLength(1)
  expect(toasts.filter(t => t.includes('350k'))).toHaveLength(1)
})

const spawnInput = {
  tool_use_id: 't1',
  prompt: 'look around',
  description: 'look',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

test('a spawn from inside a subagent is denied with the reason', async ($, on) => {
  quiet(on)
  on('agent.spawn', () => ({ model: 'x', agentId: 'never' }))
  on('ui.toast', () => ({ value: undefined }))

  const r = await $.agent.spawn({ ...spawnInput, subagentType: 'scout', parentAgentId: 'p1' })

  expect(r.deny).toBe('Meter: no nested agents — return to the main session.')
})

test('Explore with no model is rewritten to haiku, general-purpose to sonnet', async ($, on) => {
  const seen: (string | undefined)[] = []
  quiet(on)
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? 'claude-opus-5-5', agentId: `id-${seen.length}` }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore' })
  await $.agent.spawn({ ...spawnInput, subagentType: 'general-purpose', model: 'inherit' })
  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore', model: 'sonnet' })
  await $.agent.spawn({ ...spawnInput, subagentType: 'verifier' })

  expect(seen).toEqual(['haiku', 'sonnet', 'sonnet', undefined])
})

const gh = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
// `gh pr view <url> --json title,state,isDraft,additions,deletions,statusCheckRollup,number,url`,
// in the shape real gh answers (captured from `12 --repo acme/web-api`).
const run = (name: string, conclusion: string, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  completedAt: '2026-10-31T12:00:56Z',
  conclusion,
  detailsUrl: 'https://github.com/acme/web-api/actions/runs/1/job/2',
  name,
  startedAt: '2026-10-31T12:00:38Z',
  status,
  workflowName: 'Pull Request',
})
const VIEW = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    additions: 12,
    deletions: 3,
    isDraft: false,
    number: 12,
    state: 'OPEN',
    statusCheckRollup: [
      run('build', 'SUCCESS'),
      run('Superagent Security Scan', 'NEUTRAL'),
      run('lint', 'FAILURE'),
      run('e2e', '', 'IN_PROGRESS'),
      { __typename: 'StatusContext', context: 'Vercel', startedAt: '2026-11-01T20:57:16Z', state: 'PENDING', targetUrl: 'https://vercel.com/x' },
    ],
    title: 'fix: the Blue onboarding fixes',
    url: 'https://github.com/a-b/c.d/pull/12',
    ...over,
  })
const CHECKS = VIEW()
const VIEW_ARGV = ['gh', 'pr', 'view', 'https://github.com/a-b/c.d/pull/12', '--json', 'title,state,isDraft,additions,deletions,statusCheckRollup,number,url']
const notFound = (stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)') => ({
  value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

test('a Bash result with a PR URL adds a CI row and reads checks with an argv array', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh(CHECKS)
  })
  on('tool.call', () => ({ result: {}, text: 'Created https://github.com/a-b/c.d/pull/12\n' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)

  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual(VIEW_ARGV)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Link', text: /#12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /lint/ })).toBeDefined()
  await ui.unmount()
})

test('gh pr view <n> --repo owner/name builds a validated URL; a bad repo is skipped', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh('[]')
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 9 --repo acme/web' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 9 --repo acme/web;rm' })
  await clock.advance(5)

  expect(calls.map(c => c[3])).toEqual(['https://github.com/acme/web/pull/9'])
})

test('a URL with a shell tail is rejected and gh never runs', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh(CHECKS)
  })
  on('tool.call', () => ({ result: {}, text: 'see https://github.com/a/b/pull/1;rm -rf ~ for details' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'echo https://github.com/a/b/pull/2;rm -rf ~' })
  await clock.advance(5)

  expect(calls).toHaveLength(0)
})

test('gh missing shows "gh unavailable" and never throws', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  on('process.run', () => {
    throw new Error('spawn gh ENOENT')
  })
  on('tool.call', () => ({ result: {}, text: 'https://github.com/a/b/pull/3' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 3' })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /gh unavailable/ })).toBeDefined()
  await ui.unmount()
})

test('the status line shows context, cache, cost and agents by model', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))

  await $.session.measure({ context: { tokens: 142_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 3.4 }, changed: ['context', 'cost'] })

  expect(lines[lines.length - 1]).toBe('142k ctx · cache n/a · $3.40')
})

test('a subagent request is told apart by agentId: its tokens and ledger growth land on its row', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let spent = 1
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], cost: { usd: spent } },
  }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'a1' }))
  let who: string | undefined
  on('turn.step', async function* (_, e) {
    who = e.agentId
    spent += 0.25 // the engine books the cost while the step runs

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 1_000,
        model: who === undefined ? 'claude-opus-5-5' : 'claude-haiku-5-5',
      },
    }
  })

  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 1 }, changed: ['cost'] })
  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore' })
  for (const agentId of [undefined, 'a1', undefined]) {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'x', messageCount: 1, ...(agentId ? { agentId } : {}) })) void _
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Explore · Haiku · 5k read · 20 written · ≈\$0\.25/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus \(main\) ≈\$0\.50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$1\.75/ })).toBeDefined()
  await ui.unmount()
})

test('a main turn that ends after an implementer, with no verifier after it, warns once', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: e.subagentType === 'implementer' ? 'i1' : 'v1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const done = (agentId?: string) =>
    $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })

  await $.agent.spawn({ ...spawnInput, subagentType: 'implementer' })
  await done('i1')
  await done()
  await done()
  expect(toasts.filter(t => t.includes('implementer finished with no verifier after it'))).toHaveLength(1)

  // A verifier that starts afterwards covers the next implementer only if it comes after it.
  await $.agent.spawn({ ...spawnInput, subagentType: 'verifier' })
  await done('v1')
  await done()
  expect(toasts.filter(t => t.includes('no verifier'))).toHaveLength(1)
})

// -- helpers for the cost-booking tests ---------------------------------------
const stepInput = (agentId?: string) => ({ turnId: 't', index: 0, model: 'x', messageCount: 1, ...(agentId ? { agentId } : {}) })
const usageOf = (model: string) => ({
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 4_000,
  cache_creation_input_tokens: 1_000,
  model,
})
const stepResult = (e: { turnId: string; index: number }, model: string) => ({
  turnId: e.turnId,
  index: e.index,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: usageOf(model),
})
const usageAt = (usd: number, tokens = 50_000) => ({
  value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [], cost: { usd } },
})

test('the very first step is counted: its cost is the growth from before it ran', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let spent = 5 // already on the ledger when the session is first measured
  on('session.usage', () => usageAt(spent))
  on('turn.step', async function* (_, e) {
    spent += 0.4

    return stepResult(e, 'claude-opus-5-5')
  })

  for await (const _ of $.turn.step(stepInput())) void _

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Opus \(main\) ≈\$0\.40/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$5\.40/ })).toBeDefined()
  await ui.unmount()
})

test('two interleaved agents book each step to its own agentId', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let spent = 1
  on('session.usage', () => usageAt(spent))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: e.subagentType === 'scout' ? 'a1' : 'a2' }))
  const gates = new Map<string, () => void>()
  on('turn.step', async function* (_, e) {
    await new Promise<void>(resolve => gates.set(e.agentId ?? 'main', resolve))
    spent += e.agentId === 'a1' ? 0.3 : 0.5

    return stepResult(e, 'claude-haiku-5-5')
  })

  await $.agent.spawn({ ...spawnInput, subagentType: 'scout', model: 'haiku' })
  await $.agent.spawn({ ...spawnInput, subagentType: 'log-digger', model: 'haiku' })
  const run = async (id: string) => {
    for await (const _ of $.turn.step(stepInput(id))) void _
  }
  const pa = run('a1')
  const pb = run('a2')
  await clock.settle()
  gates.get('a1')?.()
  await clock.settle()
  gates.get('a2')?.()
  await Promise.all([pa, pb])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /scout · Haiku · 5k read · 20 written · ≈\$0\.30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /log-digger · Haiku · 5k read · 20 written · ≈\$0\.50/ })).toBeDefined()
  await ui.unmount()
})

test('a workflow spawn is not rewritten and raises no guard line or toast', async ($, on) => {
  quiet(on)
  const seen: (string | undefined)[] = []
  const toasts: string[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: 'claude-opus-5-5', agentId: 'w1' }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore', workflow: { runId: 'wf_1', agentIndex: 1 } })

  expect(seen).toEqual([undefined])
  expect(toasts).toHaveLength(0)
})

test('a workflow spawn from inside a subagent is still denied', async ($, on) => {
  quiet(on)
  on('agent.spawn', () => ({ model: 'x', agentId: 'never' }))
  on('ui.toast', () => ({ value: undefined }))

  const r = await $.agent.spawn({ ...spawnInput, subagentType: 'scout', parentAgentId: 'p1', workflow: { runId: 'wf_1', agentIndex: 1 } })

  expect(r.deny).toBe('Meter: no nested agents — return to the main session.')
})

test('a resumed spawn keeps its row (tokens and dollars), is not rewritten and raises no toast', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  const seen: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  let spent = 1
  on('session.usage', () => usageAt(spent))
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? 'claude-opus-5-5', agentId: 'a1' }
  })
  on('turn.step', async function* (_, e) {
    spent += 0.25

    return stepResult(e, 'claude-haiku-5-5')
  })

  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore' }) // rewritten to haiku, one toast
  for await (const _ of $.turn.step(stepInput('a1'))) void _
  const toastsBefore = toasts.length
  await $.agent.spawn({ ...spawnInput, subagentType: 'Explore', resume: { agentId: 'a1' } })

  expect(seen).toEqual(['haiku', undefined])
  expect(toasts).toHaveLength(toastsBefore)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Explore · Haiku · 5k read · 20 written · ≈\$0\.25 · running/ })).toBeDefined()
  await ui.unmount()
})

const urls30 = Array.from({ length: 30 }, (_, i) => `https://github.com/a/b/pull/${100 + i}`).join('\n')

test('gh pr list output with 30 URLs adds nothing and gh never runs', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh(CHECKS)
  })
  on('tool.call', () => ({ result: {}, text: urls30 }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr list --json url' })
  await $.tool.call({ tool: 'Bash', command: 'git log --format=%s' })
  await clock.advance(5)

  expect(calls).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Link', text: /a\/b#/ })).toBeUndefined()
  await ui.unmount()
})

test('gh pr create adds its URL; only PRs held in the pane are ever refreshed (max 8)', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh(CHECKS)
  })
  let text = 'https://github.com/a/b/pull/7\n'
  on('tool.call', () => ({ result: {}, text }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)
  expect(calls.map(c => c[3])).toEqual(['https://github.com/a/b/pull/7'])

  // A flood of URLs in a gh pr command's output: the pane keeps 8, gh runs for those 8 only.
  calls.length = 0
  text = urls30
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 3 --repo a/b' })
  await clock.advance(5)
  expect(calls.length).toBeLessThanOrEqual(8)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Link' })).length).toBeLessThanOrEqual(8)
  await ui.unmount()
})

test('the Bash result is returned exactly as it came from beneath', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  const beneath = { result: { exitCode: 0 }, text: 'Created https://github.com/a/b/pull/12\n' }
  on('tool.call', () => beneath)
  on('process.run', () => gh('[]'))
  on('ui.toast', () => ({ value: undefined }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  expect(ran).toEqual(beneath)
  expect(ran.text).toBe(beneath.text)
})

test('the cold-cache toast fires from the timer, once', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  let spent = 1
  on('session.usage', () => usageAt(spent, 142_000))
  on('turn.step', async function* (_, e) {
    spent += 0.1

    return stepResult(e, 'claude-opus-5-5')
  })

  for await (const _ of $.turn.step(stepInput())) void _
  expect(toasts.filter(t => t.includes('went cold'))).toHaveLength(0)
  await clock.advance(70 * MIN)
  await clock.advance(10 * MIN)

  const cold = toasts.filter(t => t.includes('went cold'))
  expect(cold).toHaveLength(1)
  expect(cold[0]).toContain('142k')
  expect(cold[0]).toContain('A fresh session is cheaper.')
})

test('a small context says the cache went cold without advising a fresh session', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => usageAt(1, 60_000))
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-opus-5-5')
  })

  for await (const _ of $.turn.step(stepInput())) void _
  await clock.advance(80 * MIN)

  const cold = toasts.filter(t => t.includes('went cold'))
  expect(cold).toHaveLength(1)
  expect(cold[0]).not.toContain('fresh session')
})

test('the 350k toast fires again after a compaction drops the context and it re-crosses', async ($, on) => {
  const toasts: string[] = []
  quiet(on)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const at = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], cost: { usd: 2 }, changed: ['context', 'cost'] })

  await at(360_000)
  await at(90_000) // /compact
  await at(365_000)

  expect(toasts.filter(t => t.includes('350k'))).toHaveLength(2)
})

test('gh flag values are not read as the PR number', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return gh('[]')
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr checks --watch --interval 10 --repo a/b' })
  await clock.advance(5)
  expect(calls).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'gh pr checks --interval 10 --repo a/b 12' })
  await clock.advance(5)
  expect(calls.map(c => c[3])).toEqual(['https://github.com/a/b/pull/12'])
})

test('a 60k-character run of dots is handled in under 50 ms', async () => {
  for (const text of ['.'.repeat(60_000), `https://github.com/${'.'.repeat(60_000)}`, `https://github.com/a/b/pull/1${','.repeat(60_000)}`]) {
    const t0 = performance.now()
    const found = prUrlsIn(text)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(found.length).toBeLessThanOrEqual(1)
  }
  expect(prUrlsIn('see https://github.com/a/b/pull/12.')).toEqual(['https://github.com/a/b/pull/12'])
})

test('gh is looked for in the usual install spots when PATH has none', async ($, on) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const tried: string[] = []
  on('process.run', (_, e) => {
    tried.push(e.argv[0] ?? '')
    if (e.argv[0] === 'gh') throw new Error('spawn gh ENOENT')

    return gh(CHECKS)
  })
  on('tool.call', () => ({ result: {}, text: 'https://github.com/a/b/pull/3' }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 3 --repo a/b' })
  await clock.advance(5)

  expect(tried).toEqual(['gh', '/opt/homebrew/bin/gh'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2\/5/ })).toBeDefined()
  await ui.unmount()
})

test('the pane still opens when /meter cannot be registered, and registers lazily from the hooks that always run', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let registered = 0
  on('command.register', () => {
    registered++
    if (registered === 1) throw new Error('refused')

    return { value: { command: 'meter' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usageAt(1))
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-opus-5-5')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }) // does not throw
  for await (const _ of $.turn.step(stepInput())) void _

  expect(registered).toBe(2)
})

// ---------------------------------------------------------------------------
// Round 3
// ---------------------------------------------------------------------------
type Cell = { props: Record<string, unknown> }
type Found = { props: Record<string, unknown>; children: unknown[]; text: string }
type Tree = { findAll: (query: { type?: string; text?: string | RegExp }) => Promise<Found[]> }

// -- SVG helpers: the charts' source is read as text -------------------------
type Attrs = Record<string, string>
const attrsOf = (raw: string): Attrs => Object.fromEntries([...raw.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1] as string, m[2] as string]))
/** The attributes of every `<tag .../>` or `<tag ...>` in the source, in order. */
const elements = (src: string, tag: string): Attrs[] => [...src.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map(m => attrsOf(m[1] ?? ''))
const num = (v: string | undefined): number => Number(v)
/** What is drawn inside the clipped group(s): the coloured segments, not the track. */
const inner = (src: string): string => [...src.matchAll(/<g clip-path="[^"]*">(.*?)<\/g>/g)].map(m => m[1]).join('')
const fillsOf = (src: string): (string | undefined)[] => elements(inner(src), 'rect').map(r => r.fill)
/** The source of the drawn `Svg` whose alt text matches. */
const svgSource = async (ui: Tree, alt: RegExp): Promise<string> => String((await ui.findAll({ type: 'Svg' })).find(x => alt.test(String(x.props.alt)))?.props.source ?? '')

/** A tiny well-formedness check: balanced tags, quoted attributes, no raw `<` or stray `&`. */
const wellFormed = (src: string) => {
  expect(src.startsWith('<svg ')).toBe(true)
  expect(src.endsWith('</svg>')).toBe(true)
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g
  const stack: string[] = []
  let last = 0
  for (let m = tag.exec(src); m !== null; m = tag.exec(src)) {
    expect(src.slice(last, m.index).includes('<')).toBe(false) // text between tags
    if (m[1] === '/') expect(stack.pop()).toBe(m[2])
    else if (m[4] !== '/') stack.push(m[2] as string)
    last = tag.lastIndex
  }
  expect(src.slice(last)).toBe('') // nothing the tag pattern could not parse
  expect(stack).toEqual([])
  expect(/&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(src)).toBe(false)
}

/** `config.list` answering the theme row. */
const themeRow = (on: On, value: string) =>
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value, provider: { plugin: 'engine', tier: 'core' } as const, isLocked: false }],
  }))

const PR_URL_7 = 'https://github.com/acme/web-api/pull/7'

/** Bash result mock + clock + toasts, as the PR tests need. */
const prSetup = (on: On, text: string, answer: () => ReturnType<typeof gh>) => {
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)

    return answer()
  })
  on('tool.call', () => ({ result: {}, text }))
  on('ui.toast', () => ({ value: undefined }))

  return { clock, calls }
}

test('a PR row reads like the app: icon + title, repo #N +adds -dels, dot + passed/total', async ($, on) => {
  const { clock } = prSetup(on, `Created ${PR_URL_7}\n`, () =>
    gh(
      VIEW({
        statusCheckRollup: [run('a', 'FAILURE'), run('b', 'TIMED_OUT'), run('c', 'CANCELLED'), run('d', 'FAILURE'), run('e', 'SUCCESS'), run('f', 'SKIPPED')],
      }),
    ),
  )

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'fix: the Blue onboarding fixes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'web-api' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '#7' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '+12' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: '−3' }))?.props.color).toBe('error')
    // 2 of 6 passed; the dot is the worst state (failed)
    expect(await ui.find({ type: 'Text', text: '2/6' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^● $/ }))?.props.color).toBe('error')
    // the failing names: at most 3 of the 4
    const failing = (await ui.findAll({ type: 'Text' })).filter(t => ['a', 'b', 'c', 'd'].includes(t.text))
    expect(failing.map(t => t.text)).toEqual(['a', 'b', 'c'])
    expect(failing[0]?.props.color).toBe('error')
    expect(failing[0]?.props.dimColor).toBe(true)
    // no "took 5m 50s" line any more
    expect(await ui.find({ type: 'Text', text: /took / })).toBeUndefined()
    await ui.unmount()
  }
})

const dotOf = async ($: Engine, on: On, rollupRows: unknown[]) => {
  const t = prSetup(on, `Created ${PR_URL_7}\n`, () => gh(VIEW({ statusCheckRollup: rollupRows })))
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await t.clock.advance(5)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const dot = await ui.find({ type: 'Text', text: /^● $/ })
  const count = await ui.find({ type: 'Text', text: /^[0-9]+\/[0-9]+$/ })
  const failing = (await ui.findAll({ type: 'Text' })).filter(x => x.props.color === 'error' && x.props.dimColor === true)
  await ui.unmount()

  return { color: dot?.props.color, dim: dot?.props.dimColor, count: count?.text, failing: failing.length }
}

test('the dot is warning while a check is pending, and no failing names are listed', async ($, on) => {
  expect(await dotOf($, on, [run('x', 'SUCCESS'), run('y', '', 'QUEUED')])).toMatchObject({ color: 'warning', count: '1/2', failing: 0 })
})

test('the dot is success when every check passed', async ($, on) => {
  expect(await dotOf($, on, [run('x', 'SUCCESS'), run('y', 'NEUTRAL')])).toMatchObject({ color: 'success', count: '2/2', failing: 0 })
})

test('the dot is dim when there are no checks', async ($, on) => {
  expect(await dotOf($, on, [])).toMatchObject({ dim: true, count: '0/0', failing: 0 })
})

test('open, merged, closed and draft each get their own icon and colour', async ($, on) => {
  const rows = [
    pr({ url: 'https://github.com/o/r/pull/1', label: 'o/r#1', kind: 'open', fail: 0, failing: [] }),
    pr({ url: 'https://github.com/o/r/pull/2', label: 'o/r#2', kind: 'merged', fail: 0, failing: [] }),
    pr({ url: 'https://github.com/o/r/pull/3', label: 'o/r#3', kind: 'closed', fail: 0, failing: [] }),
    pr({ url: 'https://github.com/o/r/pull/4', label: 'o/r#4', kind: 'draft', fail: 0, failing: [] }),
  ]
  on('state.get', (_, e) => stored(live({ ci: rows }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: '◉' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('merged')
  expect((await ui.find({ type: 'Text', text: '✕' }))?.props.color).toBe('error')
  const draft = await ui.find({ type: 'Text', text: '◌' })
  expect(draft?.props.color).toBeUndefined()
  expect(draft?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('gh ran but the PR is not there: "not found" (dim), never "gh unavailable"; a second miss drops the row', async ($, on) => {
  const { clock } = prSetup(on, `Created ${PR_URL_7}\n`, () => notFound())
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' }) // starts the clock ticker
  await first.unmount()

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ type: 'Text', text: 'not found' })
  expect(row).toBeDefined()
  expect(row?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /gh unavailable/ })).toBeUndefined()
  await ui.unmount()

  // one retry on the next poll, and a row that is still not found goes away
  await clock.advance(15_000)
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: 'not found' })).toBeUndefined()
  expect(await after.find({ type: 'Link', text: '#7' })).toBeUndefined()
  await after.unmount()
})

test('a failed read that is not "not found" (offline) keeps the row and says so', async ($, on) => {
  const { clock } = prSetup(on, `Created ${PR_URL_7}\n`, () => notFound('error connecting to api.github.com'))
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: "couldn't check" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'not found' })).toBeUndefined()
  await ui.unmount()
})

test('a subagent Bash call with a PR URL adds nothing and gh never runs', async ($, on) => {
  const { clock, calls } = prSetup(on, 'https://github.com/a/b/pull/1', () => gh(VIEW()))

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 1 --repo a/b', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill', agentId: 'sub-1' } as never)
  await clock.advance(5)

  expect(calls).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()

  // the same call from the main thread does add it
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 1 --repo a/b' })
  await clock.advance(5)
  expect(calls).toHaveLength(1)
})

test('rollup counts CheckRun conclusions and StatusContext states', () => {
  const r = rollup([
    run('ok', 'SUCCESS'),
    run('neutral', 'NEUTRAL'),
    run('skipped', 'SKIPPED'),
    run('f1', 'FAILURE'),
    run('f2', 'CANCELLED'),
    run('f3', 'TIMED_OUT'),
    run('f4', 'ACTION_REQUIRED'),
    run('queued', '', 'QUEUED'),
    { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/other', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/slow', state: 'PENDING' },
  ])
  expect(r).toEqual({ pass: 4, fail: 5, pending: 2, failing: ['f1', 'f2', 'f3'] })
  expect(rollup(undefined)).toEqual({ pass: 0, fail: 0, pending: 0, failing: [] })
})

test('a long title is cut with an ellipsis to the pane width', async ($, on) => {
  const title = 'fix: ' + 'very long title '.repeat(10)
  on('state.get', (_, e) => stored(live({ ci: [pr({ title })] }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = (await ui.findAll({ type: 'Text' })).find(t => t.text.startsWith('fix: very'))
  expect(shown?.text.endsWith('…')).toBe(true)
  expect(shown?.text.length).toBeLessThanOrEqual(42)
  await ui.unmount()
  expect(truncate('abc', 5)).toBe('abc')
  expect(truncate('abcdef', 4)).toBe('abc…')
})

test('token formatting: under 1k as is, k with no decimals, 1.1M at a million', () => {
  expect([0, 999, 1_000, 48_400, 310_000, 999_400, 1_100_000, 2_460_000].map(tokens)).toEqual(['0', '999', '1k', '48k', '310k', '999k', '1.1M', '2.5M'])
})

test('two bars (Cost, Tokens written) share colours; each bar has its own legend (money under Cost, written tokens under Tokens written)', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Cost' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tokens written' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Sonnet ≈$0.92' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus (main) ≈$1.32' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus (agents) ≈$1.04' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Sonnet 48k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus (main) 21k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus (agents) 9k' })).toBeDefined()
    // the old combined legend is gone
    expect(await ui.find({ type: 'Text', text: /≈\$.* · .*written/ })).toBeUndefined()
    await ui.unmount()
  }

  // proportions: Sonnet wrote 48k of 80k tokens, but is 0.92 of 3.40 dollars
  const cost = splitParts(40, [
    { color: 'claude', value: 1.32 },
    { color: 'ide', value: 0.92 },
  ])
  const written = splitParts(40, [
    { color: 'claude', value: 21_000 },
    { color: 'ide', value: 48_000 },
  ])
  expect(cost.map(p => p.cells)).toEqual([24, 16, 0])
  expect(written.map(p => p.cells)).toEqual([12, 28, 0])
})

test('on a desktop pane the two bars draw the same bucket colours in the same order', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 3.4 }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const cost = fillsOf(await svgSource(ui, /^Cost/))
  const written = fillsOf(await svgSource(ui, /^Tokens written/))
  // Opus (main), Haiku, Sonnet, Opus (agents)
  expect(cost).toEqual(['#D97757', '#55A06A', '#3B82D6', '#9B7BD4'])
  expect(written).toEqual(cost)
  // and the legend swatches are those same hexes, so a legend never differs in shade from its bar
  const swatches = (await ui.findAll({ type: 'Text', text: '■' })).map(t => t.props.color)
  expect(swatches).toEqual(expect.arrayContaining(['#D97757', '#55A06A', '#3B82D6', '#9B7BD4']))
  await ui.unmount()
})

test('a bucket with no cost and nothing written is not drawn', async ($, on) => {
  on(
    'state.get',
    (_, e) =>
      stored(
        live({
          spend: { 'opus-main': 3.4, haiku: 0, sonnet: 0, 'opus-checks': 0 },
          written: { 'opus-main': 30_000, haiku: 0, sonnet: 0, 'opus-checks': 0 },
        }),
        e,
      ),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Haiku ≈/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Sonnet ≈/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Opus \(agents\) ≈/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Opus (main) ≈$3.40' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus (main) 30k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Haiku/ })).toBeUndefined()
  await ui.unmount()
})

test('"Before Meter loaded" is the grey first part of the cost bar and makes the buckets add up to the session cost', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 3.40 booked, 2.00 from before
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const entries = (await ui.findAll({ type: 'Text' })).filter(t => /^(Before Meter loaded|Opus|Haiku|Sonnet)/.test(t.text) && /≈\$/.test(t.text) && !/·.*read/.test(t.text))
    const sum = entries.reduce((n, t) => n + Number(/≈\$([0-9.]+)/.exec(t.text)?.[1]), 0)
    expect(entries[0]?.text).toBe('Before Meter loaded ≈$2.00')
    expect(Math.abs(sum - 5.4) < 0.005).toBe(true)
    // no tokens for it, and no grey legend value for tokens
    expect(entries[0]?.text).not.toContain('written')
    const swatch = (await ui.findAll({ type: 'Text', text: '■' }))[0]
    expect(swatch?.props.color).toBe(surface === 'terminal' ? 'inactive' : '#9CA3AF')
    if (surface === 'desktop') {
      // the cost bar starts with the grey part; the tokens bar leaves it out
      expect(fillsOf(await svgSource(ui, /^Cost/))[0]).toBe('#9CA3AF')
      expect(fillsOf(await svgSource(ui, /^Tokens written/))).not.toContain('#9CA3AF')
    }
    await ui.unmount()
  }
})

test('the cost legend carries money only, the tokens legend carries token counts only and no Before Meter loaded', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 2.00 from before
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const buckets = /^(Before Meter loaded|Opus \((main|agents)\)|Haiku|Sonnet)/
    const costLegend = texts.filter(t => buckets.test(t) && /≈\$/.test(t) && !/ read /.test(t))
    const tokenLegend = texts.filter(t => /^(Opus \((main|agents)\)|Haiku|Sonnet) [0-9.]+[kM]?$/.test(t))
    expect(costLegend.length).toBe(5)
    for (const t of costLegend) {
      expect(t).toMatch(/≈\$[0-9.]+$/)
      expect(t).not.toContain('written')
    }
    expect(tokenLegend).toEqual(['Opus (main) 21k', 'Haiku 2k', 'Sonnet 48k', 'Opus (agents) 9k'])
    for (const t of tokenLegend) {
      expect(t).not.toContain('$')
      expect(t).not.toContain('Before Meter loaded')
    }
    expect(texts.some(t => /^Before Meter loaded ≈\$/.test(t))).toBe(true)
    expect(texts.filter(t => t.includes('Before Meter loaded')).length).toBe(1) // only under Cost
    await ui.unmount()
  }
})

test('legend shares: whole percents by largest remainder, <1% under half a percent, nothing at a zero total', () => {
  const sum = (xs: string[]) => xs.reduce((n, t) => n + (t === '<1%' ? 0 : parseInt(t, 10)), 0)
  const cost = shares([17.95, 2.41, 0.02, 3.19])
  expect(cost).toEqual(['76%', '10%', '<1%', '14%'])
  expect(sum(cost)).toBe(100)
  const tok = shares([21_000, 16_000, 150_000])
  expect(tok).toEqual(['11%', '9%', '80%'])
  expect(sum(tok)).toBe(100)
  // thirds: 33.33 each, the leftover point goes to the first of equal remainders
  expect(sum(shares([1, 1, 1]))).toBe(100)
  expect(shares([0, 0])).toEqual(['', ''])
  expect(shares([])).toEqual([])
  expect(shares([5, 0])).toEqual(['100%', '0%'])
  expect(shares([1, 1000])).toEqual(['<1%', '100%'])
  expect(shares([Number.NaN, 4])).toEqual(['0%', '100%'])
})

test('both legends show each entry share of its own bar, dim, on terminal and desktop', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 2.00 before + 3.40 booked
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const pcts = (await ui.findAll({ type: 'Text' })).filter(t => /^· (<1|\d+)%$/.test(t.text))
    // cost: before, Opus (main), Haiku, Sonnet, Opus (agents); tokens: Opus (main), Haiku, Sonnet, Opus (agents)
    expect(pcts.map(t => t.text)).toEqual(['· 37%', '· 25%', '· 2%', '· 17%', '· 19%', '· 26%', '· 3%', '· 60%', '· 11%'])
    expect(pcts.every(t => t.props.dimColor === true)).toBe(true)
    // the money and token values stay their own entries
    expect(await ui.find({ type: 'Text', text: 'Before Meter loaded ≈$2.00' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Sonnet 48k' })).toBeDefined()
    await ui.unmount()
  }
})

test('a zero total draws no percent in the legends', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 0, spend: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 }, written: { 'opus-main': 0, haiku: 0, sonnet: 5, 'opus-checks': 0 } }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const pcts = (await ui.findAll({ type: 'Text' })).filter(t => /^· (<1|\d+)%$/.test(t.text))
  // cost total is zero: no cost percent; the one token entry is 100%
  expect(pcts.map(t => t.text)).toEqual(['· 100%'])
  await ui.unmount()
})

test('a session with nothing booked yet and no cost before it draws no bucket and no grey', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 0, spend: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 }, written: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 }, agents: [], groups: [] }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Before Meter loaded/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Tokens written' })).toBeDefined() // the bar's own label
  await ui.unmount()
})

test('a main-thread step books its output tokens and cost to the bucket, and adds a timeline step', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let spent = 1
  on('session.usage', () => usageAt(spent))
  on('turn.step', async function* (_, e) {
    spent += 0.4

    return stepResult(e, 'claude-opus-5-5')
  })
  for await (const _ of $.turn.step(stepInput())) void _

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Opus (main) ≈$0.40' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus (main) 20' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Dollars per step' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'no steps yet' })).toBeUndefined()
  await ui.unmount()
})

test('an agent with no spawn record is named from the engine list, not "agent"', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => usageAt(1))
  on('agent.list', () => ({ value: [{ id: 'w9', type: 'implementer', description: 'x', status: 'running' }] }) as never)
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-sonnet-5-5')
  })
  for await (const _ of $.turn.step(stepInput('w9'))) void _

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /implementer · Sonnet · 5k read · 20 written/ })).toBeDefined()
  await ui.unmount()
})

test('agent.spawn uses subagentType; a teammate falls back to its name', async ($, on) => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: e.name === 'tm' ? 'm1' : 's1' }))

  await $.agent.spawn({ ...spawnInput, subagentType: 'verifier', model: 'sonnet' })
  await $.agent.spawn({ ...spawnInput, subagentType: 'teammate', name: 'tm', model: 'sonnet' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /verifier · Sonnet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tm · Sonnet/ })).toBeDefined()
  await ui.unmount()
})

// -- Dollars per step ---------------------------------------------------------
const fillGroups = (n: number, parts = { readUsd: 0.1, newUsd: 0.02, answerUsd: 0.01 }) => {
  let groups: MeterGroup[] = []
  let groupSize = 1
  for (let i = 0; i < n; i++) ({ groups, groupSize } = addToGroups(groups, groupSize, parts))

  return { groups, groupSize }
}
const covers = (g: MeterGroup[], n: number) =>
  g.length > 0 && g[0]?.fromStep === 1 && g[g.length - 1]?.toStep === n && g.every((x, i) => i === 0 || x.fromStep === (g[i - 1]?.toStep ?? -9) + 1)
const sum = (g: MeterGroup[], key: 'readUsd' | 'newUsd' | 'answerUsd') => g.reduce((a, x) => a + x[key], 0)
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
const USAGE = { input_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 1_000, output_tokens: 200 }

test('the split uses the fixed price ratios: input 1, read 0.1, write 1.25 (5m) or 2 (1h), output 5', () => {
  expect(PRICE_RATIO).toEqual({ input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 })
  // 1h: re-read 10000*0.1 = 1000, new 100 + 1000*2 = 2100, answer 200*5 = 1000 (of 4100)
  const h = splitCost(4.1, USAGE, '1h')
  expect([near(h.readUsd, 1), near(h.newUsd, 2.1), near(h.answerUsd, 1)]).toEqual([true, true, true])
  // 5m: new 100 + 1000*1.25 = 1350 (of 3350)
  const m = splitCost(3.35, USAGE, '5m')
  expect([near(m.readUsd, 1), near(m.newUsd, 1.35), near(m.answerUsd, 1)]).toEqual([true, true, true])
})

test('the three parts add up to the step cost, for 5m and 1h', () => {
  for (const ttl of ['5m', '1h'] as const) {
    for (const cost of [0.0001, 0.37, 2.5]) {
      const s = splitCost(cost, USAGE, ttl)
      expect(near(s.readUsd + s.newUsd + s.answerUsd, cost)).toBe(true)
    }
  }
  expect(splitCost(0, USAGE, '1h')).toEqual({ readUsd: 0, newUsd: 0, answerUsd: 0 })
})

test('a step of only cache reads is all re-read', () => {
  const s = splitCost(0.5, { input_tokens: 0, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0, output_tokens: 0 }, '1h')
  expect(s).toEqual({ readUsd: 0.5, newUsd: 0, answerUsd: 0 })
  expect(stackCells([s.readUsd, s.newUsd, s.answerUsd], 0.5, 8)).toEqual([8, 0, 0])
})

test('one step is one column: step 1 alone', () => {
  const { groups } = fillGroups(1)
  expect(groups).toHaveLength(1)
  expect([groups[0]?.fromStep, groups[0]?.toStep]).toEqual([1, 1])
})

test('30 steps make 12 or fewer columns covering 1-30 with nothing lost', () => {
  const { groups } = fillGroups(30)
  expect(groups.length).toBeLessThanOrEqual(12)
  expect(covers(groups, 30)).toBe(true)
  expect([groups[0]?.fromStep, groups[0]?.toStep]).toEqual([1, 1])
  expect(near(sum(groups, 'readUsd'), 3)).toBe(true)
  expect(near(sum(groups, 'answerUsd'), 0.3)).toBe(true)
})

test('200 steps still make 12 or fewer columns covering all 200, in equal runs after the first', () => {
  const { groups, groupSize } = fillGroups(200)
  expect(groups.length).toBeLessThanOrEqual(12)
  expect(covers(groups, 200)).toBe(true)
  expect(near(sum(groups, 'newUsd'), 4)).toBe(true)
  for (const g of groups.slice(1, -1)) expect(g.toStep - g.fromStep + 1).toBe(groupSize)
  // every count along the way stays within 12 and contiguous
  for (const n of [12, 13, 14, 25, 26, 49, 100, 199]) {
    const x = fillGroups(n).groups
    expect(x.length).toBeLessThanOrEqual(12)
    expect(covers(x, n)).toBe(true)
  }
})

test('merging pairs keeps the first column alone and adds the dollars up', () => {
  const merged = mergePairs([grp(1, 1, 1, 1), grp(2, 2, 0, 0), grp(3, 3, 0, 0), grp(4, 4, 0, 0), grp(5, 5, 0, 0)])
  expect(merged.map(g => [g.fromStep, g.toStep])).toEqual([[1, 1], [2, 3], [4, 5]])
  expect(merged[1]?.readUsd).toBe(5)
})

test('the y axis uses nice ticks: $0.43 -> $0.1..$0.5, $3.8 -> $1..$4, $12 -> $5 $10 $15, $0.07 -> step 0.025', () => {
  expect(niceTicks(0.43)).toEqual({ step: 0.1, top: 0.5, ticks: [0.1, 0.2, 0.3, 0.4, 0.5] })
  expect(niceTicks(3.8)).toEqual({ step: 1, top: 4, ticks: [1, 2, 3, 4] })
  expect(niceTicks(12)).toEqual({ step: 5, top: 15, ticks: [5, 10, 15] })
  expect(niceTicks(0.07)).toEqual({ step: 0.025, top: 0.075, ticks: [0.025, 0.05, 0.075] })
  // 2.5 only when it gives 3 or 4 lines and a lower top
  expect(niceTicks(0.62)).toEqual({ step: 0.25, top: 0.75, ticks: [0.25, 0.5, 0.75] })
  expect(niceTop(0.37)).toBe(0.4)
  expect([niceTop(0.5), niceTop(1), niceTop(1.01), niceTop(0)]).toEqual([0.5, 1, 1.5, 1])
  expect(niceTicks(0)).toEqual({ step: 0.25, top: 1, ticks: [0.25, 0.5, 0.75, 1] })
})

test('nice ticks: 3 to 5 lines, a top that holds the max and is a multiple of the step, whatever the size', () => {
  let seed = 11
  const rand = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647
  for (let n = 0; n < 2000; n++) {
    const max = 10 ** (rand() * 8 - 5) // $0.00001 .. $1000
    const { step, top, ticks } = niceTicks(max)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(5)
    expect(top).toBeGreaterThanOrEqual(max * (1 - 1e-9))
    expect(top).toBeLessThan(max + 2 * step) // never a whole extra step of empty room
    expect(Math.abs(top / step - Math.round(top / step))).toBeLessThan(1e-9)
    const mantissa = step / 10 ** Math.floor(Math.log10(step))
    expect([1, 2, 2.5, 5].some(m => Math.abs(m - mantissa) < 1e-6)).toBe(true)
  }
})

test('the $ labels drop trailing zeros: $0.1, $0.25, $1, $15', () => {
  const labels = (max: number) => [...dollarsSvg([grp(1, max, 0, 0)], -1, PALETTES.light, 336).matchAll(/text-anchor="end">([^<]*)</g)].map(m => m[1])
  expect(labels(0.43)).toEqual(['$0.1', '$0.2', '$0.3', '$0.4', '$0.5'])
  expect(labels(0.62)).toEqual(['$0.25', '$0.5', '$0.75'])
  expect(labels(3.8)).toEqual(['$1', '$2', '$3', '$4'])
  expect(labels(12)).toEqual(['$5', '$10', '$15'])
  expect(labels(0.07)).toEqual(['$0.025', '$0.05', '$0.075'])
})

test('the columns scale to the nice top and sit on the gridlines', () => {
  const plotH = 180 - 24 - 20
  const col = columnsOf(dollarsSvg([grp(1, 0.2, 0, 0)], -1, PALETTES.light, 336))[0]
  expect(Math.abs((col?.part.read?.height ?? 0) - (0.2 / 0.2) * plotH) < 0.1).toBe(true) // max 0.2: step 0.05, top 0.2, so the column fills the plot
  const tall = columnsOf(dollarsSvg([grp(1, 0.43, 0, 0)], -1, PALETTES.light, 336))[0]
  expect(Math.abs((tall?.part.read?.height ?? 0) - (0.43 / 0.5) * plotH) < 0.1).toBe(true)
  // the gridlines are evenly spaced at one step each
  const ys = elements(dollarsSvg([grp(1, 0.43, 0, 0)], -1, PALETTES.light, 336), 'line').map(l => num(l.y1))
  expect(ys).toHaveLength(6) // baseline + 5 ticks
  expect(Math.abs(ys[0]! - ys[1]! - plotH / 5) < 0.1).toBe(true)
})

test('a column is bottom-aligned: re-read at the bottom, then new, then answer; nothing floats above a gap', () => {
  let seed = 7
  const rand = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647
  for (let n = 0; n < 300; n++) {
    const values = [rand() < 0.2 ? 0 : rand(), rand() < 0.2 ? 0 : rand() * 0.3, rand() < 0.2 ? 0 : rand() * 0.1]
    const rows = n % 2 === 0 ? 8 : 4
    const top = niceTop(Math.max(...values, 0.001) * (1 + rand()))
    const cells = stackCells(values, top, rows)
    const height = cells.reduce((a, b) => a + b, 0)
    const total = values.reduce((a, b) => a + b, 0)
    expect(height).toBe(total > 0 ? Math.min(rows, Math.max(1, Math.round((total / top) * rows))) : 0)
    values.forEach((v, i) => expect(v > 0 ? cells[i] : 0).toBeGreaterThanOrEqual(0))
    if (total > 0) values.forEach((v, i) => expect(Math.abs((cells[i] ?? 0) - (v / total) * height)).toBeLessThan(1)) // largest remainder: within a cell of exact
    const colours = columnColors(cells, rows)
    expect(colours).toHaveLength(rows)
    const filled = colours.map(c => c !== undefined)
    expect(`${filled.join(',')},`).toMatch(/^(false,)*(true,)*$/)
    const order = colours.filter((c): c is NonNullable<typeof c> => c !== undefined).map(c => ({ merged: 0, warning: 1, success: 2 })[c as 'merged' | 'warning' | 'success'])
    expect(order).toEqual([...order].sort((a, b) => b - a)) // top (answer 2) down to bottom (re-read 0)
  }
  expect(columnColors([2, 1, 1], 6)).toEqual([undefined, undefined, 'success', 'warning', 'merged', 'merged'])
})

test('no part is forced up to a cell: a small part gets none, the answer never looks as big as the re-read', () => {
  // 0.92 of 1 = 7 of 8 cells; the re-read part takes all 7, the two 1% parts are too small for one
  expect(stackCells([0.9, 0.01, 0.01], 1, 8)).toEqual([7, 0, 0])
  expect(stackCells([0.9, 0, 0.01], 1, 8)).toEqual([7, 0, 0])
  // parts that really are equal still share evenly
  expect(stackCells([0.2, 0.2, 0.2], 0.8, 4)).toEqual([1, 1, 1])
  // a column that holds anything keeps one cell, and it goes to the biggest part
  expect(stackCells([0.001, 0.0005, 0.0005], 1, 4)).toEqual([1, 0, 0])
  // the cells always add up to the column's height
  expect(stackCells([0.5, 0.3, 0.2], 1, 8).reduce((a, b) => a + b, 0)).toBe(8)
})

/** The coloured segments of the Dollars SVG, grouped by column (same `x`), each column bottom-up. */
const columnsOf = (src: string) => {
  const cols = new Map<string, Attrs[]>()
  for (const r of elements(inner(src), 'rect')) cols.set(r.x as string, [...(cols.get(r.x as string) ?? []), r])
  const palette = { '#A58BC8': 'read', '#DDA65A': 'new', '#55A06A': 'answer' } as const

  return [...cols.entries()]
    .sort((a, b) => num(a[0]) - num(b[0]))
    .map(([x, parts]) => ({
      x: num(x),
      width: num(parts[0]?.width),
      part: Object.fromEntries(parts.map(p => [palette[p.fill as keyof typeof palette], { y: num(p.y), height: num(p.height) }])) as Record<'read' | 'new' | 'answer', { y: number; height: number } | undefined>,
    }))
}

const TICKS = ['$0.1', '$0.2', '$0.3', '$0.4'] // the fixture's tallest column is $0.38

test('desktop: the Dollars chart is SVG: a stacked column per group, bottom-aligned, with a dashed /compact line before step 8', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui, /^Dollars per step/)
  wellFormed(src)

  const cols = columnsOf(src)
  expect(cols).toHaveLength(10)
  // bottom-aligned, stacked in order: re-read at the bottom, new above it, the answer on top
  const baseline = Math.max(...cols.flatMap(c => [c.part.read, c.part.new, c.part.answer]).map(p => (p ? p.y + p.height : 0)))
  for (const c of cols) {
    const { read, new: fresh, answer } = c.part
    if (read && fresh) expect(read.y).toBeGreaterThanOrEqual(fresh.y + fresh.height - 0.01)
    if (fresh && answer) expect(fresh.y).toBeGreaterThanOrEqual(answer.y + answer.height - 0.01)
    const bottom = c.part.read ?? c.part.new ?? c.part.answer
    expect(Math.abs((bottom?.y ?? 0) + (bottom?.height ?? 0) - baseline) < 0.1).toBe(true) // every column stands on the same baseline
  }
  // after /compact the re-read part drops
  expect(cols[7]?.part.read?.height).toBeLessThan(cols[6]?.part.read?.height ?? 0)

  // one dashed red line, in the gap between the columns of step 7 and step 8, and one pill
  const dashed = elements(src, 'line').filter(l => l['stroke-dasharray'] !== undefined)
  expect(dashed).toHaveLength(1)
  expect(dashed[0]?.stroke).toBe('#B0412E')
  const x = num(dashed[0]?.x1)
  expect(x).toBeGreaterThan((cols[6]?.x ?? 0) + (cols[6]?.width ?? 0))
  expect(x).toBeLessThan(cols[7]?.x ?? 0)
  expect(src.match(/>\/compact</g)).toHaveLength(1)
  expect(elements(src, 'rect').filter(r => r.rx === '8' && r.fill === '#B0412E')).toHaveLength(1) // the pill

  // gridlines with $ labels at nice ticks, and the step labels under the columns
  for (const t of TICKS) expect(src).toContain(`>${t}<`)
  for (const t of ['1', '7', '10']) expect(src).toContain(`>${t}<`)
  expect(elements(src, 'line').filter(l => l['stroke-dasharray'] === undefined)).toHaveLength(TICKS.length + 1) // the gridlines + the baseline

  // the legend names the same three colours
  for (const t of ['re-read', 'new: stored', 'answer', 'Dollars per step']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main conversation · ≈ split by token type' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: '■' })).map(t => t.props.color)).toEqual(expect.arrayContaining(['#A58BC8', '#DDA65A', '#55A06A']))
  await ui.unmount()
})

test('the Dollars SVG is in true proportion: a 90% / 5% / 5% column has rects in that ratio, with no minimum segment', () => {
  const plotH = 180 - 24 - 20
  const one = columnsOf(dollarsSvg([grp(1, 0.9, 0.05, 0.05)], -1, PALETTES.light, 336))[0]
  // top of the axis is $1, so the column is 100% of it
  expect(Math.abs((one?.part.read?.height ?? 0) - 0.9 * plotH)).toBeLessThan(1)
  expect(Math.abs((one?.part.new?.height ?? 0) - 0.05 * plotH)).toBeLessThan(1)
  expect(Math.abs((one?.part.answer?.height ?? 0) - 0.05 * plotH)).toBeLessThan(1)
  expect(Math.abs((one?.part.new?.height ?? 0) / (one?.part.read?.height ?? 1) - 0.05 / 0.9) < 0.01).toBe(true)
  // a part that is a thousandth of the axis is a thousandth tall, not 1 px
  const tiny = columnsOf(dollarsSvg([grp(1, 0.5, 0.001, 0.001)], -1, PALETTES.light, 336))[0]
  expect(tiny?.part.new?.height).toBeLessThan(0.5)
  // a zero part is not drawn at all
  expect(columnsOf(dollarsSvg([grp(1, 0.5, 0, 0.1)], -1, PALETTES.light, 336))[0]?.part.new).toBeUndefined()
})

test('a column is at most 36 px wide and few columns stay on the left: 3 groups are not stretched', () => {
  for (const width of [336, 784, 960]) {
    const cols = columnsOf(dollarsSvg([grp(1, 0.1, 0.02, 0.01), grp(2, 0.12, 0.02, 0.01), grp(3, 0.14, 0.02, 0.01)], -1, PALETTES.dark, width))
    expect(cols).toHaveLength(3)
    for (const c of cols) expect(c.width).toBeLessThanOrEqual(36)
    expect(Math.max(...cols.map(c => c.x + c.width))).toBeLessThan(width - 100) // left-aligned, with room to the right
    // the gap between two columns is a quarter of the pitch
    const pitch = (cols[1]?.x ?? 0) - (cols[0]?.x ?? 0)
    expect(Math.abs(((cols[1]?.x ?? 0) - ((cols[0]?.x ?? 0) + (cols[0]?.width ?? 0))) / pitch - 0.25) < 0.02).toBe(true)
  }
  // 12 columns fill the pane instead
  const twelve = columnsOf(dollarsSvg(Array.from({ length: 12 }, (_, i) => grp(i + 1, 0.1, 0.02, 0.01)), -1, PALETTES.dark, 336))
  expect(Math.max(...twelve.map(c => c.x + c.width))).toBeGreaterThan(300)
})

test('the top of each column is rounded, drawn as a clip so the segment rects keep their true heights', () => {
  const src = dollarsSvg([grp(1, 0.5, 0.2, 0.1)], -1, PALETTES.light, 336)
  expect(src).toContain('<clipPath id="col0">')
  expect(src).toContain('<g clip-path="url(#col0)">')
  wellFormed(src)
})

test('the empty Dollars chart is text, not an SVG', async ($, on) => {
  on('state.get', (_, e) => stored(live({ groups: [], compactAt: null }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgSource(ui, /^Dollars per step/)).toBe('')
  expect(await ui.find({ type: 'Text', text: 'no steps yet' })).toBeDefined()
  await ui.unmount()
})

test('terminal: four rows of block cells, bottom-aligned, with the /compact line before the right column', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const runs = (await ui.findAll({ type: 'Text' })).filter(t => t.props.mono === true && t.props.dimColor !== true && /^[█┊ ]+$/.test(t.text))
  const cells = runs.flatMap(r => [...r.text].map(ch => ({ ch, color: r.props.color })))
  expect(cells.length % 4).toBe(0)
  const width = cells.length / 4
  const grid = [0, 1, 2, 3].map(r => cells.slice(r * width, (r + 1) * width))

  // 10 columns of 3 cells (2 wide + 1 gap) and the marker before the 8th
  expect(width).toBe(1 + 30)
  for (let x = 0; x < width; x++) {
    const filled = grid.map(row => row[x]?.ch !== ' ').map(Boolean)
    expect(`${filled.join(',')},`).toMatch(/^(false,)*(true,)*$/) // no filled cell above an empty one
  }
  expect(grid.map(row => [row[21]?.ch, row[21]?.color])).toEqual([['┊', 'error'], ['┊', 'error'], ['┊', 'error'], ['┊', 'error']])
  // step 7 (cells 18-19): 0.38 of the $0.4 top is all 4 rows. The re-read part (0.30) takes three;
  // new and answer (0.04 each) are too small for a cell of their own, and the last cell goes to one of them
  expect(grid.map(row => row[18]?.color)).toEqual(['warning', 'merged', 'merged', 'merged'])
  expect(await ui.find({ type: 'Text', text: '$0.4' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: '/compact' })).length).toBe(1)
  // the terminal draws no Svg and no empty text run
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  for (const t of await ui.findAll({ type: 'Text' })) expect(t.text).not.toBe('')
  await ui.unmount()
})

test('terminal: a column where two parts are really equal still shows both', async ($, on) => {
  const groups = [grp(1, 0.3, 0.3, 0.3), grp(2, 0.3, 0.3, 0.3)]
  on('state.get', (_, e) => stored(live({ groups, compactAt: null }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const runs = (await ui.findAll({ type: 'Text' })).filter(t => t.props.mono === true && t.props.dimColor !== true && /^[█┊ ]+$/.test(t.text))
  const colours = runs.map(r => r.props.color)
  expect(colours).toEqual(expect.arrayContaining(['merged', 'warning', 'success']))
  await ui.unmount()
})

test('x axis (terminal): step 1 under the first column, its range under the last, middle labels only with room', async ($, on) => {
  const groups = [grp(1, 0.1, 0.1, 0.1), ...Array.from({ length: 11 }, (_, i) => grp(2 + 43 * i, 1 + i * 0.1, 0.2, 0.1, 1 + 43 * (i + 1)))]
  const data = live({ groups, groupSize: 43, compactAt: null })
  const last = `${groups[11]?.fromStep}–${groups[11]?.toStep}`
  const mid = `${groups[5]?.fromStep}–${groups[5]?.toStep}`
  on('state.get', (_, e) => stored(data, e))
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: '1' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: last })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: mid })).toBeUndefined()
  await narrow.unmount()
  const wide = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  expect(await wide.find({ type: 'Text', text: '1' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: last })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: mid })).toBeDefined()
  await wide.unmount()
})

test('x axis (SVG): a label under every column when each has 28 px, else first, middle and last', async ($, on) => {
  const groups = [grp(1, 0.1, 0.1, 0.1), ...Array.from({ length: 11 }, (_, i) => grp(2 + 43 * i, 1 + i * 0.1, 0.2, 0.1, 1 + 43 * (i + 1)))]
  on('state.get', (_, e) => stored(live({ groups, groupSize: 43, compactAt: null }), e))
  const labelsAt = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    const src = await svgSource(ui, /^Dollars per step/)
    await ui.unmount()
    wellFormed(src)

    return [...src.matchAll(/<text [^>]*text-anchor="middle">([^<]*)<\/text>/g)].map(m => m[1])
  }
  const all = groups.map(g => (g.fromStep === g.toStep ? `${g.fromStep}` : `${g.fromStep}–${g.toStep}`))
  const narrow = await labelsAt(44) // 24 px a column
  expect([...narrow].sort()).toEqual(['1', all[5], all[11]].sort())
  expect(narrow).not.toContain(all[2])
  const wide = await labelsAt(120) // 48 px a column
  expect(wide).toEqual(all)
})

test('/compact is drawn once, even when the pane is too narrow for it under the chart', async ($, on) => {
  const groups = [grp(1, 0.1, 0.1, 0.1), ...Array.from({ length: 11 }, (_, i) => grp(2 + 43 * i, 1, 0.2, 0.1, 1 + 43 * (i + 1)))]
  on('state.get', (_, e) => stored(live({ groups, groupSize: 43, compactAt: 300 }), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [18, 30, 44, 120]) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns } })
      if (surface === 'terminal') expect((await ui.findAll({ type: 'Text', text: '/compact' })).length).toBe(1)
      else {
        const src = await svgSource(ui, /^Dollars per step/)
        wellFormed(src)
        expect(src.match(/>\/compact</g)).toHaveLength(1)
        // the pill stays inside the picture
        const pill = elements(src, 'rect').find(r => r.rx === '8')
        expect(num(pill?.x)).toBeGreaterThanOrEqual(0)
        expect(num(pill?.x) + num(pill?.width)).toBeLessThanOrEqual((bodyColumns >= 18 ? Math.max(16, Math.min(120, bodyColumns - 2)) : 16) * 8)
      }
      await noControlText(ui)
      await ui.unmount()
    }
  }
})

test('with no steps yet the chart says so', async ($, on) => {
  on('state.get', (_, e) => stored(live({ groups: [], compactAt: null }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'no steps yet' })).toBeDefined()
  await ui.unmount()
})

test('a meter-4 value, from before the chart, reads as empty', async ($, on) => {
  on('state.get', () => ({ value: { version: 1, value: { shape: 'meter-4', value: { ...live(), steps: [{ bucket: 'opus-main', usd: 1, out: 1 }] } } } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '$0.00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$3\.40/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'no steps yet' })).toBeDefined()
  await ui.unmount()
})

test('only main-thread steps reach the chart: a subagent step books spend but no column', async ($, on) => {
  const box = memory(on, JSON.parse(JSON.stringify(live({ groups: [], groupSize: 1, compactAt: null, costCursor: 1 }))))
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  let spent = 1
  on('session.usage', () => usageAt(spent))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'i1' }))
  on('turn.step', async function* (_, e) {
    spent += e.agentId === undefined ? 0.1 : 0.3

    return stepResult(e, e.agentId === undefined ? 'claude-opus-5-5' : 'claude-sonnet-5-5')
  })
  await $.agent.spawn({ ...spawnInput, subagentType: 'implementer', model: 'sonnet' })
  for (const id of [undefined, 'i1', 'i1', undefined]) await bookStep($, id)

  const now = box.value as unknown as MeterData
  expect(now.groups.map(g => [g.fromStep, g.toStep])).toEqual([[1, 1], [2, 2]]) // two main steps, not four
  expect(near(sum(now.groups, 'readUsd') + sum(now.groups, 'newUsd') + sum(now.groups, 'answerUsd'), 0.2)).toBe(true) // the main steps' own cost
  expect(near(now.spend.sonnet, 0.92 + 0.6)).toBe(true) // the fixture's 0.92 plus the agent's two steps
})

test('booking steps onto a full set of columns keeps 12 or fewer, covering every step', async ($, on) => {
  const full = fillGroups(12)
  const box = memory(on, JSON.parse(JSON.stringify(live({ ...full, compactAt: 3, costCursor: 4 }))))
  stepSetup(on)
  for (let i = 0; i < 30; i++) await bookStep($)
  const now = box.value as unknown as MeterData
  expect(now.groups.length).toBeLessThanOrEqual(12)
  expect(covers(now.groups, 42)).toBe(true)
  expect(now.compactAt).toBe(3) // a step number: merging columns does not move it
  expect(sane(now)).toEqual(now)
})

// -- Context gauge labels -------------------------------------------------------
test('350k and 500k are centred on their marks', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const width = 42 // bodyColumns 44 minus the pane's two cells
  const at350 = Math.round((350_000 / 600_000) * width)
  const at500 = Math.round((500_000 / 600_000) * width)

  // terminal: one monospace row as wide as the bar
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = (await term.findAll({ type: 'Text' })).find(t => t.props.mono === true && t.text.includes('350k'))
  expect(row?.text).toHaveLength(width)
  expect(row?.text.indexOf('350k')).toBe(at350 - 2)
  expect(row?.text.indexOf('500k')).toBe(at500 - 2)
  await term.unmount()

  // desktop: the SVG's labels are centred (text-anchor middle) on the tick lines
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui, /^Context/)
  await ui.unmount()
  wellFormed(src)
  const px = width * 8
  const ticks = elements(src, 'line').map(l => num(l.x1))
  expect(ticks).toEqual([(350_000 / 600_000) * px, (500_000 / 600_000) * px])
  for (const [i, text] of ['350k', '500k'].entries()) {
    const label = [...src.matchAll(/<text x="([^"]*)"[^>]*text-anchor="middle">([^<]*)<\/text>/g)].find(m => m[2] === text)
    expect(num(label?.[1])).toBe(ticks[i])
  }

  expect(labelStart(25, 4, 42)).toBe(23)
  expect(labelStart(1, 4, 42)).toBe(0) // kept inside the row
  expect(labelStart(41, 4, 42)).toBe(38)
  expect(labelRow(10, [{ at: 5, text: 'ab' }])).toBe('    ab    ')
})

test('the gauge fills to the tokens and is green under 350k, amber to 500k, red above', () => {
  const fillOf = (tokensNow: number) => {
    const bar = elements(gaugeSvg(tokensNow, PALETTES.light, 300), 'rect').find(r => r['clip-path'] !== undefined)

    return { fill: bar?.fill, width: num(bar?.width) }
  }
  expect(fillOf(142_000)).toEqual({ fill: '#55A06A', width: 71 })
  expect(fillOf(349_999).fill).toBe('#55A06A')
  expect(fillOf(350_000).fill).toBe('#DDA65A')
  expect(fillOf(500_000).fill).toBe('#DDA65A')
  expect(fillOf(500_001).fill).toBe('#B0412E')
  expect(fillOf(900_000)).toMatchObject({ fill: '#B0412E', width: 300 }) // never wider than the bar
  expect(elements(gaugeSvg(0, PALETTES.light, 300), 'rect').filter(r => r['clip-path'] !== undefined)).toHaveLength(0)
  expect(elements(gaugeSvg(142_000, PALETTES.light, 300), 'rect')[1]?.rx).toBe('5') // the track is a rounded bar
})

test('the bars are 6 px tall and rounded, with 1 px between segments and widths in true proportion', () => {
  const src = barSvg([{ color: '#D97757', value: 1 }, { color: '#3B82D6', value: 3 }], PALETTES.dark, 400)
  wellFormed(src)
  const segs = elements(inner(src), 'rect')
  expect(segs.map(r => num(r.height))).toEqual([6, 6])
  expect(num(segs[0]?.x)).toBe(0)
  expect(num(segs[0]?.width)).toBe(99) // a quarter of 400, less the 1 px gap
  expect(num(segs[1]?.x)).toBe(100)
  expect(num(segs[1]?.x) + num(segs[1]?.width)).toBe(400)
  expect(elements(src, 'rect')[1]?.rx).toBe('3') // the track is rounded
  // nothing to share out: only the track
  expect(elements(inner(barSvg([], PALETTES.dark, 400)), 'rect')).toHaveLength(0)
  expect(elements(barSvg([{ color: '#fff', value: Number.NaN }], PALETTES.dark, 400), 'rect')).toHaveLength(2) // clip + track
})

test('the cache ring shows the fraction of the TTL left', () => {
  const circumference = 2 * Math.PI * 11
  const arc = (fraction: number) => elements(ringSvg(fraction, '#55A06A', PALETTES.light), 'circle').find(c => c['stroke-dasharray'] !== undefined)
  expect(Math.abs(num(arc(0.5)?.['stroke-dasharray']?.split(' ')[0]) - circumference / 2) < 0.01).toBe(true)
  expect(arc(0)).toBeUndefined() // a cold cache: the track only
  expect(elements(ringSvg(0.7, undefined, PALETTES.light), 'circle')).toHaveLength(1) // no call yet: the track only
  expect(Math.abs(num(arc(7)?.['stroke-dasharray']?.split(' ')[0]) - circumference) < 0.01).toBe(true) // clamped to a full ring
  expect(arc(Number.NaN)).toBeUndefined()
})

test('the cache ring label takes the state colour of every palette, text colour when there is no state colour', () => {
  for (const pal of [PALETTES.light, PALETTES.dark, PALETTES.neutral]) {
    for (const hex of [pal.ok, pal.warn, pal.bad]) {
      const t = elements(ringSvg(0.5, hex, pal, undefined, '9'), 'text')[0]
      expect(t?.fill).toBe(hex)
      expect(num(t?.['font-size'])).toBeGreaterThanOrEqual(11)
      expect(num(t?.['font-size'])).toBeLessThanOrEqual(12)
    }
    expect(elements(ringSvg(0.5, undefined, pal, undefined, '9'), 'text')[0]?.fill).toBe(pal.text)
  }
})

const agentRun = (id: string, name: string, model: string, bucket: 'haiku' | 'sonnet' | 'opus-checks', read: number, written: number, usd: number, status: 'running' | 'done' | 'failed' = 'done') =>
  ({ id, name, model, bucket, read, written, usd, status, startedAt: NOW - 20 * MIN, endedAt: status === 'running' ? null : NOW - 10 * MIN, warned: false })

test('agent runs fold into one row per type and model, with summed tokens and dollars', () => {
  const rows = groupAgents([
    agentRun('i1', 'implementer', 'Sonnet', 'sonnet', 5_000_000, 50_000, 1.2),
    agentRun('s1', 'scout', 'Haiku', 'haiku', 40_000, 900, 0.06),
    agentRun('i2', 'implementer', 'Sonnet', 'sonnet', 4_500_000, 45_000, 1.0),
    agentRun('i3', 'implementer', 'Sonnet', 'sonnet', 3_000_000, 40_000, 0.52),
  ])
  expect(rows.map(r => `${r.name}/${r.model}/${r.runs}`)).toEqual(['implementer/Sonnet/3', 'scout/Haiku/1'])
  expect(agentRowText(rows[0] as never)).toBe('implementer · Sonnet · 3 runs · 12.5M read · 135k written · ≈$2.72')
  expect(agentRowText(rows[1] as never)).toBe('scout · Haiku · 40k read · 900 written · ≈$0.06') // one run: no runs part
})

test('the same agent type on two models stays two rows; a running run marks its row; rows sort by dollars', () => {
  const rows = groupAgents([
    agentRun('v1', 'verifier', 'Sonnet', 'sonnet', 100_000, 5_000, 0.3),
    agentRun('v2', 'verifier', 'Opus', 'opus-checks', 200_000, 9_000, 1.5, 'running'),
    agentRun('v3', 'verifier', 'Opus', 'opus-checks', 100_000, 1_000, 0.5),
    agentRun('x1', 'scout', 'Haiku', 'haiku', 1_000, 10, 0.9, 'failed'),
  ])
  expect(rows.map(r => `${r.name}/${r.model}`)).toEqual(['verifier/Opus', 'scout/Haiku', 'verifier/Sonnet'])
  expect(rows.map(r => r.usd)).toEqual([2, 0.9, 0.3])
  expect(agentRowText(rows[0] as never)).toMatch(/verifier · Opus · 2 runs · .* · ≈\$2\.00 · running$/)
  expect(agentRowText(rows[1] as never)).toMatch(/ · stopped$/)
  expect(agentRowText(rows[2] as never)).not.toMatch(/running|stopped/)
  // A partly failed group says how many stopped, and a control character in a name never reaches the row.
  const mixed = groupAgents([agentRun('m1', 'a\u001bb', 'Opus', 'opus-checks', 1, 1, 1, 'failed'), agentRun('m2', 'a\u001bb', 'Opus', 'opus-checks', 1, 1, 1)])
  expect(agentRowText(mixed[0] as never)).toBe('a b · Opus · 2 runs · 2 read · 2 written · ≈$2.00 · 1 stopped')
})

test('the pane draws one row per agent type and model, on terminal and desktop', async ($, on) => {
  on(
    'state.get',
    (_, e) =>
      stored(
        live({
          agents: [
            agentRun('i1', 'implementer', 'Sonnet', 'sonnet', 5_000_000, 50_000, 1.2),
            agentRun('s1', 'scout', 'Haiku', 'haiku', 40_000, 900, 0.06),
            agentRun('i2', 'implementer', 'Sonnet', 'sonnet', 4_500_000, 45_000, 1.0),
            agentRun('i3', 'implementer', 'Sonnet', 'sonnet', 3_000_000, 40_000, 0.52, 'running'),
          ],
        }),
        e,
      ) as never,
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /implementer · Sonnet · 3 runs · 12\.5M read · 135k written · ≈\$2\.72 · running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scout · Haiku · 40k read · 900 written · ≈\$0\.06/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /implementer · Sonnet · 5\.0M read/ })).toBeUndefined() // no per-run row
    await ui.unmount()
  }
})

test('the cache ring is 28 px with a 4 px stroke and the minutes left inside it', () => {
  const src = ringSvg(0.5, '#55A06A', PALETTES.light, undefined, '41')
  expect(src).toContain('width="28" height="28" viewBox="0 0 28 28"')
  expect(elements(src, 'circle').map(c => c['stroke-width'])).toEqual(['4', '4'])
  expect(elements(src, 'circle')[0]?.r).toBe('11')
  const text = elements(src, 'text')
  expect(text).toHaveLength(1)
  expect(text[0]?.['font-size']).toBe('11')
  expect(text[0]?.['font-weight']).toBe('600')
  expect(text[0]?.fill).toBe('#55A06A') // the ring's own state colour, not the palette's text
  expect(text[0]?.['dominant-baseline']).toBe('central')
  expect(text[0]?.['text-anchor']).toBe('middle')
  expect(text[0]?.y).toBe('14')
  expect(text[0]?.x).toBe('14')
  expect(src).toContain('>41<')
  // no label, no text; a label is cleaned and escaped like any SVG text
  expect(ringSvg(0.5, '#55A06A', PALETTES.light)).not.toContain('<text')
  expect(ringSvg(0.5, '#55A06A', PALETTES.light, undefined, '<a&\n>')).toContain('>&lt;a&amp; &gt;<')
})

const ringText = async ($: Engine, on: On, data: Partial<MeterData>) => {
  on('state.get', (_, e) => stored(live(data), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui, /^Cache/)
  await ui.unmount()

  return src
}
test('the cache ring draws the minutes left inside it while warm', async ($, on) => {
  const src = await ringText($, on, { lastResponseAt: NOW - 19 * MIN }) // 1 hour TTL: 41 min left
  expect(elements(src, 'text')).toHaveLength(1)
  expect(src).toContain('>41<')
  expect(src).toContain('width="28" height="28"')
})
test('a cold cache ring is the empty track with a small x', async ($, on) => {
  const src = await ringText($, on, { lastResponseAt: NOW - 90 * MIN })
  expect(src).toContain('>×<')
  expect(elements(src, 'circle')).toHaveLength(1)
})
test('no call yet: the empty track, nothing inside', async ($, on) => {
  const src = await ringText($, on, { lastResponseAt: null })
  expect(elements(src, 'circle')).toHaveLength(1)
  expect(src).not.toContain('<text')
})

const warmRing = async ($: Engine, on: On, data: Partial<MeterData>) => {
  on('state.get', (_, e) => stored(live(data), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui, /^Cache/)
  await ui.unmount()

  return elements(src, 'circle').find(c => c['stroke-dasharray'] !== undefined)?.stroke
}
test('the cache ring is green while warm, amber while cooling, and empty when cold', async ($, on) => {
  expect(await warmRing($, on, { lastResponseAt: NOW - 19 * MIN })).toBe('#55A06A')
})
test('the cache ring turns amber in the last 10 minutes', async ($, on) => {
  expect(await warmRing($, on, { lastResponseAt: NOW - 55 * MIN })).toBe('#DDA65A')
})
test('a cold cache draws the track only', async ($, on) => {
  expect(await warmRing($, on, { lastResponseAt: NOW - 90 * MIN })).toBeUndefined()
})

// -- SVG safety ------------------------------------------------------------------
test('XML-escape: & < > " \' all become entities', () => {
  expect(esc(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  expect(esc('plain 123')).toBe('plain 123')
})

// Realistic: 12 columns, a /compact at 7, the read share rising from 40% to 80% then dropping after it.
const sample = (): MeterGroup[] =>
  Array.from({ length: 12 }, (_, i) => {
    const total = 0.04 + 0.02 * (i % 4)
    const share = i < 7 ? 0.4 + (0.4 * i) / 6 : 0.15 + 0.05 * (i - 7)

    return grp(i + 1, total * share, total * (1 - share) * 0.7, total * (1 - share) * 0.3)
  })

test('every chart is well-formed in all three palettes, and uses only its own palette', () => {
  const colours = { light: ['#374151', '#E5E7EB'], dark: ['#D1D5DB', '#374151'], neutral: ['#8B9099', '#8B9099'] } as const
  for (const name of ['light', 'dark', 'neutral'] as const) {
    const pal = PALETTES[name]
    const sources = [
      dollarsSvg(sample(), 7, pal, 336),
      gaugeSvg(420_000, pal, 336),
      barSvg([{ color: pal.before, value: 1 }, ...(Object.values(pal.bucket).map(color => ({ color, value: 2 })))], pal, 336),
      ringSvg(0.6, pal.ok, pal),
    ]
    for (const src of sources) {
      wellFormed(src)
      expect(src.length).toBeLessThan(131_072)
      expect(src).not.toMatch(/<script|on[a-z]+=|href=|<image|<foreignObject/i)
      expect(src).toContain(colours[name][1]) // its own grid / track
      for (const other of ['light', 'dark'] as const) if (other !== name) for (const c of colours[other]) if (!colours[name].includes(c as never)) expect(src).not.toContain(c)
    }
    expect(sources[0]).toContain(colours[name][0]) // its own label text
  }
  // the grid of the neutral palette is see-through, the others are solid
  expect(dollarsSvg(sample(), 7, PALETTES.neutral, 336)).toContain('stroke-opacity="0.33"')
  expect(dollarsSvg(sample(), 7, PALETTES.dark, 336)).toContain('stroke-opacity="1"')
})

test('no chart draws a background: the page behind shows through', () => {
  for (const src of [dollarsSvg(sample(), 7, PALETTES.dark, 336), gaugeSvg(1, PALETTES.dark, 336)]) {
    expect(src).not.toMatch(/<rect [^>]*width="336"[^>]*height="180"/)
    expect(src).not.toMatch(/style=/)
  }
})

test('degenerate data still draws a well-formed SVG: NaN, negative, huge, one column, a marker past the end', () => {
  const odd = [grp(1, Number.NaN, -1, 1e9), grp(2, 0, 0, 0)]
  wellFormed(dollarsSvg(odd, -1, PALETTES.light, 336))
  wellFormed(dollarsSvg(odd, 5, PALETTES.light, 336))
  wellFormed(dollarsSvg([grp(1, 0, 0, 0)], 0, PALETTES.light, 40))
  wellFormed(dollarsSvg([grp(1, 0.1, 0.1, 0.1)], -1, PALETTES.light, 336))
  wellFormed(gaugeSvg(Number.NaN, PALETTES.light, 336))
  wellFormed(ringSvg(Number.NaN, '#fff', PALETTES.light))
  expect(dollarsSvg(odd, -1, PALETTES.light, 336)).not.toMatch(/NaN|Infinity|undefined/)
  expect(gaugeSvg(Number.NaN, PALETTES.light, 336)).not.toMatch(/NaN|Infinity|undefined/)
})

test('every drawn Svg carries alt text and its size in pixels', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await ui.findAll({ type: 'Svg' })
  expect(all).toHaveLength(5) // gauge, cache ring, cost bar, tokens bar, dollars
  for (const s of all) {
    expect(String(s.props.alt).length).toBeGreaterThan(5)
    expect(typeof s.props.width).toBe('number')
    expect(typeof s.props.height).toBe('number')
    wellFormed(String(s.props.source))
  }
  expect(all.map(s => s.props.height)).toEqual([32, 28, 6, 6, 180])
  await ui.unmount()
})

for (const surface of ['vscode', 'mobile'] as const) {
  test(`${surface} draws the SVG charts too`, async ($, on) => {
    on('state.get', (_, e) => stored(live(), e))
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(5)
    await ui.unmount()
  })
}

// -- The person's theme --------------------------------------------------------------
test('the palette follows the theme row: dark, light, anything else neutral', () => {
  expect(['dark', 'dark-daltonized', 'dark-ansi', 'DARK'].map(t => paletteFor(t).name)).toEqual(['dark', 'dark', 'dark', 'dark'])
  expect(['light', 'light-daltonized', 'light-ansi'].map(t => paletteFor(t).name)).toEqual(['light', 'light', 'light'])
  expect(['auto', 'system', 'solarized', '', undefined, null, 5].map(t => paletteFor(t).name)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral', 'neutral', 'neutral'])
})

// each palette has one colour no other has: dark's text, light's grid; neutral has neither
const THEMES: [string | undefined, 'dark' | 'light' | 'neutral'][] = [
  ['dark', 'dark'],
  ['dark-daltonized', 'dark'],
  ['light', 'light'],
  ['light-ansi', 'light'],
  ['auto', 'neutral'],
  ['solarized', 'neutral'],
  [undefined, 'neutral'], // no `config.list` answer at all
]
for (const [theme, name] of THEMES) {
  test(`theme ${theme ?? 'unreadable'} draws the ${name} palette on every chart`, async ($, on) => {
    on('state.get', (_, e) => stored(live(), e))
    if (theme !== undefined) themeRow(on, theme)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const own = { dark: '#D1D5DB', light: '#E5E7EB', neutral: '#8B9099' }[name]
    const others = (['#D1D5DB', '#E5E7EB', '#8B9099'] as const).filter(c => c !== own)
    // the ring and the bars have a track (grid colour) and no label; the gauge and the Dollars chart have both
    for (const [alt, hasLabels] of [[/^Context/, true], [/^Cache/, false], [/^Cost/, false], [/^Tokens written/, false], [/^Dollars per step/, true]] as const) {
      const src = await svgSource(ui, alt)
      expect(src.length).toBeGreaterThan(100)
      expect(src).toContain(name === 'dark' && !hasLabels ? '#374151' : own)
      for (const c of others) if (!(name === 'dark' && c === '#E5E7EB')) expect(src).not.toContain(c)
      if (name === 'dark') expect(src).not.toContain('#E5E7EB')
    }
    await ui.unmount()
  })
}

test('/meter reads the theme again, and a theme change from /config redraws the pane without being denied or changed', async ($, on) => {
  let theme = 'light'
  let asked = 0
  on('config.list', () => (asked++, { value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: { plugin: 'engine', tier: 'core' } as const, isLocked: false }] }))
  on('state.get', (_, e) => stored(live(), e))
  on('state.set', () => ({ value: { isSet: true as const, version: 2 } }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 142_000, window: 1_000_000, percent: 14 }, rateLimits: [], cost: { usd: 3.4 } } }))
  let setAnswer: (e: { value: unknown }) => { value: unknown } | { deny: string } = e => ({ value: e.value })
  on('config.set', (_, e) => setAnswer(e) as never)
  quiet(on)
  mock.clock(on, { now: NOW })
  const textOf = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const src = await svgSource(ui, /^Context/)
    await ui.unmount()

    return src.includes('#D1D5DB') ? 'dark' : src.includes('#E5E7EB') ? 'light' : 'neutral' // each palette's own colour
  }
  expect(await textOf()).toBe('light')

  theme = 'dark'
  expect(await textOf()).toBe('light') // cached: the pane does not ask on every draw
  const ran = await $.command.run({ command: 'meter', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  void ran
  expect(asked).toBe(2) // once for the first draw, once for /meter; never per draw
  expect(await textOf()).toBe('dark')

  // a /config change: noticed from the event itself, and passed on exactly as it came
  const changed = { key: 'theme', value: 'light-ansi', previous: 'dark', provider: { plugin: 'engine', tier: 'core' } as const, origin: { kind: 'composer' } as const }
  expect(await $.config.set(changed)).toEqual({ value: 'light-ansi' })
  expect(await textOf()).toBe('light')

  // refused beneath us: the answer is the refusal, and the palette stays
  setAnswer = () => ({ deny: 'locked by policy' })
  expect(await $.config.set({ ...changed, value: 'dark' })).toEqual({ deny: 'locked by policy' })
  expect(await textOf()).toBe('light')
})

test('theme: Box and Text stay on theme keys; only the SVG and the legend that names it carry hex', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  themeRow(on, 'dark')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const hex = /^#[0-9A-Fa-f]{6}$/
  const colours = (await ui.findAll({ type: 'Text' })).map(t => t.props.color).filter((c): c is string => typeof c === 'string')
  // the swatches ('■') and the agent dots ('●' beside an agent row) are the only hex colours
  const hexTexts = (await ui.findAll({ type: 'Text' })).filter(t => typeof t.props.color === 'string' && hex.test(t.props.color))
  expect(hexTexts.length).toBeGreaterThan(0)
  for (const t of hexTexts) expect(['■', '●']).toContain(t.text)
  expect(colours).toContain('success') // big numbers and the PR row keep theme keys
  await ui.unmount()
})

// -- The tracked PRs have their own atom ---------------------------------------------------
test('the tracked PRs survive a bump of the data tag: they are in their own atom', async ($, on) => {
  const { ci, ...rest } = live()
  // `data` stored under an OLD tag (as after a MeterData change); `ci` under its own, current tag
  on('state.get', (_, e) =>
    e.key === 'ci' ? { value: { version: 1, value: { shape: 'ci-1', value: ci } } } : { value: { version: 1, value: { shape: 'meter-5', value: rest } } },
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Link', text: /#7/ })).toBeDefined() // the PR is still there
  expect(await ui.find({ type: 'Text', text: 'fix: the Blue onboarding fixes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$3\.40/ })).toBeUndefined() // while the old data reads as empty
  expect(await ui.find({ type: 'Text', text: 'no steps yet' })).toBeDefined()
  await ui.unmount()
})

test('a PR is written to the ci atom (key ci, shape ci-1) and a data write never touches it', async ($, on) => {
  const writes: { key: string; shape: unknown }[] = []
  const box = { data: JSON.parse(JSON.stringify(sane({}))) as unknown, ci: [] as unknown, version: 1 }
  on('state.get', (_, e) =>
    e.key === 'ci' ? { value: { version: box.version, value: { shape: 'ci-1', value: box.ci } } } : { value: { version: box.version, value: { shape: 'meter-6', value: box.data } } },
  )
  on('state.set', (_, e) => {
    writes.push({ key: e.key, shape: (e.value as { shape?: unknown }).shape })
    const written = (e.value as { value: unknown }).value
    if (e.key === 'ci') box.ci = written
    else box.data = written
    box.version++

    return { value: { isSet: true as const, version: box.version } }
  })
  quiet(on)
  const clock = mock.clock(on, { now: NOW })
  on('process.run', () => gh('[]'))
  on('tool.call', () => ({ result: {}, text: `Created ${PR_URL_7}\n` }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => usageAt(4))
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-opus-5-5')
  })

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(5)
  const rows = box.ci as MeterPr[]
  expect(rows.map(r => r.url)).toEqual([PR_URL_7])
  expect(writes.filter(w => w.key === 'ci').every(w => w.shape === 'ci-1')).toBe(true)
  expect(writes.filter(w => w.key === 'data').every(w => w.shape === 'meter-6')).toBe(true)

  const before = writes.filter(w => w.key === 'ci').length
  await bookStep($)
  expect(writes.filter(w => w.key === 'ci')).toHaveLength(before) // a booked step writes data only
  expect((box.data as Record<string, unknown>).ci).toBeUndefined()
  expect((box.ci as MeterPr[]).map(r => r.url)).toEqual([PR_URL_7])
})

test('a broken ci atom is repaired: junk is empty, bad rows go, a row missing fields still draws', async ($, on) => {
  const good = pr()
  const { failing: _failing, ...noFailing } = good
  void _failing
  const box = memory(on, JSON.parse(JSON.stringify(sane({}))), [noFailing, { url: 'https://evil.example/x' }, 5, null])
  quiet(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Link', text: /#7/ })).toBeDefined()
  await ui.unmount()
  expect(box.ci).toEqual([noFailing, { url: 'https://evil.example/x' }, 5, null]) // drawing does not write
  expect(sanePrs(box.ci)).toHaveLength(1)
  expect(sanePrs(box.ci)[0]?.failing).toEqual([])
  expect(sanePrs('junk')).toEqual([])
  expect(sanePrs(Array.from({ length: 20 }, (_, i) => ({ ...good, url: `https://github.com/a/b/pull/${i + 1}` })))).toHaveLength(8)
})

test('with no PRs the GitHub list says what shows up there', async ($, on) => {
  on('state.get', (_, e) => stored(live({ ci: [] }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PRs this session opens, views or merges show up here' })).toBeDefined()
  await ui.unmount()
})

// -- The fixes from the last review -----------------------------------------------------------
test('splitCost: with no tokens at all the whole cost is "new", so the parts still add up', () => {
  const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  expect(splitCost(1, zero, '1h')).toEqual({ readUsd: 0, newUsd: 1, answerUsd: 0 })
  expect(splitCost(0.37, zero, '5m')).toEqual({ readUsd: 0, newUsd: 0.37, answerUsd: 0 })
  // without the zero-denominator guard this is NaN / NaN / NaN
  const parts = splitCost(2.5, { ...zero, input_tokens: -5, output_tokens: Number.NaN }, '1h')
  expect(Object.values(parts).every(Number.isFinite)).toBe(true)
  expect(parts.readUsd + parts.newUsd + parts.answerUsd).toBe(2.5)
  // no cost: nothing to share, whatever the tokens
  expect(splitCost(0, USAGE, '1h')).toEqual({ readUsd: 0, newUsd: 0, answerUsd: 0 })
  expect(splitCost(Number.NaN, USAGE, '1h')).toEqual({ readUsd: 0, newUsd: 0, answerUsd: 0 })
  expect(splitCost(Infinity, USAGE, '1h')).toEqual({ readUsd: 0, newUsd: 0, answerUsd: 0 })
})

test('a step with cost but no usage counts is booked whole as "new"', async ($, on) => {
  const box = memory(on, JSON.parse(JSON.stringify(sane({ costCursor: 1 }))))
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => usageAt(1.25))
  on('turn.step', async function* (_, e) {
    return { ...stepResult(e, 'claude-opus-5-5'), usage: { ...usageOf('claude-opus-5-5'), input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }
  })
  await bookStep($)
  const now = box.value as unknown as MeterData
  expect(now.groups).toHaveLength(1)
  expect(near(now.groups[0]?.newUsd ?? 0, 0.25)).toBe(true)
  expect(now.groups[0]?.readUsd).toBe(0)
  expect(now.groups[0]?.answerUsd).toBe(0)
})

test('niceTop is 1 when the result is not finite or is 0', () => {
  expect([niceTop(Number.NaN), niceTop(Infinity), niceTop(-3), niceTop(5e-324), niceTop(Number.MAX_VALUE)]).toEqual([1, 1, 1, 1, 1])
  expect(niceTop(0.37)).toBe(0.4)
})

test('a stored groupSize is capped at the biggest column it could have made', () => {
  const columns = [grp(1, 1, 0, 0), grp(2, 1, 0, 0, 3), grp(4, 1, 0, 0, 5), grp(6, 1, 0, 0, 7)]
  expect(sane({ groups: columns, groupSize: 1_000_000_000 }).groupSize).toBe(2) // second and last column are 2 steps
  expect(sane({ groups: columns, groupSize: 2 }).groupSize).toBe(2)
  expect(sane({ groups: columns, groupSize: 1 }).groupSize).toBe(2) // never below the second column's size
  expect(sane({ groups: [grp(1, 1, 0, 0)], groupSize: 99 }).groupSize).toBe(1)
  expect(sane({ groups: [], groupSize: 99 }).groupSize).toBe(1)
  // a last column bigger than the second one raises the cap to its size
  expect(sane({ groups: [grp(1, 1, 0, 0), grp(2, 1, 0, 0), grp(3, 1, 0, 0, 5)], groupSize: 1_000_000 }).groupSize).toBe(3)
})

// ---------------------------------------------------------------------------
// Hardening: a stored value is never trusted, outside text never reaches the tree
// ---------------------------------------------------------------------------
/**
 * An in-memory `state` for both atoms (`data` under `meter-6`, `ci` under `ci-1`),
 * so a hook's write can be read back: `box.value` is the data, `box.ci` the PR rows.
 */
const memory = (on: On, initial: unknown, ciInitial: unknown = []) => {
  const box = { value: initial as Record<string, unknown>, ci: ciInitial as unknown, version: 1 }
  on('state.get', (_, e) =>
    e.key === 'ci'
      ? { value: { version: box.version, value: { shape: 'ci-1', value: box.ci } } }
      : { value: { version: box.version, value: { shape: 'meter-6', value: box.value } } },
  )
  on('state.set', (_, e) => {
    const written = (e.value as { value: unknown }).value
    if (e.key === 'ci') box.ci = written
    else box.value = written as Record<string, unknown>
    box.version++

    return { value: { isSet: true as const, version: box.version } }
  })

  return box
}

const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

/** Every Text on the pane is free of control characters. */
const noControlText = async (ui: Tree) => {
  for (const t of await ui.findAll({ type: 'Text' })) expect(CONTROL_TEXT.test(t.text)).toBe(false)
}

/** Hooks beneath the plugin for a test that books steps; call before the first `$`. */
const stepSetup = (on: On, model = 'claude-opus-5-5') => {
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => usageAt(4))
  on('turn.step', async function* (_, e) {
    return stepResult(e, model)
  })
}
/** Books one step: the main thread's, or an agent's when `agentId` is given. */
const bookStep = async ($: Engine, agentId?: string) => {
  for await (const _ of $.turn.step(stepInput(agentId))) void _
}

const MISSING: [string, (d: Record<string, unknown>) => void][] = [
  ['spend', d => delete d.spend],
  ['written', d => delete d.written],
  ['agents', d => delete d.agents],
  ['groups', d => delete d.groups],
  ['groupSize', d => delete d.groupSize],
  ['compactAt', d => delete d.compactAt],
  ['guardLines', d => delete d.guardLines],
  ['costUsd', d => delete d.costUsd],
  ['an agent without usd', d => delete (d.agents as Record<string, unknown>[])[0]?.usd],
  ['a spend bucket', d => delete (d.spend as Record<string, unknown>).haiku],
  ['a NaN group cost', d => ((d.groups as Record<string, unknown>[])[0]!.readUsd = Number.NaN)],
  ['a group with no steps', d => delete (d.groups as Record<string, unknown>[])[2]?.toStep],
]

for (const [what, break_] of MISSING) {
  test(`a meter-6 value missing ${what}: the pane draws and a booked step heals the stored value`, async ($, on) => {
    const { ci: _ci, ...rest } = live()
    void _ci
    const bad = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
    break_(bad)
    const box = memory(on, bad)
    stepSetup(on, what === 'an agent without usd' ? 'claude-haiku-5-5' : 'claude-opus-5-5')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: 'Session cost' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Meter is resetting/ })).toBeUndefined()
      await ui.unmount()
    }

    await bookStep($, what === 'an agent without usd' ? 'a1' : undefined)

    const now = box.value as unknown as MeterData
    expect(Object.keys(now).sort()).toEqual(Object.keys(sane({})).sort())
    expect('ci' in now).toBe(false) // the PRs are not in this atom
    expect(typeof now.costUsd).toBe('number')
    for (const b of ['opus-main', 'haiku', 'sonnet', 'opus-checks'] as const) {
      expect(Number.isFinite(now.spend[b])).toBe(true)
      expect(Number.isFinite(now.written[b])).toBe(true)
    }
    for (const list of [now.agents, now.groups, now.guardLines]) expect(Array.isArray(list)).toBe(true)
    for (const a of now.agents) expect(Number.isFinite(a.usd)).toBe(true)
    for (const g of now.groups) for (const v of [g.readUsd, g.newUsd, g.answerUsd]) expect(Number.isFinite(v)).toBe(true)
    expect(Number.isInteger(now.groupSize) && now.groupSize >= 1).toBe(true)
    if (what !== 'an agent without usd') expect(now.groups.length).toBeGreaterThan(0) // the main step is booked
    expect(sane(now)).toEqual(now) // nothing left to repair
  })
}

test('a stored value that is not an object at all is repaired too', async ($, on) => {
  const box = memory(on, 'garbage')
  stepSetup(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Session cost' })).toBeDefined()
  await ui.unmount()
  await bookStep($)
  expect((box.value as unknown as MeterData).groups).toHaveLength(1)
})

test('if the stored value cannot be read at all, the pane says it is resetting instead of failing', async ($, on) => {
  on('state.get', () => ({ deny: 'store down' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Meter is resetting/ })).toBeDefined()
  await ui.unmount()
})

test('sane keeps a good value as it is and drops only the malformed rows', () => {
  const { ci, ...good } = live()
  expect(sane(good)).toEqual(good)
  expect(sanePrs(ci)).toEqual(ci)
  const mixed = sane({
    ...good,
    agents: [good.agents[0], null, 'x', { id: 7 }, { ...good.agents[1], bucket: 'nope' }],
    groups: [good.groups[0], null, 'x', { fromStep: 'a' }, { fromStep: 5, toStep: 2 }, { fromStep: 1, toStep: 4 }, { fromStep: 2, toStep: 3, readUsd: Number.NaN, newUsd: -1, answerUsd: 0.2 }],
    guardLines: [good.guardLines[0], { kind: 'blocked' }],
  })
  expect(mixed.agents.map(a => a.id)).toEqual(['a1'])
  expect(mixed.groups).toEqual([good.groups[0], grp(2, 0, 0, 0.2, 3)]) // bad rows gone, a repeated step range gone, bad numbers 0
  expect(mixed.groupSize).toBe(2)
  expect(sanePrs([ci[0], { url: 'https://evil.example/x' }, 5, null])).toEqual([ci[0]])
  expect(mixed.guardLines).toHaveLength(1)
})

test('sane heals a broken groups field: junk is empty, too many columns are merged, a bad size is repaired', () => {
  expect(sane({ ...live(), groups: 'junk', groupSize: 'x' })).toMatchObject({ groups: [], groupSize: 1 })
  expect(sane({ ...live(), groups: null }).groups).toEqual([])
  const many = sane({ ...live(), groups: Array.from({ length: 30 }, (_, i) => grp(i + 1, 0.1, 0.1, 0.1)), groupSize: 0 })
  expect(many.groups.length).toBeLessThanOrEqual(12)
  expect(covers(many.groups, 30)).toBe(true)
  expect(many.groupSize).toBeGreaterThan(1)
  expect(near(sum(many.groups, 'readUsd'), 3)).toBe(true)
  expect(sane({ ...live(), groups: [grp(1, 0, 0, 0)], groupSize: -4.5 }).groupSize).toBe(1)
  expect(sane({ ...live(), compactAt: 2.7 }).compactAt).toBe(2)
})

test('a PR title with ESC, BEL, NUL, U+009B, a newline and U+202E still draws, cleaned', async ($, on) => {
  on('state.get', (_, e) => stored(live({ ci: [pr({ title: 'a\u001b\u0007\u0000\u009b\n‮b' })] }), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'a      b' })).toBeDefined()
    await noControlText(ui)
    await ui.unmount()
  }
})

test('a failing check name with ESC still draws, cleaned', async ($, on) => {
  on('state.get', (_, e) => stored(live({ ci: [pr({ failing: ['li\u001b[31mnt\u0007'] })] }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'li [31mnt ' })).toBeDefined()
  await noControlText(ui)
  await ui.unmount()
})

test('a check name with ESC is cleaned in rollup before it is stored', () => {
  expect(rollup([{ __typename: 'CheckRun', name: 'a\u001bb', status: 'COMPLETED', conclusion: 'FAILURE' }]).failing).toEqual(['a b'])
})

test('an agent name with ESC and 5000 characters draws at 40 characters or fewer, from stored values too', async ($, on) => {
  const long = (id: string, name: string) => ({ ...live().agents[0]!, id, name })
  on('state.get', (_, e) => stored(live({ agents: [long('x1', 'sc\u001bout'), long('x2', `n${'y'.repeat(5000)}`)] }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text' })).filter(t => / · Haiku · /.test(t.text))
  expect(rows).toHaveLength(2)
  expect(rows[0]?.text.startsWith('sc out · Haiku')).toBe(true)
  const name = rows[1]?.text.split(' · ')[0] ?? ''
  expect(name.length).toBeLessThanOrEqual(40)
  expect(name.endsWith('…')).toBe(true)
  await noControlText(ui)
  await ui.unmount()
})

test('agent names are cleaned and capped when they are stored (spawn, and the engine agent list)', async ($, on) => {
  const dirty = `ev\u001bil${'z'.repeat(5000)}`
  const box = memory(on, JSON.parse(JSON.stringify(live({ agents: [] }))))
  quiet(on)
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => usageAt(1))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 's1' }))
  on('agent.list', () => ({ value: [{ id: 'w9', type: dirty, description: 'x', status: 'running' }] }) as never)
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-sonnet-5-5')
  })

  await $.agent.spawn({ ...spawnInput, subagentType: 'teammate', name: dirty, model: 'sonnet' })
  for await (const _ of $.turn.step(stepInput('w9'))) void _

  const names = (box.value as unknown as MeterData).agents.map(a => a.name)
  expect(names).toHaveLength(2)
  for (const n of names) {
    expect(n.length).toBeLessThanOrEqual(40)
    expect(CONTROL_TEXT.test(n)).toBe(false)
    expect(n.startsWith('ev il')).toBe(true)
  }
})

test('the cost nobody booked is hidden under one cent and shown from there', () => {
  const booked = 1.32 + 0.12 + 0.92 + 1.04
  expect(beforeLoaded(live({ costUsd: booked + 0.005 }))).toBe(0)
  expect(beforeLoaded(live({ costUsd: booked }))).toBe(0)
  expect(Math.abs(beforeLoaded(live({ costUsd: booked + 0.02 })) - 0.02) < 1e-9).toBe(true)
})

test('"gh pr view <url>" after && or ; feeds the pane; inside echo it does not', async ($, on) => {
  const { clock, calls } = prSetup(on, '', () => gh(CHECKS))
  const url = 'https://github.com/a/b/pull/1'

  await $.tool.call({ tool: 'Bash', command: `echo gh pr view ${url}` })
  await clock.advance(5)
  expect(calls).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: `cd x && gh pr view ${url}` })
  await clock.advance(5)
  expect(calls.map(c => c[3])).toEqual([url])

  calls.length = 0
  await $.tool.call({ tool: 'Bash', command: `  false || gh pr view ${url.replace('/1', '/2')}` })
  await $.tool.call({ tool: 'Bash', command: `ls; gh pr checks ${url.replace('/1', '/3')}` })
  await $.tool.call({ tool: 'Bash', command: `cat f | gh pr merge ${url.replace('/1', '/4')}` })
  await clock.advance(5)
  expect(calls.map(c => c[3]).sort()).toEqual(['https://github.com/a/b/pull/2', 'https://github.com/a/b/pull/3', 'https://github.com/a/b/pull/4'])
})
