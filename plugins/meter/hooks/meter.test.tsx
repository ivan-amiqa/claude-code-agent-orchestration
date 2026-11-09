import { expect, mock, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { CodexLaunch, MeterCodex, MeterData, MeterGroup, MeterPr } from '../types'

import { addToGroups, agentRow, agoText, barSvg, beforeLoaded, claimed, claudeLimitLines, claudeWindows, codexCost, codexEstimate, codexLaunchesIn, columnColors, dollarsSvg, esc, gaugeSvg, groupAgents, labelRow, labelStart, mergePairs, clean, niceTicks, niceTop, PALETTES, paletteFor, parseCodex, parseCodexArgs, parseCsv, parseDuration, parsePercent, PRICE_RATIO, prUrlsIn, resetText, saneCodex, saneLimits, ringSvg, rollup, sane, sanePrs, shellSegments, shares, splitCost, splitParts, stackCells, summary, tokens, truncate } from './register'

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
  title: 'fix: onboarding fixes',
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

// -- the pane's tables, read back from the tree ------------------------------
type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] }
const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))
type Boxed = { findAll: (query: { type?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown>; children: unknown[]; text: string }[]> }
const boxes = async (ui: Boxed): Promise<Node[]> => (await ui.findAll({ type: 'Box' })).map(b => ({ type: 'Box', props: b.props, children: b.children as (Node | string)[] }))

/** The shared legend: one entry per bucket row, with each cell's text and the box that lays it out. */
type LegendCell = { text: string; width: unknown; align: unknown }
const legendRows = async (ui: Boxed) => {
  const out: { color: unknown; name: string; cost: string; costPct: string; tokens: string; tokensPct: string; cells: LegendCell[] }[] = []
  for (const b of await boxes(ui)) {
    const kids = b.children as Node[]
    const first = kids[0]
    if (kids.length !== 5 || first?.props.gap !== 1 || (first.children[0] as Node | undefined)?.children[0] !== '■') continue
    const cells = kids.slice(1).map(c => ({ text: textOf(c), width: c.props.width, align: c.props.justifyContent }))
    out.push({ color: (first.children[0] as Node).props.color, name: textOf(first.children[1] as Node), cost: cells[0]!.text, costPct: cells[1]!.text, tokens: cells[2]!.text, tokensPct: cells[3]!.text, cells })
  }

  return out
}

/** The agent rows: `name · Model` on the left; `read / written` and the dollars on the right. */
const agentRows = async (ui: Boxed) => {
  const out: { left: string; io: string; cost: string; width: unknown }[] = []
  for (const b of await boxes(ui)) {
    const kids = b.children as Node[]
    if (b.props.justifyContent !== 'space-between' || kids.length !== 2 || textOf(kids[0] as Node).startsWith('●') === false) continue
    const right = (kids[1] as Node).children as Node[]
    out.push({ left: textOf((kids[0] as Node).children[1] as Node), io: textOf(right[0] as Node), cost: textOf(right[1] as Node), width: right[1]?.props.width })
  }

  return out
}

test('the pane draws live-shaped data on terminal and desktop', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /\$3\.40/ }))?.text).toBe('$3.40')
    expect((await ui.find({ type: 'Text', text: /142k/ }))?.text).toBe('142k')
    expect(await ui.find({ type: 'Text', text: 'warm' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41 min left' })).toBeDefined()
    expect((await agentRows(ui)).find(r => r.left === 'implementer · Sonnet')).toMatchObject({ io: '1.1M / 48k', cost: '≈$0.92' })
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
    title: 'fix: onboarding fixes',
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

test('the status line is empty while nothing needs attention', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))

  await $.session.measure({ context: { tokens: 142_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 3.4 }, changed: ['context', 'cost'] })

  expect(lines.length).toBeGreaterThan(0)
  expect(lines[lines.length - 1]).toBeUndefined()
})

test('the status line warns from 350k, escalates at 500k, and clears when the condition ends', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  const at = async (tokens: number) => {
    await $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], cost: { usd: 2 }, changed: ['context', 'cost'] })

    return lines[lines.length - 1]
  }

  expect(await at(349_000)).toBeUndefined()
  expect(await at(362_000)).toBe('Meter: context 362k — consider /compact')
  expect(await at(512_000)).toBe('Meter: context 512k — start fresh')
  expect(await at(90_000)).toBeUndefined() // /compact
})

test('the status line says the cache is cold only while the context is big, and clears with the next response', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const clock = mock.clock(on, { now: NOW })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  let ctx = 200_000
  on('session.usage', () => usageAt(1, ctx))
  on('turn.step', async function* (_, e) {
    return stepResult(e, 'claude-opus-5-5')
  })

  for await (const _ of $.turn.step(stepInput())) void _
  expect(lines[lines.length - 1]).toBeUndefined() // warm
  await clock.advance(80 * MIN)
  expect(lines[lines.length - 1]).toBe('Meter: cache cold — fresh session cheaper')

  for await (const _ of $.turn.step(stepInput())) void _ // a new response warms it again
  expect(lines[lines.length - 1]).toBeUndefined()

  ctx = 50_000 // small context: cold is not worth a warning
  const before = lines.filter(l => l !== undefined).length
  for await (const _ of $.turn.step(stepInput())) void _
  await clock.advance(80 * MIN)
  expect(lines.filter(l => l !== undefined)).toHaveLength(before) // no new warning
  expect(lines[lines.length - 1]).toBeUndefined()
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
  expect((await agentRows(ui)).find(r => r.left.startsWith('Explore · Haiku'))).toMatchObject({ io: '5k / 20', cost: '≈$0.25' })
  expect((await legendRows(ui)).find(r => r.name === 'Opus (main)')?.cost).toBe('≈$0.50')
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
  expect((await legendRows(ui)).find(r => r.name === 'Opus (main)')?.cost).toBe('≈$0.40')
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
  const rows = await agentRows(ui)
  // both still run; with the words 'log-digger' would be cut at 42 cells, so every row says it with the glyph
  expect(rows.map(r => [r.io, r.cost])).toEqual([['5k / 20', '≈$0.50'], ['5k / 20', '≈$0.30']])
  expect(rows.map(r => r.left)).toEqual(['log-digger · Haiku ▶', 'scout · Haiku ▶'])
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
  expect((await agentRows(ui)).find(r => r.left === 'Explore · Haiku · running')).toMatchObject({ io: '5k / 20', cost: '≈$0.25' })
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
    expect(await ui.find({ type: 'Text', text: 'fix: onboarding fixes' })).toBeDefined()
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

test('two bars (Cost, Tokens written) share colours; ONE legend table under both has the money and the tokens of every bucket', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Cost' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tokens written' })).toBeDefined()
    const rows = await legendRows(ui)
    const pick = (name: string) => rows.find(r => r.name === name)
    expect(pick('Sonnet')).toMatchObject({ cost: '≈$0.92', tokens: '48k' })
    expect(pick('Opus (main)')).toMatchObject({ cost: '≈$1.32', tokens: '21k' })
    expect(pick('Opus (agents)')).toMatchObject({ cost: '≈$1.04', tokens: '9k' })
    // one table, one row per bucket: no second legend with the tokens on their own
    expect(rows.map(r => r.name)).toEqual(['Opus (main)', 'Haiku', 'Sonnet', 'Opus (agents)'])
    expect(await ui.find({ type: 'Text', text: 'Sonnet 48k' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Sonnet ≈$0.92' })).toBeUndefined()
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
  expect((await legendRows(ui)).map(r => [r.name, r.cost, r.tokens])).toEqual([['Opus (main)', '≈$3.40', '30k']])
  expect(await ui.find({ type: 'Text', text: /^Haiku/ })).toBeUndefined()
  await ui.unmount()
})

test('"Before Meter loaded" is the grey first part of the cost bar and makes the buckets add up to the session cost', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 3.40 booked, 2.00 from before
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await legendRows(ui)
    const sum = rows.reduce((n, r) => n + Number(/≈\$([0-9.]+)/.exec(r.cost)?.[1]), 0)
    expect(rows[0]).toMatchObject({ name: 'Before Meter loaded', cost: '≈$2.00', tokens: '—', tokensPct: '—' })
    expect(Math.abs(sum - 5.4) < 0.005).toBe(true)
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

test('the shared legend has the cost columns first, then the tokens, and no tokens for Before Meter loaded', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 2.00 from before
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await legendRows(ui)
    expect(rows.map(r => r.name)).toEqual(['Before Meter loaded', 'Opus (main)', 'Haiku', 'Sonnet', 'Opus (agents)'])
    expect(rows.map(r => r.cost)).toEqual(['≈$2.00', '≈$1.32', '≈$0.12', '≈$0.92', '≈$1.04'])
    expect(rows.map(r => r.tokens)).toEqual(['—', '21k', '2k', '48k', '9k'])
    expect(rows.every(r => !r.cost.includes('k') && !r.tokens.includes('$'))).toBe(true)
    // the header names the two column pairs, small and muted
    const head = (await ui.findAll({ type: 'Text', text: /^(Cost|Written)$/ })).filter(t => t.props.dimColor === true)
    expect(head.map(t => t.text).slice(-2)).toEqual(['Cost', 'Written'])
    expect(head.every(t => t.props.size === 'caption')).toBe(true)
    // the old per-bar legends are gone
    expect(await ui.find({ type: 'Text', text: /^Opus \(main\) / })).toBeUndefined()
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

test('the legend shows each bucket share of its own bar; both percent columns add up to 100, the no-token row is a dash', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 5.4 }), e)) // 2.00 before + 3.40 booked
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await legendRows(ui)
    // cost: before, Opus (main), Haiku, Sonnet, Opus (agents); tokens: Opus (main), Haiku, Sonnet, Opus (agents)
    expect(rows.map(r => r.costPct)).toEqual(['37%', '25%', '2%', '17%', '19%'])
    expect(rows.map(r => r.tokensPct)).toEqual(['—', '26%', '3%', '60%', '11%'])
    const total = (xs: string[]) => xs.reduce((n, t) => n + (/^\d+%$/.test(t) ? parseInt(t, 10) : 0), 0)
    expect(total(rows.map(r => r.costPct))).toBe(100)
    expect(total(rows.map(r => r.tokensPct))).toBe(100)
    // the percent cells are dim; the money and token cells are not
    expect(rows.every(r => r.cells[1]?.text === r.costPct && r.cells[3]?.text === r.tokensPct)).toBe(true)
    const dim = (await ui.findAll({ type: 'Text' })).filter(t => /^(<1|\d+)%$/.test(t.text))
    expect(dim.length).toBe(9)
    expect(dim.every(t => t.props.dimColor === true)).toBe(true)
    await ui.unmount()
  }
})

test('a bucket under half a percent shows <1% and the rest still add up to 100', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 3.4, spend: { 'opus-main': 3.39, haiku: 0.01, sonnet: 0, 'opus-checks': 0 }, written: { 'opus-main': 30_000, haiku: 100, sonnet: 0, 'opus-checks': 0 } }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await legendRows(ui)
  expect(rows.map(r => [r.name, r.costPct, r.tokensPct])).toEqual([['Opus (main)', '100%', '100%'], ['Haiku', '<1%', '<1%']])
  await ui.unmount()
})

test('the legend columns line up: every row uses the same widths, numbers right-aligned', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 25.4, spend: { 'opus-main': 17.95, haiku: 0.12, sonnet: 2.4, 'opus-checks': 2.93 }, written: { 'opus-main': 1_210_000, haiku: 2_000, sonnet: 48_000, 'opus-checks': 9_000 } }), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await legendRows(ui)
    expect(rows.length).toBe(5)
    const shape = (r: (typeof rows)[number]) => r.cells.map(c => `${String(c.width)}/${String(c.align)}`)
    for (const r of rows) expect(shape(r)).toEqual(shape(rows[0]!))
    for (const c of rows[0]!.cells) expect(c.align).toBe('flex-end')
    // the widest entry (≈$17.95, 7) fits its column; the name column takes the rest of the 42 cells
    const widths = rows[0]!.cells.map(c => Number(c.width))
    expect(widths[0]).toBeGreaterThanOrEqual('≈$17.95'.length)
    expect(widths[2]).toBeGreaterThanOrEqual('1.2M'.length)
    // header: Cost spans the cost + % columns, Written the tokens + % columns
    const head = (await boxes(ui)).find(b => b.props.width === 42 && b.children.length === 3 && textOf(b) === 'CostWritten')
    expect((head?.children as Node[]).slice(1).map(c => c.props.width)).toEqual([Number(widths[0]) + Number(widths[1]), Number(widths[2]) + Number(widths[3])])
    await ui.unmount()
  }
})

test('a zero total draws no percent in the legend', async ($, on) => {
  on('state.get', (_, e) => stored(live({ costUsd: 0, spend: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 }, written: { 'opus-main': 0, haiku: 0, sonnet: 5, 'opus-checks': 0 } }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await legendRows(ui)
  // cost total is zero: no cost percent; the one token entry is 100%
  expect(rows.map(r => [r.name, r.costPct, r.tokensPct])).toEqual([['Sonnet', '', '100%']])
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
  expect((await legendRows(ui)).find(r => r.name === 'Opus (main)')).toMatchObject({ cost: '≈$0.40', tokens: '20' })
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
  expect((await agentRows(ui)).find(r => r.left.startsWith('implementer · Sonnet'))).toMatchObject({ io: '5k / 20' })
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
  expect(agentRow(rows[0] as never, 80)).toMatchObject({ left: 'implementer ×3 · Sonnet', io: '12.5M / 135k', cost: '≈$2.72', cut: false })
  expect(agentRow(rows[1] as never, 80)).toMatchObject({ left: 'scout · Haiku', io: '40k / 900', cost: '≈$0.06', cut: false }) // one run: no ×
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
  expect(agentRow(rows[0] as never, 80)).toMatchObject({ left: 'verifier ×2 · Opus · running', cost: '≈$2.00' })
  expect(agentRow(rows[1] as never, 80).left).toMatch(/ · stopped$/)
  expect(agentRow(rows[2] as never, 80).left).not.toMatch(/running|stopped/)
  // A partly failed group says how many stopped, and a control character in a name never reaches the row.
  const mixed = groupAgents([agentRun('m1', 'a\u001bb', 'Opus', 'opus-checks', 1, 1, 1, 'failed'), agentRun('m2', 'a\u001bb', 'Opus', 'opus-checks', 1, 1, 1)])
  expect(agentRow(mixed[0] as never, 80)).toMatchObject({ left: 'a b ×2 · Opus · 1 stopped', io: '2 / 2', cost: '≈$2.00', cut: false })
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
    const rows = await agentRows(ui)
    // one row per type and model; the implementer's three runs are one row, running (▶ when the words would not leave its name room)
    expect(rows.map(r => [r.left, r.io, r.cost])).toEqual([
      ['imple… ×3 · Sonnet ▶', '12.5M / 135k', '≈$2.72'],
      ['scout · Haiku', '40k / 900', '≈$0.06'],
    ])
    expect(rows.every(r => r.width === rows[0]?.width)).toBe(true) // the dollars share one right-aligned column
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
  expect(all).toHaveLength(5) // cache ring, gauge, cost bar, tokens bar, dollars
  for (const s of all) {
    expect(String(s.props.alt).length).toBeGreaterThan(5)
    expect(typeof s.props.width).toBe('number')
    expect(typeof s.props.height).toBe('number')
    wellFormed(String(s.props.source))
  }
  expect(all.map(s => s.props.height)).toEqual([28, 32, 6, 6, 135]) // the docked pane's chart is a quarter shorter
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
  expect(await ui.find({ type: 'Text', text: 'fix: onboarding fixes' })).toBeDefined()
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
  const rows = (await agentRows(ui)).map(r => r.left)
  expect(rows).toHaveLength(2)
  expect(rows[0]?.startsWith('sc out · Haiku')).toBe(true)
  const name = rows[1]?.split(' · ')[0] ?? ''
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

// -- Compact layout: three tiles, one line per agent, a one-line Guard -------------
const tilesOf = async (ui: Boxed) => (await boxes(ui)).find(b => b.children.length === 3 && (b.children as Node[]).every(c => c.type === 'Box' && c.props.flexDirection === 'column' && typeof c.props.width === 'number'))

test('Session cost, Context and Cache are one row of three equal tiles, the gauge directly under it', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await tilesOf(ui)
    expect(row?.props.width).toBe(42)
    const tiles = row?.children as Node[]
    expect(tiles.map(t => t.props.width)).toEqual([14, 14, 14]) // equal thirds of the pane
    expect(tiles.map(t => ((t.children[0] as Node).children[0] as string))).toEqual(['Session cost', 'Context', 'Cache'])
    const text = tiles.map(textOf)
    expect(text[0]).toBe('Session cost$3.40list price')
    expect(text[1]).toBe('Context142kread each call')
    expect(text[2]).toContain('warm')
    expect(text[2]).toContain('41 min left') // the minutes stay visible
    expect(text[2]).toContain('1h cache')
    // big numbers, the context one in its zone colour
    const big = (await ui.findAll({ type: 'Text' })).filter(t => t.props.size === 'title' && /^(\$3\.40|142k)$/.test(t.text))
    expect(big.map(t => [t.text, t.props.color])).toEqual([['$3.40', undefined], ['142k', 'success']])
    // the gauge follows the row at full width, before "Who did the work"
    const gauge = surface === 'terminal' ? await ui.find({ type: 'Text', text: /350k/ }) : (await ui.findAll({ type: 'Svg' })).find(x => /^Context/.test(String(x.props.alt)))
    expect(gauge).toBeDefined()
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).map(x => String(x.props.alt).split(' ')[0])).toEqual(['Cache', 'Context', 'Cost', 'Tokens', 'Dollars'])
    const order = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(order.indexOf('Cache')).toBeGreaterThan(order.indexOf('Session cost'))
    expect(order.indexOf('Who did the work')).toBeGreaterThan(order.indexOf('Cache'))
    if (surface === 'terminal') expect(order.findIndex(t => /350k/.test(t))).toBeGreaterThan(order.indexOf('Cache')) // the gauge ticks follow the tiles
    await ui.unmount()
  }
})

test('a context over 500k keeps its red number in the tile; a cold cache says what the next call re-writes under the gauge', async ($, on) => {
  on('state.get', (_, e) => stored(live({ contextTokens: 520_000, lastResponseAt: NOW - 90 * MIN }), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '520k' }))?.props.color).toBe('error')
  expect(textOf((await tilesOf(ui)) as Node)).toContain('cold')
  const cold = await ui.find({ type: 'Text', text: /^cold — next call re-writes 520k\. A fresh session is cheaper\.$/ })
  expect(cold?.props.color).toBe('error')
  await ui.unmount()
})

test('on a pane too narrow for three tiles they stack, with the same information', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await tilesOf(ui)).toBeUndefined()
  for (const t of ['Session cost', 'Context', 'Cache', '$3.40', '142k', 'list price', '41 min left']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  await ui.unmount()
})

test('an agent row is one line: the name gives way to a long model or state, never the tokens or the dollars', async ($, on) => {
  const long = (id: string, name: string, usd: number) => ({ ...live().agents[0]!, id, name, usd })
  on('state.get', (_, e) => stored(live({ agents: [long('a', 'a-very-long-agent-type-name-for-a-narrow-pane', 12.34), long('b', 'scout', 0.06)] }), e))
  const lengths: number[] = []
  for (const bodyColumns of [44, 60, 100]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const rows = await agentRows(ui)
    expect(rows).toHaveLength(2)
    const room = bodyColumns - 2
    for (const r of rows) {
      // dot + name · Model, read / written, ≈$ -- all of it fits one row of `room` characters
      expect(2 + r.left.length + 1 + r.io.length + 1 + r.cost.length).toBeLessThanOrEqual(room)
      expect(r.io).toBe('38k / 900')
      expect(r.left.endsWith(' · Haiku')).toBe(true)
    }
    expect(rows.map(r => r.cost)).toEqual(['≈$12.34', '≈$0.06'])
    lengths.push(rows[0]?.left.length ?? 0)
    expect(rows[1]?.left).toBe('scout · Haiku')
    // the dollars column is one width, right-aligned
    expect(new Set(rows.map(r => r.width)).size).toBe(1)
    await ui.unmount()
  }
  expect(lengths[0]).toBeLessThan(lengths[1]!) // the wider the pane, the more of the name
  expect(lengths[1]).toBeLessThan(lengths[2]!)
})

test('agentRow cuts only the name, with a …, and falls back to glyphs when the words would cut it', () => {
  const g = { name: 'implementer', model: 'Sonnet', bucket: 'sonnet' as const, runs: 2, read: 12_500_000, written: 135_000, usd: 2.72, running: true, failed: 0 }
  expect(agentRow(g, 120)).toEqual({ left: 'implementer ×2 · Sonnet · running', io: '12.5M / 135k', cost: '≈$2.72', cut: false })
  expect(agentRow(g, 44).cut).toBe(true)
  expect(agentRow(g, 44, false)).toEqual({ left: 'impleme… ×2 · Sonnet ▶', io: '12.5M / 135k', cost: '≈$2.72', cut: true })
  // never below four characters of the name, and the rest is never touched
  expect(agentRow(g, 10, false).left).toBe('imp… ×2 · Sonnet ▶')
  expect(agentRow({ ...g, running: false, failed: 2 }, 40, false).left.endsWith(' · Sonnet ✕')).toBe(true)
  expect(agentRow({ ...g, running: false, failed: 1 }, 40, false).left.endsWith(' · Sonnet ✕1')).toBe(true)
})

test('the pane has no title and body for Guard when nothing was blocked: one muted line', async ($, on) => {
  on('state.get', (_, e) => stored(live({ guardLines: [] }), e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const line = await ui.find({ type: 'Text', text: 'Guard · nothing blocked yet' })
    expect(line?.props.dimColor).toBe(true)
    expect(line?.props.size).toBe('caption')
    expect(await ui.find({ type: 'Text', text: /^Guard$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /nothing blocked or switched/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with something blocked or switched Guard keeps its title and a row for each', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Guard$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blocked: nested agent' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Explore → switched to Haiku' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Guard · nothing/ })).toBeUndefined()
  await ui.unmount()
})

test('Dollars per step is a quarter shorter in the docked pane and keeps its full height expanded', async ($, on) => {
  on('state.get', (_, e) => stored(live(), e))
  const heightAt = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    const svg = (await ui.findAll({ type: 'Svg' })).find(x => /^Dollars per step/.test(String(x.props.alt)))
    await ui.unmount()

    return svg?.props.height
  }
  expect(await heightAt(44)).toBe(135)
  expect(await heightAt(62)).toBe(135)
  expect(await heightAt(100)).toBe(180)
})

// ---------------------------------------------------------------------------
// Codex: this session's `codex-review.sh` runs, from ONE local CSV
// (test data is scrubbed: acme labels, example.com, made-up paths)
// ---------------------------------------------------------------------------
const CODEX_HEADER = 'timestamp,user,label,repo,head_sha,auth,fell_back,limit_signal,duration_s,exit_code,input_tokens,cached_input_tokens,output_tokens,est_api_cost_usd,out_dir,base_sha,effort,risk,skip_reason'
const T0 = Date.parse('2026-11-09T09:00:00Z')
const CODEX_PATH = '/home/tester/.amiqa/codex-review-runs.csv'
const FAKE_EMAIL = 'dev@example.com'
const FAKE_PATH = '/Users/jdoe/src/web-api'

const close = (a: number, b: number, tol = 0.0005) => Math.abs(a - b) <= tol
const csvField = (v: string) => (/[,"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const csvRow = (over: Record<string, string> = {}, columns = CODEX_HEADER.split(',')) => {
  const base: Record<string, string> = {
    timestamp: '2026-11-09T09:00:00Z',
    user: FAKE_EMAIL,
    label: 'acme/web-api#12',
    repo: FAKE_PATH,
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    auth: 'plan',
    fell_back: 'no',
    limit_signal: '',
    duration_s: '206',
    exit_code: '0',
    input_tokens: '428723',
    cached_input_tokens: '382208',
    output_tokens: '2758',
    est_api_cost_usd: '',
    out_dir: '/Users/jdoe/tmp/out',
    base_sha: 'fedcba9876543210fedcba9876543210fedcba98',
    effort: 'high',
    risk: 'high',
    skip_reason: '',
  }
  const all = { ...base, ...over }

  return columns.map(c => csvField(all[c] ?? '')).join(',')
}
const csvOf = (...rowsIn: string[]) => `${CODEX_HEADER}\n${rowsIn.join('\n')}\n`
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString().replace('.000Z', 'Z')

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
type CodexWorld = { csv: string | undefined; mtime: number; size: number | undefined; failRead: boolean; gate: Promise<void> | undefined; stats: string[]; reads: string[]; others: string[]; startedAt: number; clockAt: number; rateLimits: RateLimit[]; costUsd: number; deny: RegExp | undefined }
/** The fs, env, store and session beneath the plugin for a Codex test; the clock sits 10 minutes after T0 unless `clockAt` says otherwise. */
const codexSetup = (on: On, world: Partial<CodexWorld> = {}, entries: Record<string, unknown> = {}) => {
  const w: CodexWorld = { csv: undefined, mtime: 1, size: undefined, failRead: false, gate: undefined, stats: [], reads: [], others: [], startedAt: T0 - MIN, clockAt: T0 + 10 * MIN, rateLimits: [], costUsd: 1, deny: undefined, ...world }
  quiet(on)
  const clock = mock.clock(on, { now: w.clockAt })
  mock.env(on, { HOME: '/home/tester' })
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: w.startedAt, context: { tokens: 1000, window: 1_000_000 }, rateLimits: w.rateLimits, cost: { usd: w.costUsd } } }))
  on('fs.stat', async (_, e) => {
    w.stats.push(e.path)
    const gate = w.gate
    const mtimeMs = w.mtime
    if (gate !== undefined) await gate
    if (w.csv === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    return { value: { kind: 'file' as const, size: w.size ?? w.csv.length, mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    w.reads.push(e.path)
    if (w.failRead) throw new Error('too big for the engine')

    return { value: w.csv ?? '' }
  })
  const other = (name: string) => () => {
    w.others.push(name)

    return { value: undefined } as never
  }
  on('fs.write', other('fs.write'))
  on('fs.list', other('fs.list'))
  on('fs.exists', other('fs.exists'))
  on('fs.ancestors', other('fs.ancestors'))
  on('tool.call', (_, e) => (w.deny !== undefined && 'command' in e && w.deny.test(String(e.command)) ? { deny: 'not allowed' } : { result: {}, text: '' }))

  return { w, clock, store }
}
const startSession = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const runMeter = ($: Engine, args: string) =>
  $.command.run({ command: 'meter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const allText = async (ui: Tree) => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

test('parseCsv: quotes, doubled quotes, commas and line breaks inside quotes, CRLF, blank lines', () => {
  expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",z\n\nlast,')).toEqual([
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
    ['two\nlines', 'z'],
    [''],
    ['last', ''],
  ])
  expect(parseCsv('')).toEqual([])
  expect(parseCsv('a"b,c')).toEqual([['a"b', 'c']]) // a quote inside an unquoted field is a plain character
})

test('codexCost: the 428723 / 382208 / 2758 row is about $0.159, and a cache bigger than the input never goes negative', () => {
  expect(close(codexCost(428_723, 382_208, 2_758), 0.0930 + 0.0382 + 0.0276)).toBe(true)
  expect(close(codexCost(428_723, 382_208, 2_758), 0.159)).toBe(true)
  expect(close(codexCost(1_000, 5_000, 0), (5_000 * 0.1) / 1e6, 1e-9)).toBe(true) // input - cached clamps at 0
  expect(close(codexCost(Number.NaN, -5, 10), 0.0001, 1e-9)).toBe(true)
})

test('parseCodex finds columns by header name: a reordered file with an extra column reads the same', () => {
  const cols = ['skip_reason', 'extra_new_column', ...CODEX_HEADER.split(',').reverse()]
  const text = `${cols.join(',')}\n${csvRow({ extra_new_column: 'x' }, cols)}\n`
  const out = parseCodex(text, 0)

  expect(out.runs).toHaveLength(1)
  expect(out.runs[0]).toMatchObject({ label: 'acme/web-api#12', auth: 'plan', durationS: 206, input: 428_723, cached: 382_208, output: 2_758, exitCode: 0, fellBack: false, skip: '' })
  expect(out.totals.runs).toBe(1)
  expect(close(out.totals.usd, 0.159)).toBe(true)
})

test('parseCodex drops user, repo, out_dir and the SHAs at parse time: nothing of them is in what it returns', () => {
  const out = parseCodex(csvOf(csvRow(), csvRow({ label: 'acme/web-api#13' })), 0)
  const json = JSON.stringify(out)

  expect(json).not.toContain('@')
  expect(json).not.toContain('/Users/')
  expect(json).not.toContain('0123456789abcdef')
  expect(json).not.toContain('fedcba98')
  expect(Object.keys(out.runs[0] ?? {}).sort()).toEqual(['at', 'auth', 'cached', 'durationS', 'exitCode', 'fellBack', 'input', 'label', 'output', 'skip'])
})

test('parseCodex edge cases: guard quote, CRLF, quoted label, short and garbled rows, control characters, huge numbers', () => {
  const guard = csvRow({ label: "'=SUM(A1)" }) // codex-review.sh puts a ' in front of = + @ -
  const quoted = csvRow({ label: 'acme/web-api#14, "big" fix' })
  const short = `${at(1)},${FAKE_EMAIL},acme/web-api#15`
  const garbled = csvRow({ timestamp: 'yesterday' })
  const badAuth = csvRow({ auth: 'wat' })
  const control = csvRow({ label: 'acme/\u001b[31mred\u202e#16\nnext' })
  const huge = csvRow({ label: 'acme/web-api#17', input_tokens: '9'.repeat(40), output_tokens: '-5', duration_s: 'abc', cached_input_tokens: '1e9' })
  const text = csvOf(guard, quoted, short, garbled, badAuth, control, huge).replace(/\n/g, '\r\n')
  const out = parseCodex(text, 0)

  expect(out.runs.map(r => r.label)).toEqual(['=SUM(A1)', 'acme/web-api#14, "big" fix', 'acme/ [31mred #16  next', 'acme/web-api#17'])
  expect(out.runs[3]).toMatchObject({ input: 0, output: 0, durationS: 0, cached: 0 })
  expect(JSON.stringify(out)).not.toMatch(/[\u0000-\u001f\u202e]/)
  expect(parseCodex('', 0).runs).toEqual([])
  expect(parseCodex('no header here\n1,2,3\n', 0).runs).toEqual([])
  expect(parseCodex(`timestamp,auth\n${at(1)},plan\n`, 0).runs).toEqual([]) // no label column: not our file
})

test('parseCodex cuts a long label to 40 and keeps only the log\'s last 500 lines', () => {
  const long = parseCodex(csvOf(csvRow({ label: `acme/${'x'.repeat(100)}#1` })), 0).runs[0]?.label ?? ''
  expect(long.length).toBe(40)
  expect(long.endsWith('…')).toBe(true)

  const many = Array.from({ length: 600 }, (_, i) => csvRow({ label: `acme/web-api#${i}` }))
  const out = parseCodex(csvOf(...many), 0)
  expect(out.totals.runs).toBe(500)
  expect(out.runs[out.runs.length - 1]?.label).toBe('acme/web-api#599')
  expect(out.runs).toHaveLength(8)
})

test('parseCodex hides rows before the session start and counts skipped rows apart', () => {
  const before = csvRow({ timestamp: at(-120), label: 'acme/web-api#1' })
  const mine = csvRow({ timestamp: at(0), label: 'acme/web-api#2' })
  const skipped = csvRow({ timestamp: at(1), label: 'acme/web-api#3', auth: 'none', exit_code: '0', input_tokens: '', cached_input_tokens: '', output_tokens: '', duration_s: '', skip_reason: 'no_code' })
  const out = parseCodex(csvOf(before, mine, skipped), T0 - MIN)

  expect(out.runs.map(r => r.label)).toEqual(['acme/web-api#2', 'acme/web-api#3'])
  expect(out.totals.runs).toBe(1) // the skipped row is shown, not counted as a run
  expect(out.runs[1]).toMatchObject({ skip: 'no_code', auth: 'none' })
  // the plan-run times, for the estimate, are kept whatever the session start
  expect(out.planDoneAt).toEqual([T0 - 120 * MIN, T0])
})

test('saneCodex repairs a stored value: bad rows dropped, numbers finite, labels cleaned again', () => {
  const out = saneCodex({ runs: [{ label: 'a\nb', at: Number.NaN, input: -4, auth: 'x', skip: 5 }, { nolabel: true }, 7], totals: { runs: 'many' }, planDoneAt: [1, 'x', Number.NaN, -3], launches: [] })

  expect(out.runs).toEqual([{ label: 'a b', at: 0, durationS: 0, input: 0, cached: 0, output: 0, auth: 'none', fellBack: false, exitCode: null, skip: '' }])
  expect(out.totals.runs).toBe(0)
  expect(out.planDoneAt).toEqual([1])
  expect(saneCodex(undefined).runs).toEqual([])
})

// -- helpers for the v1.2.0 tests: launches, seeded stores, the Bash call that starts a review -------------
const REVIEW = (label: string, extra = '') => `bash .claude/bin/codex-review.sh --repo . --base main --head HEAD ${extra}--label ${label}`
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) })
const launch = (label: string, minutes: number): CodexLaunch => ({ label, at: T0 + minutes * MIN })
/** Like `codexSetup`, but the clock starts at T0 + 1 min, each label is launched there, then the clock moves to T0 + 10 min. */
const launchedSetup = async ($: Engine, on: On, labels: string[], world: Partial<CodexWorld> = {}, entries: Record<string, unknown> = {}) => {
  const s = codexSetup(on, { clockAt: T0 + MIN, ...world }, entries)
  for (const label of labels) await bash($, REVIEW(label))
  await s.clock.set(T0 + 10 * MIN)

  return s
}
/** Keeps what the plugin writes to its atoms (the `{ shape, value }` it hands `state.set`): a test can look at it, and a "reload" can start from it. */
const memoryState = (on: On, seed: Record<string, unknown> = {}) => {
  const mem = new Map<string, unknown>(Object.entries(seed))
  let version = 0
  on('state.get', (_, e) => {
    return { value: { version, value: mem.get(e.key) } }
  })
  on('state.set', (_, e) => {
    mem.set(e.key, JSON.parse(JSON.stringify(e.value)))
    version++

    return { value: { isSet: true as const, version } }
  })

  return mem
}
const emptyCodex = (over: Partial<MeterCodex> = {}): MeterCodex => ({ runs: [], totals: { runs: 0, durationS: 0, input: 0, cached: 0, output: 0, usd: 0 }, planDoneAt: [], launches: [], tooBig: false, ...over })
const runOf = (over: Partial<MeterCodex['runs'][number]> = {}): MeterCodex['runs'][number] => ({ label: 'acme/web-api#12', at: T0, durationS: 206, input: 428_723, cached: 382_208, output: 2_758, auth: 'plan', fellBack: false, exitCode: 0, skip: '', ...over })
/** A stored `codex-2` value, as the atom holds it: pass the event so the right atom is served. */
const storedCodex = (fixture: Fixture, codex: MeterCodex, e: { key: string }) => (e.key === 'codex' ? { value: { version: 1, value: { shape: 'codex-2', value: codex } } } : stored(fixture, e))
const WIDE = { ...PANE.props, bodyColumns: 120 }

test('shellSegments: quotes come off, ; & | and line breaks cut the command, a backslash escapes, a long command is read only so far', () => {
  expect(shellSegments(`cd 'a b' && ls -la "x y"; echo a\\ b | cat`)).toEqual([['cd', 'a b'], ['ls', '-la', 'x y'], ['echo', 'a b'], ['cat']])
  expect(shellSegments('a\nb \\\nc')).toEqual([['a'], ['b', 'c']]) // a line continuation joins, a bare line break splits
  expect(shellSegments(`say "he said \\"hi\\"" ''`)).toEqual([['say', 'he said "hi"', '']])
  expect(shellSegments('')).toEqual([])
  expect(shellSegments(`${'x '.repeat(20_000)}tail`).flat().includes('tail')).toBe(false)
})

test('codexLaunchesIn reads the label bare, in single quotes, in double quotes and after =, and nothing else counts as a launch', () => {
  const run = '.claude/bin/codex-review.sh --repo . --base main --head HEAD'
  expect(codexLaunchesIn(`bash ${run} --label acme/web-api#12`)).toEqual(['acme/web-api#12'])
  expect(codexLaunchesIn(`${run} --label 'acme/web-api#13'`)).toEqual(['acme/web-api#13'])
  expect(codexLaunchesIn(`${run} --label "acme/web-api#14"`)).toEqual(['acme/web-api#14'])
  expect(codexLaunchesIn(`${run} --label=acme/web-api#15`)).toEqual(['acme/web-api#15'])
  expect(codexLaunchesIn(`${run} --label 'acme web #16' --force`)).toEqual(['acme web #16'])
  expect(codexLaunchesIn(`${run} --label a#1 --label a#2`)).toEqual(['a#2']) // the script keeps the last one too
  expect(codexLaunchesIn(`cd . && ${run} --label a#3 & ${run} --label a#4`)).toEqual(['a#3', 'a#4'])
  expect(codexLaunchesIn(`FOO=1 nohup timeout 600 bash ${run} --label a#5 > out.log 2>&1 &`)).toEqual(['a#5']) // the redirect and the & after the label do not hide it
  expect(codexLaunchesIn(`./codex-review.sh --label a#6`)).toEqual(['a#6'])
  expect(codexLaunchesIn(`${run} --label '${'x'.repeat(80)}'`)[0]?.length).toBe(40) // cut as the log's label is
  expect(codexLaunchesIn(`${run} --label 'a\u0007b'`)).toEqual(['a b']) // control characters are cleaned
  // not launches
  expect(codexLaunchesIn(`${run} --classify --label a#7`)).toEqual([]) // `--classify` is a question, not a review
  expect(codexLaunchesIn(`${run} --label a#8 --classify`)).toEqual([])
  expect(codexLaunchesIn(`echo ${run} --label a#9`)).toEqual([])
  expect(codexLaunchesIn(`grep -n label .claude/bin/codex-review.sh`)).toEqual([])
  expect(codexLaunchesIn(`cat .claude/bin/codex-review.sh --label a#10`)).toEqual([])
  expect(codexLaunchesIn(`${run}`)).toEqual([]) // no label: the script names it after the folder, which is not read
  expect(codexLaunchesIn(`${run} --label`)).toEqual([])
  expect(codexLaunchesIn(`${run} --label ''`)).toEqual([])
  expect(codexLaunchesIn('ls -la')).toEqual([])
})

test('claimed: the latest launch of the same label at or before the row takes it, for two hours at most', () => {
  const l = [launch('a#1', 0), launch('a#1', 10), launch('b#2', 5)]
  expect(claimed(l, 'a#1', T0 - MIN)).toBe(false) // before every launch
  expect(claimed(l, 'a#1', T0)).toBe(true) // at the launch
  expect(claimed(l, 'a#1', T0 + 3 * MIN)).toBe(true)
  expect(claimed(l, 'a#1', T0 + 11 * MIN)).toBe(true)
  expect(claimed(l, 'a#1', T0 + 10 * MIN + 2 * 60 * MIN - 1)).toBe(true) // the 2 hours run from the LATEST launch
  expect(claimed(l, 'a#1', T0 + 10 * MIN + 2 * 60 * MIN)).toBe(false)
  expect(claimed(l, 'b#2', T0 + 4 * MIN)).toBe(false) // another label's launch is later
  expect(claimed(l, 'b#2', T0 + 6 * MIN)).toBe(true)
  expect(claimed(l, 'c#3', T0 + 6 * MIN)).toBe(false) // nobody launched it
  expect(claimed([], 'a#1', T0)).toBe(false)
})

test('parseCodex with launches: only claimed rows count, one launch takes a plan failure and its API fallback, the totals and planDoneAt differ in scope', () => {
  const mine = csvRow({ timestamp: at(2), label: 'acme/web-api#12', exit_code: '3', input_tokens: '', cached_input_tokens: '', output_tokens: '', duration_s: '40' })
  const fallback = csvRow({ timestamp: at(4), label: 'acme/web-api#12', auth: 'api', fell_back: 'yes' })
  const other = csvRow({ timestamp: at(3), label: 'acme/other#9' }) // another terminal's
  const before = csvRow({ timestamp: at(-5), label: 'acme/web-api#12' }) // before the launch and the session
  const out = parseCodex(csvOf(before, mine, other, fallback), T0 - MIN, [launch('acme/web-api#12', 1)])

  expect(out.runs.map(r => [r.label, r.auth])).toEqual([['acme/web-api#12', 'plan'], ['acme/web-api#12', 'api']])
  expect(out.totals.runs).toBe(2)
  expect(close(out.totals.usd, 0.159)).toBe(true) // only the fallback had tokens
  expect(out.launches).toEqual([launch('acme/web-api#12', 1)])
  // the limit is account-wide: every plan run that finished, claimed or not
  expect(out.planDoneAt).toEqual([T0 - 5 * MIN, T0 + 3 * MIN])
  expect(parseCodex(csvOf(mine, other), T0 - MIN, []).runs).toEqual([]) // no launch, no rows
  expect(parseCodex(csvOf(mine, other), T0 - MIN).runs).toHaveLength(2) // no list at all: no attribution (the parser's own tests)
})

test('saneCodex keeps the launches repaired, and a codex-1 value (rows, no launches) comes back empty', () => {
  const out = saneCodex({ ...emptyCodex(), launches: [{ label: 'a\nb', at: 5 }, { label: 'ok', at: Number.NaN }, { label: 7, at: 1 }, { at: 2 }, 'x', { label: 'c', at: -1 }] })
  expect(out.launches).toEqual([{ label: 'a b', at: 5 }])
  expect(saneCodex({ ...emptyCodex(), launches: Array.from({ length: 150 }, (_, i) => ({ label: `l${i}`, at: i })) }).launches).toHaveLength(100)
  // what codex-1 stored: machine-wide rows, no launches
  const old = { runs: [{ label: 'acme/web-api#12', at: T0, durationS: 1, input: 9, cached: 0, output: 1, auth: 'plan', fellBack: false, exitCode: 0, skip: '' }], totals: { runs: 3, durationS: 9, input: 9, cached: 0, output: 1, usd: 5 }, planDoneAt: [1, 2], tooBig: false }
  expect(saneCodex(old)).toEqual(emptyCodex())
  expect(saneCodex({ ...old, launches: 'no' })).toEqual(emptyCodex())
})

test('summary: with Codex the session total is Claude + Codex on one line, without it nothing changes', () => {
  const d = sane(live({ costUsd: 10.65 }))
  const cx = emptyCodex({ totals: { runs: 2, durationS: 1, input: 1, cached: 0, output: 1, usd: 1.74 } })
  const withCx = summary(d, [], cx)
  expect(withCx).toContain('Session $12.39 (Claude $10.65 + Codex ≈$1.74 API-eq) · context')
  expect(withCx.includes('\n')).toBe(false)
  expect(summary(d, [])).toContain('Session $10.65 · context')
  expect(summary(d, [], emptyCodex())).not.toContain('Codex')
  expect(summary(d, [], emptyCodex({ runs: [runOf({ skip: 'no_code' })] }))).not.toContain('Codex') // only skipped rows: no run ran
})

// -- attribution: which log rows are this session's -----------------------------------------------------
test('rows another terminal wrote (no launch from this session, or another label) are ignored: not in the total, the bars, the agents or /meter', async ($, on) => {
  const { w } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) }), csvRow({ timestamp: at(3), auth: 'api' })) })
  await startSession($)
  await bash($, 'ls -la')
  await bash($, REVIEW('acme/web-api#99')) // a launch, but of another label
  w.mtime = 2 // make the log look changed, so the launch above is parsed against it
  const reply = (await runMeter($, '')).text ?? ''
  expect(reply).not.toContain('Codex')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
    const text = await allText(ui)
    expect(text).toContain('list price')
    expect(text).not.toMatch(/Codex|GPT|codex/)
    await ui.unmount()
  }
})

test('a background launch claims the row the review writes later; the pane has it on the next minute tick', async ($, on) => {
  const { w, clock } = codexSetup(on, { clockAt: T0 + MIN })
  await startSession($)
  await bash($, `${REVIEW('acme/web-api#12')} > /dev/null 2>&1 &`) // the Bash call returns at once; the review is still running
  const before = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect(await allText(before)).not.toContain('GPT')
  await before.unmount()

  w.csv = csvOf(csvRow({ timestamp: at(3) })) // the review ends and writes its row
  w.mtime = 2
  await clock.advance(130_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const text = await allText(ui)
  expect(text).toContain('codex · GPT')
  expect(text).toContain('Codex (GPT)')
  await ui.unmount()
})

test('a row stamped before the launch is not claimed, even with the same label', async ($, on) => {
  await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(0) }), csvRow({ timestamp: at(2) })) }) // launched at T0 + 1 min
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const text = await allText(ui)
  expect(text).toContain('codex · GPT') // one run, not two
  expect(text).not.toContain('codex ×')
  await ui.unmount()
})

test('one launch claims a plan run that failed and the API fallback it wrote: two runs, one Codex row', async ($, on) => {
  await launchedSetup($, on, ['acme/web-api#12'], {
    csv: csvOf(
      csvRow({ timestamp: at(3), exit_code: '3', input_tokens: '', cached_input_tokens: '', output_tokens: '', duration_s: '40' }),
      csvRow({ timestamp: at(5), auth: 'api', fell_back: 'yes' }),
    ),
  })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const agents = await agentRows(ui)
  expect(agents.map(a => a.left)).toEqual(['codex ×2 · GPT'])
  expect(agents[0]?.cost).toBe('≈$0.16') // only the fallback had tokens
  await ui.unmount()
})

test('two launches of the same label split the rows: each claims the ones after it, the rows after two hours are nobody\'s', async ($, on) => {
  const { w, clock } = codexSetup(on, { clockAt: T0 + MIN })
  await startSession($)
  await bash($, REVIEW('acme/web-api#12')) // T0 + 1 min
  await clock.set(T0 + 5 * MIN)
  await bash($, REVIEW('acme/web-api#12')) // the second review of the same PR, T0 + 5 min
  await clock.set(T0 + 10 * MIN)
  w.csv = csvOf(
    csvRow({ timestamp: at(-3) }), // before both: another terminal's, or an old one
    csvRow({ timestamp: at(2) }), // the first launch's
    csvRow({ timestamp: at(6) }), // the second's
    csvRow({ timestamp: at(5 + 130) }), // more than two hours after the latest launch: nobody's
  )
  w.mtime = 2
  await runMeter($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex ×2 · GPT'])
  await ui.unmount()
})

test('a --classify call is not a launch: the rows that follow it are not claimed', async ($, on) => {
  const { w } = codexSetup(on, { clockAt: T0 + MIN })
  await startSession($)
  await bash($, REVIEW('acme/web-api#12', '--classify '))
  await bash($, `${REVIEW('acme/web-api#12')} --classify`)
  w.csv = csvOf(csvRow({ timestamp: at(3) }))
  w.mtime = 2
  await runMeter($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect(await allText(ui)).not.toContain('GPT')
  await ui.unmount()
})

test('a review a subagent launches counts, and one the permission check denies does not', async ($, on) => {
  const { w } = codexSetup(on, { clockAt: T0 + MIN, deny: /web-api#13/ })
  await startSession($)
  await bash($, REVIEW('acme/web-api#12'), 'a1') // a subagent's Bash call
  await bash($, REVIEW('acme/web-api#13')) // denied: it never ran
  w.csv = csvOf(csvRow({ timestamp: at(3) }), csvRow({ timestamp: at(4), label: 'acme/web-api#13' }))
  w.mtime = 2
  await runMeter($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const agents = await agentRows(ui)
  expect(agents.map(a => a.left)).toEqual(['codex · GPT'])
  await ui.unmount()
})

test('launches are kept in the codex-2 atom, and a fresh load with that stored value claims its rows', async ($, on) => {
  const { w } = codexSetup(on, { clockAt: T0 + MIN })
  const mem = memoryState(on)
  await startSession($)
  await bash($, REVIEW('acme/web-api#12'))
  const first = mem.get('codex') as { shape: string; value: MeterCodex }
  expect(first.shape).toBe('codex-2')
  expect(first.value.launches).toEqual([{ label: 'acme/web-api#12', at: T0 + MIN }])
  // the new launch is not lost when the log is read: parse inside the write, launches kept
  w.csv = csvOf(csvRow({ timestamp: at(3) }))
  w.mtime = 2
  await runMeter($, '')
  const again = mem.get('codex') as { value: MeterCodex }
  expect(again.value.launches).toEqual([{ label: 'acme/web-api#12', at: T0 + MIN }])
  expect(again.value.totals.runs).toBe(1)
})

test('after a reload the stored launches still claim rows (the value in the atom is all it needs)', async ($, on) => {
  const kept = emptyCodex({ launches: [launch('acme/web-api#12', 1)] })
  const { w } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(3) }), csvRow({ timestamp: at(4), label: 'acme/other#1' })) })
  memoryState(on, { codex: { shape: 'codex-2', value: kept } })
  await startSession($) // a module that has just loaded: nothing in memory, the launch is in the atom
  expect(w.reads).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex · GPT'])
  await ui.unmount()
})

test('a missing log keeps the launches: the review starts, the file appears later, the row is claimed', async ($, on) => {
  const { w, clock } = codexSetup(on, { clockAt: T0 + MIN })
  await bash($, REVIEW('acme/web-api#12')) // no file yet: the empty write that follows must keep this launch
  await startSession($)
  await clock.advance(70_000) // a tick looks again: still no file
  w.csv = csvOf(csvRow({ timestamp: at(3) }))
  w.mtime = 2
  await clock.advance(70_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex · GPT'])
  await ui.unmount()
})

// -- the total tile, the limits row, the Codex bucket, the agent row ---------------------------------
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the session cost tile on ${surface} is Claude + Codex with the parts under it; with no Codex run it is as before`, async ($, on) => {
    await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(3) })), costUsd: 1 })
    await startSession($)
    await runMeter($, '') // books the session cost ($1.00)
    for (const columns of [120, 44]) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: columns } })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toContain('$1.16') // 1.00 + 0.159
      expect(texts).toContain('Claude $1.00')
      expect(texts).toContain(columns === 120 ? 'Codex ≈$0.16 API-eq' : 'Codex ≈$0.16') // the tile at 44 columns is 14 cells: no room for the longer wording
      expect(texts).not.toContain('list price')
      for (const t of texts.filter(x => x.startsWith('Claude $') || x.startsWith('Codex ≈'))) expect(t.length).toBeLessThanOrEqual(columns === 120 ? 39 : 13)
      await ui.unmount()
    }
  })

  test(`the session cost tile on ${surface} without Codex keeps "list price" and shows no Claude / Codex split`, async ($, on) => {
    codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(3) })) })
    await startSession($)
    await runMeter($, '')
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('$1.00')
    expect(texts).toContain('list price')
    expect(texts.filter(t => /^(Claude \$|Codex)/.test(t))).toEqual([])
    await ui.unmount()
  })
}

test('/meter reads "Session $X (Claude $a + Codex ≈$b API-eq)" once this session ran Codex, and stays one line', async ($, on) => {
  await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(3), input_tokens: '870000', cached_input_tokens: '0', output_tokens: '0' })), costUsd: 10.65 })
  await startSession($)
  const text = (await runMeter($, '')).text ?? ''
  expect(text).toContain('Session $12.39 (Claude $10.65 + Codex ≈$1.74 API-eq) · context')
  expect(text.includes('\n')).toBe(false)
  expect(text).not.toMatch(/Codex \d+ run/) // the old trailing "Codex N runs" is gone
})

const rl = (kind: string, percentUsed: number, resetsAt?: string): RateLimit => ({ kind, percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) })

test('claudeWindows keeps the 5-hour and weekly windows with a reading, as percent LEFT, and a reset only when it is still ahead', () => {
  const now = Date.parse('2026-11-09T10:00:00Z')
  expect(claudeWindows([rl('five_hour', 38, '2026-11-09T12:00:00Z'), rl('seven_day', 20.5, '2026-11-15T11:20:00Z'), rl('spend_limit', 90)], now)).toEqual([
    { kind: 'five_hour', leftPct: 62, resetsAt: Date.parse('2026-11-09T12:00:00Z') },
    { kind: 'seven_day', leftPct: 79.5, resetsAt: Date.parse('2026-11-15T11:20:00Z') },
  ])
  expect(claudeWindows([rl('seven_day', 130, '2026-11-09T09:00:00Z')], now)).toEqual([{ kind: 'seven_day', leftPct: 0, resetsAt: null }]) // over 100 used: 0 left; a past reset is not shown
  expect(claudeWindows([rl('five_hour', Number.NaN), { kind: 'seven_day' }, { kind: 'five_hour', percentUsed: 'x' }, 'no', null], now)).toEqual([])
  expect(claudeWindows([rl('five_hour', 10, 'tomorrow')], now)).toEqual([{ kind: 'five_hour', leftPct: 90, resetsAt: null }])
  expect(claudeWindows(undefined, now)).toEqual([])
  expect(claudeWindows([rl('five_hour', 10), rl('five_hour', 50)], now)[0]?.leftPct).toBe(90) // the first of a kind
  expect(claudeLimitLines([])).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the limits row on ${surface}: Claude windows from the engine, the typed Codex value, the estimate over every plan run on the machine, the usage link`, async ($, on) => {
    const entered = T0 + 10 * MIN
    const five = new Date(entered + 90 * MIN).toISOString()
    const week = new Date(entered + 5 * 24 * 60 * MIN).toISOString()
    const limits = { weekPct: 97, weekResetAt: entered + 6 * 24 * 60 * MIN, fiveHPct: null, fiveHResetAt: null, enteredAt: entered }
    // two plan runs finish after the entry, one before; none was launched by this session: the limit is account-wide
    const { clock } = codexSetup(
      on,
      {
        clockAt: entered,
        rateLimits: [rl('five_hour', 38, five), rl('seven_day', 20, week), rl('spend_limit', 99)],
        csv: csvOf(csvRow({ timestamp: at(5) }), csvRow({ timestamp: at(12) }), csvRow({ timestamp: at(15) }), csvRow({ timestamp: at(16), auth: 'api' }), csvRow({ timestamp: at(17), exit_code: '3' })),
      },
      { 'codex-limits-1': limits },
    )
    await startSession($)
    await clock.advance(30 * MIN)
    const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
    const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const text = lines.join('\n')
    expect(lines).toContain('Claude · 5h 62% left · week 80% left')
    expect(lines).toContain(`resets ${resetText(entered + 90 * MIN, true)} · ${resetText(Date.parse(week))}`)
    expect(lines).toContain('Codex · week 97% left')
    expect(lines).toContain(`resets ${resetText(limits.weekResetAt)} · typed 30m ago`)
    expect(lines).toContain('≈ 95.8% now (2 plan reviews since × ~0.6%)') // the api and the failed row do not count; the other terminal's do
    expect(text).not.toContain('spend_limit')
    expect(text).not.toContain('Plan limit')
    const link = await ui.find({ type: 'Link', text: 'chatgpt.com/settings/usage' })
    expect(link?.props.href).toBe('https://chatgpt.com/settings/usage')
    // the Codex part sits under the Claude part, below the tiles
    expect(lines.indexOf('Claude · 5h 62% left · week 80% left')).toBeLessThan(lines.indexOf('Codex · week 97% left'))
    expect(lines.indexOf('Context')).toBeLessThan(lines.indexOf('Claude · 5h 62% left · week 80% left'))
    await ui.unmount()
  })
}

test('the limits row at the docked width: every line fits 42 cells, the long estimate shortens, nothing is cut mid-number', async ($, on) => {
  const entered = T0 + 10 * MIN
  const limits = { weekPct: 97, weekResetAt: entered + 6 * 24 * 60 * MIN, fiveHPct: 80, fiveHResetAt: entered + 130 * MIN, enteredAt: entered }
  const { clock } = codexSetup(
    on,
    {
      clockAt: entered,
      rateLimits: [rl('five_hour', 38, new Date(entered + 90 * MIN).toISOString()), rl('seven_day', 20, new Date(entered + 5 * 24 * 60 * MIN).toISOString())],
      csv: csvOf(csvRow({ timestamp: at(12) }), csvRow({ timestamp: at(15) })),
    },
    { 'codex-limits-1': limits },
  )
  await startSession($)
  await clock.advance(5 * MIN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface }) // bodyColumns 44 -> 42 cells
    const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const row = lines.slice(lines.indexOf('Claude · 5h 62% left · week 80% left'))
    expect(row.length).toBeGreaterThan(5)
    expect(lines).toContain('Codex · week 97% left · 5h 80% left')
    expect(lines).toContain('≈ 95.8% now (2 reviews since)') // the full wording is 43 characters
    for (const t of row.slice(0, 7)) expect(t.length).toBeLessThanOrEqual(42)
    await ui.unmount()
  }
})

test('the limits row is hidden when there is nothing to say: no engine windows, nothing typed, Codex not run', async ($, on) => {
  codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })) }) // a log, but this session launched nothing
  await startSession($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
    const text = await allText(ui)
    expect(text).not.toMatch(/Claude ·|Codex ·|settings\/usage|week \d+% left/)
    expect(await ui.find({ type: 'Link', text: /settings\/usage/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the Claude part alone shows without any Codex line or link; windows with no reading draw nothing', async ($, on) => {
  codexSetup(on, { rateLimits: [rl('seven_day', 41)] })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(lines).toContain('Claude · week 59% left')
  expect(lines.join('\n')).not.toMatch(/Codex ·|5h/)
  expect(await ui.find({ type: 'Link', text: /settings\/usage/ })).toBeUndefined()
  await ui.unmount()
})

test('with Codex run and no limit typed the row says so and shows the command; typing one replaces the hint', async ($, on) => {
  await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(3) })) })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(lines).toContain('Codex · limit not typed yet')
  expect(lines).toContain('/meter codex <pct> <reset>, e.g. 97 6d2h')
  expect(await ui.find({ type: 'Link', text: 'chatgpt.com/settings/usage' })).toBeDefined()
  await ui.unmount()

  await runMeter($, 'codex 90 1d')
  const typed = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const after = (await typed.findAll({ type: 'Text' })).map(t => t.text)
  expect(after).toContain('Codex · week 90% left')
  expect(after).not.toContain('Codex · limit not typed yet')
  await typed.unmount()
})

test('once the week has reset the old number is not trusted: the row says to type a new one, the estimate and the 5-hour number are gone', async ($, on) => {
  const { clock } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })) })
  await startSession($)
  await runMeter($, 'codex 90 3h 5h=33 5hreset=1h')
  await clock.advance(2 * 60 * MIN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(lines).toContain('Codex · week 90% left · 5h has reset') // the week is still ahead (1 hour), only the 5-hour window passed
  expect(lines.join('\n')).not.toContain('33%')
  const five = (await runMeter($, 'codex')).text ?? ''
  expect(five).toContain('5h has reset')
  expect(five).not.toContain('33%')
  await ui.unmount()

  await clock.advance(2 * 60 * MIN)
  const late = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const text = await allText(late)
  expect(text).toContain('Codex · week has reset')
  expect(text).toContain('new value: /meter codex <pct> <reset>')
  expect(text).not.toMatch(/90%|33%|plan review/)
  const reply = (await runMeter($, 'codex')).text ?? ''
  expect(reply).toContain('week has reset, enter a new value')
  expect(reply).not.toContain('90%')
  await late.unmount()
})

// A Claude fixture and a Codex value, drawn together: `state.get` serves the meter-6 data and the codex-2 atom.
const withCodex = (over: Partial<MeterCodex> = {}): MeterCodex => emptyCodex({ totals: { runs: 3, durationS: 600, input: 1_200_000, cached: 900_000, output: 30_000, usd: 0.96 }, ...over })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Codex (GPT) is a bucket of its own in the Cost bar and the Tokens-written bar on ${surface}, with its own colour, and each legend column sums to 100`, async ($, on) => {
    const fixture = live({ costUsd: 3.4 })
    const codex = withCodex()
    on('state.get', (_, e) => storedCodex(fixture, codex, e))
    const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
    const legend = await legendRows(ui)
    const names = legend.map(r => r.name)
    expect(names).toEqual(['Opus (main)', 'Haiku', 'Sonnet', 'Opus (agents)', 'Codex (GPT)'])
    const cx = legend[4]
    expect(cx?.cost).toBe('≈$0.96')
    expect(cx?.tokens).toBe('30k') // tokens written = Codex's output
    const sum = (pick: (r: (typeof legend)[number]) => string) => legend.map(pick).reduce((a, p) => a + (p.startsWith('<') ? 0 : Number.parseInt(p, 10)), 0)
    expect(sum(r => r.costPct)).toBe(100)
    expect(sum(r => r.tokensPct)).toBe(100)
    // a colour no Claude bucket has, the same on both bars' legend
    const colours = legend.map(r => r.color)
    expect(new Set(colours).size).toBe(colours.length)
    expect(cx?.color).toBe(surface === 'terminal' ? 'diffRemovedWord' : PALETTES.neutral.codex)
    if (surface === 'desktop') {
      const bars = (await ui.findAll({ type: 'Svg' })).filter(x => /^Cost by who|^Tokens written by who/.test(String(x.props.alt)))
      expect(bars).toHaveLength(2)
      for (const b of bars) expect(String(b.props.source)).toContain(PALETTES.neutral.codex)
      expect(String(bars[0]?.props.alt)).toContain('total $4.36') // 3.40 + 0.96
    }
    await ui.unmount()
  })
}

test('a Codex run too small to show ($0.00 and nothing written) adds no bucket, but its agent row stays', async ($, on) => {
  const fixture = live()
  const codex = emptyCodex({ totals: { runs: 1, durationS: 5, input: 100, cached: 0, output: 0, usd: 0.0002 } })
  on('state.get', (_, e) => storedCodex(fixture, codex, e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect((await legendRows(ui)).map(r => r.name)).not.toContain('Codex (GPT)')
  expect((await agentRows(ui)).map(r => r.left)).toContain('codex · GPT')
  await ui.unmount()
})

test('the codex agent row: "codex ×N · GPT", input tokens read, output tokens written, ≈$, sorted with the rest, inside the 8-row cap', async ($, on) => {
  let shown: [Fixture, MeterCodex] = [live(), withCodex({ totals: { runs: 3, durationS: 600, input: 1_200_000, cached: 900_000, output: 30_000, usd: 0.96 } })]
  on('state.get', (_, e) => storedCodex(shown[0], shown[1], e))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const agents = await agentRows(ui)
  // verifier $1.04, codex $0.96, implementer $0.92, scout $0.06
  expect(agents.map(a => a.left)).toEqual(['verifier · Opus · running', 'codex ×3 · GPT', 'implementer · Sonnet', 'scout · Haiku'])
  expect(agents[1]).toMatchObject({ io: '1.2M / 30k', cost: '≈$0.96' })
  await ui.unmount()

  // nine other agent types and a cheap Codex: the cap of 8 cuts the cheapest, which is Codex
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, name: `agent-${i}`, model: 'Sonnet', bucket: 'sonnet' as const, read: 10, written: 1, usd: 5 + i, status: 'done' as const, startedAt: NOW, endedAt: NOW, warned: false }))
  shown = [live({ agents: nine }), emptyCodex({ totals: { runs: 1, durationS: 1, input: 10, cached: 0, output: 5, usd: 0.5 } })]
  const crowded = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  const rowsDrawn = await agentRows(crowded)
  expect(rowsDrawn).toHaveLength(8)
  expect(rowsDrawn.map(r => r.left).join(' ')).not.toContain('codex')
  expect(await allText(crowded)).toContain('2 more agent types not shown')
  await crowded.unmount()
})

// what codex-1 stored: rows from the whole machine, no launches
const OLD_CODEX = { runs: [runOf()], totals: { runs: 5, durationS: 9, input: 9_000_000, cached: 0, output: 500_000, usd: 99 }, planDoneAt: [T0], tooBig: true }
for (const shape of ['codex-1', 'codex-2'] as const) {
  test(`a stored ${shape} value in the old format (rows, no launches) never crashes the pane and shows nothing: declined by its tag, or emptied`, async ($, on) => {
    on('state.get', (_, e) => (e.key === 'codex' ? { value: { version: 1, value: { shape, value: OLD_CODEX } } } : stored(live(), e)))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
      const text = await allText(ui)
      expect(text).toContain('Session cost')
      expect(text).not.toMatch(/Codex|GPT|99\.00|over 4 MB/)
      expect(text).not.toContain('Meter is resetting')
      await ui.unmount()
    }
    expect(saneCodex(OLD_CODEX)).toEqual(emptyCodex())
  })
}

test('a log over 4 MB, a failed read and a missing file never leave the pane without a tree', async ($, on) => {
  const { w } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })), size: 5 * 1024 * 1024 })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect(await allText(ui)).toContain('Codex log over 4 MB')
  await ui.unmount()
  w.size = undefined
  w.csv = undefined
  w.mtime = 3
  await runMeter($, '')
  const gone = await $.ui.mount({ ...PANE, surface: 'terminal', props: WIDE })
  expect(await allText(gone)).not.toContain('Codex')
  expect(await allText(gone)).not.toContain('Meter is resetting')
  await gone.unmount()
})

test('11 launched runs: the atom keeps the last 8, the total, the bar and the agent row count all 11, and there is no Codex section of its own', async ($, on) => {
  const labels = Array.from({ length: 11 }, (_, i) => `acme/web-api#${i + 1}`)
  const setup = codexSetup(on, { clockAt: T0 + MIN, csv: csvOf(...labels.map((label, i) => csvRow({ timestamp: at(i + 1), label, input_tokens: '1000000', cached_input_tokens: '0', output_tokens: '0' }))), costUsd: 0 })
  const mem = memoryState(on)
  for (const label of labels) await bash($, REVIEW(label))
  await setup.clock.set(T0 + 10 * MIN)
  await startSession($)
  const kept = (mem.get('codex') as { value: MeterCodex }).value
  expect(kept.runs).toHaveLength(8)
  expect(kept.runs.at(-1)?.label).toBe('acme/web-api#11')
  expect(kept.totals.runs).toBe(11)
  expect(kept.launches).toHaveLength(11)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('$22.00') // 11 x 1M uncached input at $2, in the session total
    expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex ×11 · GPT'])
    expect(texts).not.toContain('Codex') // no title of its own
    expect(texts.filter(t => /^(GitHub|Who did the work|Dollars per step)/.test(t)).map(t => t.split(' ')[0])).toEqual(['Who', 'GitHub', 'Dollars'])
    await ui.unmount()
  }
})
test('the mod reads ONE path and nothing else: stat and read see only ~/.amiqa/codex-review-runs.csv, never ~/.codex, no other fs call', async ($, on) => {
  const { w, clock } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })) })
  const spawned: string[] = []
  on('process.run', (_, e) => {
    spawned.push(e.argv.join(' '))

    return gh('[]')
  })
  await startSession($)
  await runMeter($, '')
  await runMeter($, 'codex 97 6d2h')
  await runMeter($, 'codex')
  await $.tool.call({ tool: 'Bash', command: 'bash .claude/bin/codex-review.sh 12' })
  w.mtime = 9
  await clock.advance(70_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()

  expect(w.stats.length).toBeGreaterThan(2)
  expect(w.reads.length).toBeGreaterThan(0)
  expect(new Set([...w.stats, ...w.reads])).toEqual(new Set([CODEX_PATH]))
  expect(w.others).toEqual([])
  expect(spawned.filter(a => /codex/.test(a))).toEqual([])
})

test('an unchanged file is not read again, a changed one is: the stat decides', async ($, on) => {
  const { w, clock } = await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(2) })) }) // the launch's own look is the one read
  await startSession($)
  expect(w.reads).toHaveLength(1)

  await clock.advance(130_000) // two minutes of ticks: stat every minute, no read
  expect(w.stats.length).toBeGreaterThan(1)
  expect(w.reads).toHaveLength(1)
  await runMeter($, '')
  expect(w.reads).toHaveLength(1)

  w.csv = csvOf(csvRow({ timestamp: at(2) }), csvRow({ timestamp: at(4) })) // a second run of the same review
  w.mtime = 2
  await clock.advance(70_000)
  expect(w.reads).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex ×2 · GPT'])
  await ui.unmount()
})

test('a Bash call that ran codex-review re-reads the log at once; any other Bash call does not', async ($, on) => {
  const { w } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(-300) })) })
  await startSession($)
  w.csv = csvOf(csvRow({ timestamp: at(-300) }), csvRow({ timestamp: at(11), label: 'acme/web-api#30' })) // stamped after the launch below (T0 + 10 min)
  w.mtime = 5
  const readsBefore = w.reads.length

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(w.reads).toHaveLength(readsBefore)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect(w.reads).toHaveLength(readsBefore)
  await $.tool.call({ tool: 'Bash', command: '.claude/bin/codex-review.sh --label acme/web-api#30 30', agentId: 'a1' }) // a subagent counts too
  expect(w.reads).toHaveLength(readsBefore + 1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex · GPT'])
  await ui.unmount()
})

test('no email and no local path from the CSV reaches the pane, the one-line summary or a /meter codex answer', async ($, on) => {
  await launchedSetup($, on, ['acme/web-api#12', 'acme/web-api#13'], { csv: csvOf(csvRow({ timestamp: at(2) }), csvRow({ timestamp: at(3), label: 'acme/web-api#13', auth: 'none', skip_reason: 'no_code' })) })
  await startSession($)
  const shown: string[] = []
  const said = [await runMeter($, ''), await runMeter($, 'codex 97 6d2h'), await runMeter($, 'codex'), await runMeter($, 'codex nonsense')]
  for (const r of said) shown.push(r.text ?? '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    shown.push(JSON.stringify(await ui.findAll({ type: 'Text' })), JSON.stringify(await ui.findAll({ type: 'Box' })), JSON.stringify(await ui.findAll({ type: 'Link' })))
    await ui.unmount()
  }
  const all = shown.join('\n')

  expect(all).toContain('codex · GPT') // it did draw the run
  expect(all).not.toContain('@')
  expect(all).not.toContain('/Users/')
  expect(all).not.toContain('example.com')
  expect(all).not.toContain('0123456789abcdef')
})

test('parseDuration and parsePercent: the shapes /meter codex takes, nothing else', () => {
  const m = 60_000
  expect(parseDuration('6d2h', 7 * 24 * 60 * m)).toBe((6 * 24 * 60 + 2 * 60) * m)
  expect(parseDuration('2h10m', 7 * 24 * 60 * m)).toBe(130 * m)
  expect(parseDuration('45m', 7 * 24 * 60 * m)).toBe(45 * m)
  expect(parseDuration('1d', 7 * 24 * 60 * m)).toBe(24 * 60 * m)
  for (const bad of ['', '0m', '0d0h', '6', 'd', '2h6d', '10m2h', '1.5h', '-3h', '6 d', '6dd', '8d', 'abc', '2h10', '99999h']) expect(parseDuration(bad, 7 * 24 * 60 * m)).toBeUndefined()
  expect(parseDuration('6h', 5 * 60 * m)).toBeUndefined() // the 5-hour window cannot reset in 6 hours
  expect(parsePercent('0')).toBe(0)
  expect(parsePercent('97')).toBe(97)
  expect(parsePercent('97.5')).toBe(97.5)
  expect(parsePercent('100')).toBe(100)
  for (const bad of ['', '101', '-1', '97%', '97.55', '1e2', ' 5', 'x', '100.5', '1000']) expect(parsePercent(bad)).toBeUndefined()
})

test('parseCodexArgs: show, <pct> <reset>, the optional 5h pair, and a rejection for everything else', () => {
  const m = 60_000
  expect(parseCodexArgs('')).toBe('show')
  expect(parseCodexArgs('   ')).toBe('show')
  expect(parseCodexArgs('97 6d2h')).toEqual({ weekPct: 97, weekMs: (6 * 24 * 60 + 120) * m, fiveHPct: null, fiveHMs: null })
  expect(parseCodexArgs('97 6d2h 5h=80 5hreset=2h10m')).toEqual({ weekPct: 97, weekMs: (6 * 24 * 60 + 120) * m, fiveHPct: 80, fiveHMs: 130 * m })
  expect(parseCodexArgs('50 1d 5hreset=45m 5h=0')).toMatchObject({ fiveHPct: 0, fiveHMs: 45 * m })
  for (const bad of ['97', '97 soon', '101 6d', '97 6d2h 5h=80', '97 6d2h 5hreset=2h', '97 6d2h 5h=80 5hreset=9h', '97 6d2h 5h=80 5h=70', '97 6d2h 5h=80 foo=1', '97 6d2h x y', '97 6d2h 5h=80 5hreset=2h 1', 'a b', '97 6d2h 5h=abc 5hreset=2h']) {
    expect(parseCodexArgs(bad)).toBeUndefined()
  }
})

test('/meter codex stores the limit and answers in one line; /meter codex alone shows it; bad input is rejected and stores nothing', async ($, on) => {
  const { store } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })) })
  await startSession($)
  const now = T0 + 10 * MIN

  const empty = (await runMeter($, 'codex')).text ?? ''
  expect(empty).toContain('not set')

  const saved = (await runMeter($, 'codex 97 6d2h 5h=80 5hreset=2h10m')).text ?? ''
  expect(saved.includes('\n')).toBe(false)
  expect(saved).toContain('97% week left')
  expect(saved).toContain(`resets ${resetText(now + (6 * 24 + 2) * 60 * MIN)}`)
  expect(saved).toContain(`5h: 80% left, resets ${resetText(now + 130 * MIN, true)}`)
  expect(saved).toContain('entered just now')
  expect(store.get('codex-limits-1')).toEqual({ weekPct: 97, weekResetAt: now + (6 * 24 + 2) * 60 * MIN, fiveHPct: 80, fiveHResetAt: now + 130 * MIN, enteredAt: now })

  const shown = (await runMeter($, 'codex')).text ?? ''
  expect(shown).toContain('97% week left')
  expect(shown.includes('\n')).toBe(false)

  const before = store.get('codex-limits-1')
  for (const bad of ['codex 150 6d', 'codex 97', 'codex 97 whenever', 'codex 97 6d2h 5h=80']) {
    const out = (await runMeter($, bad)).text ?? ''
    expect(out).toMatch(/^Usage: \/meter codex <pct> <reset>/)
    expect(out.includes('\n')).toBe(false)
  }
  expect(store.get('codex-limits-1')).toEqual(before)
  expect((await runMeter($, 'codexx 97 6d')).text).toContain('Session $') // another word is not the codex command
})

test('codexEstimate, saneLimits, resetText and agoText', () => {
  const limits = { weekPct: 50, weekResetAt: 1000, fiveHPct: null, fiveHResetAt: null, enteredAt: 100 }
  const codex = { runs: [], totals: { runs: 0, durationS: 0, input: 0, cached: 0, output: 0, usd: 0 }, planDoneAt: [50, 100, 101, 200, 300], launches: [], tooBig: false }
  expect(codexEstimate(limits, codex, 500)).toEqual({ pct: 50 - 3 * 0.6, reviews: 3 }) // strictly after the entry
  expect(codexEstimate(limits, codex, 1000)).toBeUndefined()
  expect(codexEstimate({ ...limits, weekPct: 1 }, codex, 500)?.pct).toBe(0) // never below 0

  expect(saneLimits({ weekPct: 97, weekResetAt: 5, enteredAt: 1, fiveHPct: 80 })).toEqual({ weekPct: 97, weekResetAt: 5, enteredAt: 1, fiveHPct: null, fiveHResetAt: null })
  expect(saneLimits({ weekPct: 197, weekResetAt: 5, enteredAt: 1 })).toBeUndefined()
  expect(saneLimits('x')).toBeUndefined()
  expect(resetText(Date.parse('2026-11-15T12:20:00'))).toBe('Sun 15/11 12:20') // local time, as the machine reads it
  expect(resetText(Date.parse('2026-11-15T12:20:00'), true)).toBe('12:20')
  expect(agoText(30_000)).toBe('just now')
  expect(agoText(3 * 60 * MIN)).toBe('3h ago')
  expect(agoText(5 * MIN)).toBe('5m ago')
  expect(agoText(72 * 60 * MIN)).toBe('3d ago')
})

// -- fix round: corrupt stored limits, the 4 MiB cap, invisible characters, surrogates, stricter durations ------
test('saneLimits drops a value whose times make no sense; the corrupt one from the review draws no NaN', async ($, on) => {
  const corrupt = { weekPct: 97, weekResetAt: 1e300, fiveHPct: null, fiveHResetAt: null, enteredAt: -1e300 }
  expect(saneLimits(corrupt)).toBeUndefined()
  const day = 24 * 60 * MIN
  const ok = { weekPct: 50, weekResetAt: 1000 + 6 * day, enteredAt: 1000, fiveHPct: 40, fiveHResetAt: 1000 + 60 * MIN }
  expect(saneLimits(ok)).toEqual(ok)
  expect(saneLimits({ ...ok, enteredAt: 0 })).toBeUndefined() // entered after 0
  expect(saneLimits({ ...ok, enteredAt: -5 })).toBeUndefined()
  expect(saneLimits({ ...ok, weekResetAt: 999 })).toBeUndefined() // resets before it was entered
  expect(saneLimits({ ...ok, weekResetAt: 1000 + 7 * day + 1 })).toBeUndefined()
  expect(saneLimits({ ...ok, weekResetAt: 1000 + 7 * day })?.weekPct).toBe(50)
  // the 5-hour part is dropped alone when it is out of its window; the week stays
  expect(saneLimits({ ...ok, fiveHResetAt: 1000 + 5 * 60 * MIN + 1 })).toMatchObject({ weekPct: 50, fiveHPct: null, fiveHResetAt: null })
  expect(saneLimits({ ...ok, fiveHResetAt: 999 })).toMatchObject({ fiveHPct: null, fiveHResetAt: null })
  expect(saneLimits({ ...ok, fiveHPct: 101 })).toMatchObject({ fiveHPct: null, fiveHResetAt: null })

  codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })) }, { 'codex-limits-1': corrupt })
  await startSession($)
  expect((await runMeter($, 'codex')).text).toContain('not set') // the bad value is as good as none
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  const text = await allText(ui)
  expect(text).not.toMatch(/NaN|e\+|Infinity/)
  expect(text).not.toMatch(/Codex ·|% left/) // the corrupt value draws nothing, and nothing launched here: the row is not there
  await ui.unmount()
})

test('a log over 4 MiB is not read: the last good rows stay with one muted line, and nothing is re-read until it changes', async ($, on) => {
  const { w, clock } = await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(2) })) })
  await startSession($)
  expect(w.reads).toHaveLength(1)

  w.size = 4 * 1024 * 1024 + 1
  w.mtime = 2
  await runMeter($, '')
  await clock.advance(200_000)
  await runMeter($, '')
  expect(w.reads).toHaveLength(1) // not asked for, then not asked again
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } })
    const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(lines).toContain('Codex log over 4 MB, rotate ~/.amiqa/codex-review-runs.csv')
    expect((await ui.find({ type: 'Text', text: /^Codex log over/ }))?.props.dimColor).toBe(true)
    expect(lines.join('\n')).toContain('codex · GPT') // the last good read is still drawn
    await ui.unmount()
  }

  w.size = undefined // rotated: small again
  w.mtime = 3
  w.csv = csvOf(csvRow({ timestamp: at(4) }), csvRow({ timestamp: at(5) }))
  await runMeter($, '')
  expect(w.reads).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  const text = await allText(ui)
  expect(text).not.toContain('over 4 MB')
  expect(text).toContain('codex ×2 · GPT')
  await ui.unmount()
})

test('a log that is over 4 MiB from the start shows only the muted line, and a read that fails is not retried until the file changes', async ($, on) => {
  const { w, clock } = codexSetup(on, { csv: csvOf(csvRow({ timestamp: at(2) })), size: 5 * 1024 * 1024 })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = await allText(ui)
  expect(text).toContain('Codex log over 4 MB')
  expect(text).not.toContain('acme/web-api#12')
  expect(w.reads).toHaveLength(0)
  await ui.unmount()

  // a read the engine refuses for another reason: tried once per file state
  w.size = undefined
  w.mtime = 7
  w.failRead = true
  await clock.advance(70_000)
  await clock.advance(70_000)
  await runMeter($, '')
  expect(w.reads).toHaveLength(1)
})

test('a refresh asked for while one is running is not lost: one more follows', async ($, on) => {
  const { w } = await launchedSetup($, on, ['acme/web-api#12'], { csv: csvOf(csvRow({ timestamp: at(2) })) }) // the launch's own look is stat 1
  let release: () => void = () => undefined
  w.gate = new Promise<void>(resolve => {
    release = resolve
  })
  const starting = startSession($)
  while (w.stats.length < 2) await new Promise(resolve => setTimeout(resolve, 1))

  w.csv = csvOf(csvRow({ timestamp: at(2) }), csvRow({ timestamp: at(3) }))
  w.mtime = 2
  w.gate = undefined
  await runMeter($, '') // asked for while the first stat is still waiting
  release()
  await starting
  while (w.stats.length < 3) await new Promise(resolve => setTimeout(resolve, 1))
  while (w.reads.length < 2) await new Promise(resolve => setTimeout(resolve, 1))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  expect((await agentRows(ui)).map(a => a.left)).toEqual(['codex ×2 · GPT'])
  await ui.unmount()
})

test('clean strips zero-width and bidi marks, line and paragraph separators and the BOM; a label with them is cleaned at parse time', () => {
  expect(clean('a\u200fb\u200bc\u061cd')).toBe('a b c d')
  expect(clean('a\u2028b\u2029c\ufeffd\u200ee')).toBe('a b c d e')
  const out = parseCodex(csvOf(csvRow({ label: 'acme/a\u200fb\u200bc\u061cd\u2028e\ufeff#1' })), 0)
  expect(out.runs[0]?.label).toBe('acme/a b c d e #1')
})

test('truncate never leaves half an emoji', () => {
  const cut = truncate(`${'a'.repeat(38)}😀b`, 40)
  expect(cut).toBe(`${'a'.repeat(38)}…`)
  expect(/[\ud800-\udbff]$/.test(cut.slice(0, -1))).toBe(false)
  expect(truncate(`${'a'.repeat(37)}😀bb`, 40)).toBe(`${'a'.repeat(37)}😀…`) // a whole one still fits
  expect(truncate('😀😀😀', 3)).toBe('😀…')
  expect(truncate('😀😀😀', 2)).toBe('…')
  expect(truncate('abcdef', 4)).toBe('abc…')
})

test('parseCodex: with a duplicated header name the first column wins; a timestamp without the Z is rejected', () => {
  const cols = [...CODEX_HEADER.split(','), 'label']
  const dup = `${cols.join(',')}\n${csvRow({ label: 'acme/first#1' }, CODEX_HEADER.split(',')).concat(',acme/second#2')}\n`
  expect(parseCodex(dup, 0).runs.map(r => r.label)).toEqual(['acme/first#1'])

  const noZ = csvRow({ timestamp: '2026-11-09T09:00:00' })
  const offset = csvRow({ timestamp: '2026-11-09T09:00:00+01:00' })
  const dateOnly = csvRow({ timestamp: '2026-11-09' })
  expect(parseCodex(csvOf(noZ, offset, dateOnly), 0).runs).toEqual([])
  expect(parseCodex(csvOf(csvRow({ timestamp: '2026-11-09T09:00:00Z' })), 0).runs).toHaveLength(1)
})

test('parseDuration rejects minutes of 60 or more, and hours of 24 or more next to days', () => {
  const week = 7 * 24 * 60 * MIN
  for (const bad of ['1h60m', '60m', '99m', '1d24h', '1d30h', '2d25h10m']) expect(parseDuration(bad, week)).toBeUndefined()
  expect(parseDuration('59m', week)).toBe(59 * MIN)
  expect(parseDuration('30h', week)).toBe(30 * 60 * MIN) // hours alone may pass a day
  expect(parseDuration('1d23h59m', week)).toBe((24 * 60 + 23 * 60 + 59) * MIN)
  expect(parseCodexArgs('97 1h60m')).toBeUndefined()
  expect(parseCodexArgs('97 6d2h 5h=80 5hreset=1h60m')).toBeUndefined()
})

test('a label ending in a line break does not swallow the rows after it: the last 500 records are kept, not the last 500 lines', () => {
  const rows = [csvRow({ label: 'acme#x\n' }), ...Array.from({ length: 499 }, (_, i) => csvRow({ label: `acme/web-api#${i}` }))]
  const out = parseCodex(csvOf(...rows), 0)
  expect(out.totals.runs).toBe(500)
  expect(out.runs[out.runs.length - 1]?.label).toBe('acme/web-api#498')
  const more = parseCodex(csvOf(csvRow({ label: 'acme#old' }), ...rows), 0) // 501 records: the oldest goes
  expect(more.totals.runs).toBe(500)
})

test('clean keeps a zero-width joiner, so a joined emoji is not split', () => {
  expect(clean('👨‍👩‍👧')).toBe('👨‍👩‍👧')
  expect(clean('a\u200db')).toBe('a\u200db')
  expect(clean('a\u200cb\u200eb')).toBe('a b b')
})
