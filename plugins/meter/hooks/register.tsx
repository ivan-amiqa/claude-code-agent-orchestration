import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { MeterAgent, MeterBucket, MeterData, MeterGroup, MeterPr, MeterPrFetch, MeterPrKind } from '../types'

// ---------------------------------------------------------------------------
// ZERO MODEL TOKENS. This mod never asks a model anything, never adds a tool,
// never touches a prompt and never rewrites a tool result. It reads numbers
// the engine already reports (cost, context, usage, agent ids) and draws them.
// The one thing it reads out of text is GitHub PR URLs in a Bash command and
// its result (see `prUrlsIn`); nothing else from prompts or outputs.
// ---------------------------------------------------------------------------

const PANE = 'meter'
const TITLE = 'Meter'

const EMPTY: MeterData = {
  costUsd: 0,
  contextTokens: 0,
  mainModel: 'Opus',
  nowMs: 0,
  lastResponseAt: null,
  cacheTtl: '1h',
  cacheTtlSource: 'assumed',
  coldToasted: false,
  crossed: 0,
  costCursor: null,
  spend: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 },
  written: { 'opus-main': 0, haiku: 0, sonnet: 0, 'opus-checks': 0 },
  agents: [],
  groups: [],
  groupSize: 1,
  compactAt: null,
  guardLines: [],
  lastVerifierAt: null,
}

// Bump the `shape` tag on every MeterData change: an older stored value is then
// declined and EMPTY is used. (`sane` below also repairs a same-tag value that
// is missing a field, so a half-written value can never wedge the pane.)
// meter-6: the tracked PRs moved out into their own atom (below).
const data = atom({ plugin: 'meter', key: 'data' } as const, EMPTY, { shape: 'meter-6' })

// The tracked PRs live in an atom of their own, so a bump of `data`'s tag above
// never wipes them. Bump `ci-1` only when MeterPr itself changes.
const EMPTY_CI: MeterPr[] = []
const ciAtom = atom({ plugin: 'meter', key: 'ci' } as const, EMPTY_CI, { shape: 'ci-1' })

const MAX_GROUPS = 12 // columns of the Dollars chart, step 1 alone included
const MAX_AGENTS = 60
const MAX_PRS = 8
const WARN_AT = 350_000
const BAD_AT = 500_000
// Below this a fresh session no longer saves much: one re-write is small.
const FRESH_AT = 115_000

// ---------------------------------------------------------------------------
// Colours. Box and Text use theme keys, so light and dark mode follow;
// `claude` (orange) means Opus and nothing else.
//
// SVG decision: an `Svg` element is drawn isolated from its source string and
// takes no theme key, so the charts on desktop, vscode and mobile carry their
// own hex palettes (see PALETTES), picked from the person's theme row. The
// terminal has no `Svg`: it keeps the cell charts below, in theme keys.
// ---------------------------------------------------------------------------
const OK: Color = 'success'
const WARN: Color = 'warning'
const BAD: Color = 'error'
const MARK: Color = 'text' // contrasts with every zone colour and the track
const GREY: Color = 'inactive' // the cost nobody booked to a bucket

const MODEL_COLOR: Record<MeterBucket, Color> = {
  'opus-main': 'claude',
  haiku: 'planMode', // teal
  sonnet: 'ide', // blue
  'opus-checks': 'merged', // purple: Opus again, told apart from main
}
const BUCKETS: MeterBucket[] = ['opus-main', 'haiku', 'sonnet', 'opus-checks']
const BUCKET_LABEL: Record<MeterBucket, string> = {
  'opus-main': 'Opus (main)',
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  'opus-checks': 'Opus (agents)',
}

type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Link'>
/** `Svg`, where the surface has it (desktop, vscode, mobile); the terminal does not. */
type SvgTag = Elements['desktop']['Svg'] | undefined
type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'
type Dollar = EngineInterface

// -- formatting -------------------------------------------------------------
const usd = (n: number) => `$${n.toFixed(2)}`
// Under 1k as is; k with no decimals; 1.1M style at and over a million.
export const tokens = (n: number) => (n >= 999_500 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
export const truncate = (text: string, room: number): string => (text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`)

// Text from outside (PR titles, check names, agent names) may hold control
// characters; the engine refuses a whole Pane tree that has one in a text
// child. C0 (tab, newline, CR, ESC, BEL, NUL), DEL, C1 (U+009B is CSI) and the
// bidi embedding / override / isolate marks all become a space.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
export const clean = (s: string): string => s.replace(CONTROL, ' ')
const MAX_NAME = 40
/** An agent's name as stored and drawn: no control characters, at most 40 characters. */
export const agentName = (s: string): string => truncate(clean(s), MAX_NAME)

const family = (model: string): string =>
  /haiku/i.test(model) ? 'Haiku' : /sonnet/i.test(model) ? 'Sonnet' : /opus/i.test(model) ? 'Opus' : model
const bucketOf = (model: string): MeterBucket =>
  /haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : 'opus-checks'
const mainBucketOf = (model: string): MeterBucket =>
  /haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : 'opus-main'
const isType = (name: string, wanted: string) => name === wanted || name.endsWith(`:${wanted}`)

const MIN = 60_000
const TTL_MS = { '5m': 5 * MIN, '1h': 60 * MIN } as const

type CacheState = 'none' | 'warm' | 'cooling' | 'cold'
function cacheInfo(d: MeterData): { state: CacheState; leftMs: number } {
  if (d.lastResponseAt === null) return { state: 'none', leftMs: 0 }
  const leftMs = TTL_MS[d.cacheTtl] - (d.nowMs - d.lastResponseAt)
  return { state: leftMs <= 0 ? 'cold' : leftMs <= 10 * MIN ? 'cooling' : 'warm', leftMs }
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const leftShort = (leftMs: number) => (leftMs > 10 * MIN ? `${Math.ceil(leftMs / MIN)}m` : clock(leftMs))
const leftLong = (leftMs: number) => (leftMs > 10 * MIN ? `${Math.ceil(leftMs / MIN)} min left` : `${clock(leftMs)} left`)

const contextZone = (n: number): Color => (n < WARN_AT ? OK : n <= BAD_AT ? WARN : BAD)

function agentCounts(d: MeterData): string {
  const by = new Map<string, number>()
  for (const a of d.agents) by.set(a.model, (by.get(a.model) ?? 0) + 1)
  const order = ['Haiku', 'Sonnet', 'Opus']
  const names = [...by.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)

    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib)
  })

  return names.map(n => `${by.get(n)} ${n}`).join(', ')
}

/**
 * The status line is empty unless something needs attention. One entry at a
 * time, in this order: context >= 500k, context >= 350k, cache cold while a
 * re-write would still be big. `undefined` clears the entry.
 */
function statusLine(d: MeterData): string | undefined {
  if (d.contextTokens >= BAD_AT) return `Meter: context ${tokens(d.contextTokens)} — start fresh`
  if (d.contextTokens >= WARN_AT) return `Meter: context ${tokens(d.contextTokens)} — consider /compact`
  if (cacheInfo(d).state === 'cold' && d.contextTokens > FRESH_AT) return 'Meter: cache cold — fresh session cheaper'

  return undefined
}

function ciWorst(prs: MeterPr[]): string {
  if (prs.some(p => p.fail > 0)) return 'failing'
  if (prs.some(p => p.pending > 0)) return 'running'
  if (prs.some(p => p.fetch !== 'ok')) return 'unknown'

  return 'passing'
}

export function summary(d: MeterData, ci: MeterPr[]): string {
  const c = cacheInfo(d)
  const cache = c.state === 'none' ? 'cache n/a' : c.state === 'cold' ? 'cache cold' : `cache ${c.state} ${leftShort(c.leftMs)}`
  const agents = d.agents.length > 0 ? ` · ${d.agents.length} agent${d.agents.length === 1 ? '' : 's'}` : ''
  const prs = ci.length > 0 ? ` · CI: ${ci.length} PR${ci.length === 1 ? '' : 's'}, ${ciWorst(ci)}` : ''

  return `Session ${usd(d.costUsd)} · context ${tokens(d.contextTokens)} · ${cache}${agents}${prs}`
}

// ---------------------------------------------------------------------------
// PR URL detection. The ONLY text this mod reads out of a command or a result.
// ---------------------------------------------------------------------------
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/
const PR_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
// Candidates run up to whitespace, a quote or a bracket, so `;`, `|`, `&`,
// `$` and a backtick stay INSIDE the candidate and make the anchored check
// fail: `.../pull/1;rm -rf ~` is rejected, not trimmed to `.../pull/1`.
// Bounded ({1,300}) so a long run of punctuation can never cost more than a
// linear scan; a candidate cut at 300 fails the anchored check anyway.
const URL_CANDIDATE = /https:\/\/github\.com\/[^\s"'<>()[\]]{1,300}/g
const MAX_CANDIDATES = 500

export function prUrlsIn(text: string): string[] {
  const found: string[] = []
  const matches = text.match(URL_CANDIDATE) ?? []
  for (const m of matches.slice(0, MAX_CANDIDATES)) {
    // Trim trailing sentence punctuation with a loop, not an end-anchored regex.
    let end = m.length
    while (end > 0 && '.,:'.includes(m.charAt(end - 1))) end--
    const candidate = m.slice(0, end)
    if (PR_URL.test(candidate)) found.push(candidate)
  }

  return found
}

/**
 * Only a command that is itself `gh pr create|view|checks|merge` may feed PR URLs:
 * at the start of the command or right after `&&`, `||`, `;` or `|`, so
 * `echo gh pr view <url>` does not count.
 */
const GH_PR_COMMAND = /(?:^|&&|\|\||;|\|)\s*gh\s+pr\s+(?:create|view|checks|merge)(?:\s|$)/
export const isGhPrCommand = (command: string): boolean => GH_PR_COMMAND.test(command)

// gh flags that take no value; any OTHER flag is assumed to take one, so the
// token after it (`--interval 10`, `--repo a/b`) is never read as the PR number.
const BOOL_FLAGS = new Set([
  '--watch', '--web', '--fail-fast', '--required', '--comments', '--squash', '--merge', '--rebase', '--auto', '--admin',
  '--delete-branch', '--disable-auto', '--draft', '--fill', '--fill-first', '--fill-verbose', '--dry-run',
  '--no-maintainer-edit', '-w', '-c', '-s', '-m', '-r', '-d',
])
const SHELL_BREAK = new Set(['&&', '||', ';', '|'])

/** `gh pr view 12 --repo owner/name` -> a validated URL, or nothing. */
export function prUrlFromGh(command: string): string | undefined {
  const words = command.split(/\s+/)
  const at = words.findIndex((w, i) => w === 'gh' && words[i + 1] === 'pr' && /^(create|merge|view|checks)$/.test(words[i + 2] ?? ''))
  if (at < 0) return undefined
  const after = words.slice(at + 3)
  const cut = after.findIndex(w => SHELL_BREAK.has(w))
  const rest = cut < 0 ? after : after.slice(0, cut)
  let number: string | undefined
  let repo: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? ''
    if (w.startsWith('--repo=')) repo = w.slice('--repo='.length)
    else if (w === '--repo' || w === '-R') {
      repo = rest[i + 1]
      i++
    } else if (w.startsWith('-')) {
      if (!w.includes('=') && !BOOL_FLAGS.has(w)) i++ // skip the flag's value
    } else if (number === undefined && /^[0-9]+$/.test(w)) number = w
  }
  if (number === undefined || repo === undefined || !PR_REPO.test(repo)) return undefined
  const url = `https://github.com/${repo}/pull/${number}`

  return PR_URL.test(url) ? url : undefined
}

const labelOf = (url: string) => {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)$/.exec(url)

  return m ? `${m[1]}#${m[2]}` : url
}

// ---------------------------------------------------------------------------
// Engine reads
// ---------------------------------------------------------------------------
type Usage = { usd: number | undefined; tokens: number }
async function readUsage($: Dollar): Promise<Usage | undefined> {
  try {
    const u = await $.session.usage()

    return { usd: u.cost?.usd, tokens: u.context.tokens ?? 0 }
  } catch {
    return undefined
  }
}
async function readNow($: Dollar): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** What the engine calls an agent we have no spawn record of: its type, else its name. */
async function agentLabel($: Dollar, id: string): Promise<string | undefined> {
  try {
    const found = (await $.agent.list()).find(a => a.id === id)
    const label = found?.type ?? found?.name

    return typeof label === 'string' && label !== '' ? agentName(label) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// State changes. One `commit` for every write: it updates the atom, raises the
// toasts that a change earned (each flag flips once per crossing) and redraws
// the status line.
// ---------------------------------------------------------------------------
// -- sane: never trust the stored value ---------------------------------------
// A value under the right tag can still be missing a field (an older build, a
// hand edit, a partial write). Every read goes through `sane`, which falls back
// piece by piece to the matching piece of EMPTY, so render and `commit` can
// never throw on it and a booked step rewrites it whole.
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fin = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const finOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => allowed.find(a => a === v) ?? fallback
const isBucket = (v: unknown): v is MeterBucket => BUCKETS.some(b => b === v)
const perBucket = (v: unknown): Record<MeterBucket, number> => {
  const r = isRec(v) ? v : {}

  return { 'opus-main': fin(r['opus-main'], 0), haiku: fin(r.haiku, 0), sonnet: fin(r.sonnet, 0), 'opus-checks': fin(r['opus-checks'], 0) }
}
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRec) : [])
const AGENT_STATUS = ['running', 'done', 'failed'] as const
const PR_KINDS = ['open', 'draft', 'merged', 'closed'] as const
const PR_FETCH = ['loading', 'ok', 'not-found', 'error', 'unavailable'] as const

// -- the Dollars chart's columns ---------------------------------------------
const sizeOf = (g: MeterGroup): number => g.toStep - g.fromStep + 1
const lastStep = (d: MeterData): number => d.groups[d.groups.length - 1]?.toStep ?? 0
const joinGroups = (a: MeterGroup, b: MeterGroup): MeterGroup => ({
  fromStep: a.fromStep,
  toStep: b.toStep,
  readUsd: a.readUsd + b.readUsd,
  newUsd: a.newUsd + b.newUsd,
  answerUsd: a.answerUsd + b.answerUsd,
})

/** Merges the columns after the first pairwise (the first stays step 1 alone). */
export function mergePairs(groups: MeterGroup[]): MeterGroup[] {
  const out: MeterGroup[] = groups.slice(0, 1)
  for (let i = 1; i < groups.length; i += 2) {
    const a = groups[i]
    const b = groups[i + 1]
    if (a !== undefined) out.push(b !== undefined ? joinGroups(a, b) : a)
  }

  return out
}

type Split = { readUsd: number; newUsd: number; answerUsd: number }

/**
 * Adds one main-thread step to the columns. Column 1 is step 1 alone; the next
 * ones each take `groupSize` steps. A 13th column is never made: the columns
 * after the first are merged pairwise and `groupSize` doubles, so there are
 * always 12 or fewer and together they cover every step since load.
 */
export function addToGroups(groups: MeterGroup[], groupSize: number, parts: Split): { groups: MeterGroup[]; groupSize: number } {
  const next = (groups[groups.length - 1]?.toStep ?? 0) + 1
  const one: MeterGroup = { fromStep: next, toStep: next, ...parts }
  if (groups.length === 0) return { groups: [one], groupSize: 1 }
  const last = groups[groups.length - 1]
  if (last !== undefined && groups.length > 1 && sizeOf(last) < groupSize) {
    return { groups: [...groups.slice(0, -1), joinGroups(last, one)], groupSize }
  }
  if (groups.length < MAX_GROUPS) return { groups: [...groups, one], groupSize }

  return addToGroups(mergePairs(groups), groupSize * 2, parts)
}

/** Stored columns, repaired: bad rows dropped, steps ascending, at most 12 columns. */
function saneGroups(rawGroups: unknown, rawSize: unknown): { groups: MeterGroup[]; groupSize: number } {
  let groups: MeterGroup[] = []
  let prevTo = 0
  for (const g of rows(rawGroups)) {
    const fromStep = Math.floor(fin(g.fromStep, 0))
    const toStep = Math.floor(fin(g.toStep, 0))
    if (fromStep < 1 || toStep < fromStep || fromStep <= prevTo) continue
    prevTo = toStep
    groups.push({
      fromStep,
      toStep,
      readUsd: Math.max(0, fin(g.readUsd, 0)),
      newUsd: Math.max(0, fin(g.newUsd, 0)),
      answerUsd: Math.max(0, fin(g.answerUsd, 0)),
    })
  }
  const second = groups[1]
  const last = groups[groups.length - 1]
  const secondSize = second !== undefined ? sizeOf(second) : 1
  // A stored size can never be bigger than the biggest column it could have made:
  // a corrupt huge value would stop the columns from ever merging again.
  const cap = Math.max(secondSize, last !== undefined ? sizeOf(last) : 1, 1)
  let groupSize = Math.min(Math.max(1, Math.floor(fin(rawSize, 1)), secondSize), cap)
  while (groups.length > MAX_GROUPS) {
    groups = mergePairs(groups)
    groupSize *= 2
  }

  return { groups, groupSize }
}

/** The stored PR rows, repaired: bad rows dropped, at most 8. */
export function sanePrs(raw: unknown): MeterPr[] {
    const prs = rows(raw).flatMap((p): MeterPr[] =>
    typeof p.url === 'string' && PR_URL.test(p.url)
      ? [
          {
            url: p.url,
            label: labelOf(p.url),
            title: strOr(p.title),
            kind: p.kind === null ? null : pick(p.kind, PR_KINDS, 'open'),
            adds: fin(p.adds, 0),
            dels: fin(p.dels, 0),
            pass: fin(p.pass, 0),
            fail: fin(p.fail, 0),
            pending: fin(p.pending, 0),
            failing: Array.isArray(p.failing) ? p.failing.filter((n): n is string => typeof n === 'string').slice(0, 3) : [],
            fetch: pick(p.fetch, PR_FETCH, 'error'),
            misses: fin(p.misses, 0),
            checkedAt: fin(p.checkedAt, 0),
            addedAt: fin(p.addedAt, 0),
          },
        ]
      : [],
  )

  return prs.slice(0, MAX_PRS)
}

export function sane(raw: unknown): MeterData {
  const r = isRec(raw) ? raw : {}
  const agents = rows(r.agents).flatMap((a): MeterAgent[] =>
    typeof a.id === 'string' && isBucket(a.bucket)
      ? [
          {
            id: a.id,
            name: strOr(a.name, 'agent'),
            model: strOr(a.model),
            bucket: a.bucket,
            read: fin(a.read, 0),
            written: fin(a.written, 0),
            usd: fin(a.usd, 0),
            status: pick(a.status, AGENT_STATUS, 'done'),
            startedAt: fin(a.startedAt, 0),
            endedAt: finOrNull(a.endedAt),
            warned: a.warned === true,
          },
        ]
      : [],
  )
  const { groups, groupSize } = saneGroups(r.groups, r.groupSize)
  const guardLines = rows(r.guardLines).flatMap(g => (typeof g.text === 'string' ? [{ kind: pick(g.kind, ['blocked', 'switched'] as const, 'blocked'), text: g.text }] : []))
  return {
    costUsd: fin(r.costUsd, EMPTY.costUsd),
    contextTokens: fin(r.contextTokens, EMPTY.contextTokens),
    mainModel: strOr(r.mainModel, EMPTY.mainModel),
    nowMs: fin(r.nowMs, EMPTY.nowMs),
    lastResponseAt: finOrNull(r.lastResponseAt),
    cacheTtl: pick(r.cacheTtl, ['5m', '1h'] as const, EMPTY.cacheTtl),
    cacheTtlSource: pick(r.cacheTtlSource, ['engine', 'observed', 'assumed'] as const, EMPTY.cacheTtlSource),
    coldToasted: r.coldToasted === true,
    crossed: r.crossed === 350 || r.crossed === 500 ? r.crossed : 0,
    costCursor: finOrNull(r.costCursor),
    spend: perBucket(r.spend),
    written: perBucket(r.written),
    agents: agents.slice(-MAX_AGENTS),
    groups,
    groupSize,
    compactAt: typeof r.compactAt === 'number' && Number.isFinite(r.compactAt) && r.compactAt >= 0 ? Math.floor(r.compactAt) : null,
    guardLines: guardLines.slice(-5),
    lastVerifierAt: finOrNull(r.lastVerifierAt),
  }
}

/** The stored value, repaired. Use this instead of a bare `read($, data)`. */
async function readData($: Dollar): Promise<MeterData> {
  return sane(await read($, data))
}

/** The tracked PRs, repaired. */
async function readCi($: Dollar): Promise<MeterPr[]> {
  return sanePrs(await read($, ciAtom))
}

/** One write of the PR rows: repaired first, written whole. */
async function commitCi($: Dollar, change: (ci: MeterPr[]) => MeterPr[]): Promise<MeterPr[]> {
  return update($, ciAtom, c => sanePrs(change(sanePrs(c))))
}

function withContext(d: MeterData, tokensNow: number): MeterData {
  const level = tokensNow > BAD_AT ? 500 : tokensNow >= WARN_AT ? 350 : 0

  return { ...d, contextTokens: tokensNow, crossed: level }
}

async function commit($: Dollar, change: (d: MeterData) => MeterData): Promise<MeterData> {
  let prev: MeterData = EMPTY
  const next = await update($, data, d => {
    prev = sane(d)

    return change(prev)
  })
  try {
    if (next.crossed > prev.crossed) {
      $.ui.toast(
        next.crossed === 500
          ? 'Meter: context passed 500k — every call re-reads it. Consider a fresh session.'
          : 'Meter: context passed 350k — every call re-reads it.',
      )
    }
    if (next.coldToasted && !prev.coldToasted) {
      $.ui.toast(`Meter: cache went cold — next call re-writes ${tokens(next.contextTokens)}.${next.contextTokens > FRESH_AT ? ' A fresh session is cheaper.' : ''}`)
    }
    for (const a of next.agents) {
      const before = prev.agents.find(p => p.id === a.id)
      if (a.warned && !(before?.warned ?? false)) $.ui.toast('Meter: implementer finished with no verifier after it.')
    }
    $.ui.status(statusLine(next))
  } catch {
    // a failing toast or status line must never fail a hook
  }

  return next
}

/** Books one request to a bucket: the ledger's growth and the tokens it wrote. */
function book(d: MeterData, bucket: MeterBucket, usdGrowth: number, written: number): MeterData {
  return {
    ...d,
    spend: { ...d.spend, [bucket]: d.spend[bucket] + usdGrowth },
    written: { ...d.written, [bucket]: d.written[bucket] + written },
  }
}

function guardLine(d: MeterData, kind: 'blocked' | 'switched', text: string): MeterData {
  return { ...d, guardLines: [...d.guardLines, { kind, text }].slice(-5) }
}

// -- transient bookkeeping (a reload resets it; nothing drawn depends on it) -
let inFlight = 0
let lastActivityAt = 0 // last time a step started or ended; 0 = never
let ticker: Timer | undefined
let lastCiPollAt = 0
let ciBusy = false
let ghBin: string | undefined // the gh that worked last
const GH_BINS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const CI_POLL_WINDOW = 60 * MIN // stop polling a PR this long after it was added
const STUCK_AFTER = 10 * MIN // inFlight with no step activity for this long is reset

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------
/** `gh` from PATH first, then the usual install spots; argv arrays only. */
async function runGh($: Dollar, args: string[]) {
  const bins = ghBin === undefined ? GH_BINS : [ghBin, ...GH_BINS.filter(b => b !== ghBin)]
  let failure: unknown
  for (const bin of bins) {
    try {
      const ran = await $.process.run([bin, ...args], { timeoutMs: 20_000 })
      if (ran.exitCode === 127) continue // shell-style "not found"
      ghBin = bin

      return ran
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error('gh not found')
}

// ---------------------------------------------------------------------------
// `gh pr view <url> --json title,state,isDraft,additions,deletions,
// statusCheckRollup,number,url`. Shape (verified against real gh):
//   { title, state: OPEN|MERGED|CLOSED, isDraft, additions, deletions, number, url,
//     statusCheckRollup: [
//       { __typename: 'CheckRun', name, status: COMPLETED|IN_PROGRESS|QUEUED|..., conclusion: SUCCESS|FAILURE|... ('' while running) },
//       { __typename: 'StatusContext', context, state: SUCCESS|FAILURE|ERROR|PENDING|EXPECTED } ] }
// ---------------------------------------------------------------------------
const PASS_CONCLUSION = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL_CONCLUSION = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAIL_CONTEXT = new Set(['FAILURE', 'ERROR'])
const str = (v: unknown): string => (typeof v === 'string' ? clean(v) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)

type Rolled = { pass: number; fail: number; pending: number; failing: string[] }
export function rollup(rows: unknown): Rolled {
  const out: Rolled = { pass: 0, fail: 0, pending: 0, failing: [] }
  if (!Array.isArray(rows)) return out
  for (const r of rows.slice(0, 200)) {
    if (typeof r !== 'object' || r === null) continue
    const row = r as Record<string, unknown>
    let verdict: 'pass' | 'fail' | 'pending'
    let name: string
    if (row.__typename === 'StatusContext' || (row.context !== undefined && row.conclusion === undefined)) {
      const state = str(row.state).toUpperCase()
      verdict = state === 'SUCCESS' ? 'pass' : FAIL_CONTEXT.has(state) ? 'fail' : 'pending'
      name = str(row.context)
    } else {
      const conclusion = str(row.conclusion).toUpperCase()
      verdict =
        str(row.status).toUpperCase() !== 'COMPLETED' ? 'pending' : PASS_CONCLUSION.has(conclusion) ? 'pass' : FAIL_CONCLUSION.has(conclusion) ? 'fail' : 'pending'
      name = str(row.name)
    }
    out[verdict]++
    if (verdict === 'fail' && out.failing.length < 3 && name !== '') out.failing.push(name.slice(0, 80))
  }

  return out
}

const NOT_FOUND = /could not resolve|not found|404|no pull requests? found/i

async function readPr($: Dollar, url: string): Promise<Partial<MeterPr>> {
  try {
    // ARGV ARRAY, never a shell string; `url` passed PR_URL, so it starts
    // with `https://` and cannot be read as a flag.
    const ran = await runGh($, ['pr', 'view', url, '--json', 'title,state,isDraft,additions,deletions,statusCheckRollup,number,url'])
    let parsed: unknown
    try {
      parsed = JSON.parse(ran.stdout)
    } catch {
      parsed = undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).state !== 'string') {
      // gh ran. "Not there for us" is its own answer; anything else (offline, auth) is a failed read.
      return { fetch: NOT_FOUND.test(ran.stderr) ? 'not-found' : 'error' }
    }
    const pr = parsed as Record<string, unknown>
    const state = str(pr.state).toUpperCase()
    const kind: MeterPrKind = state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : pr.isDraft === true ? 'draft' : 'open'
    const checks = rollup(pr.statusCheckRollup)

    return { fetch: 'ok', kind, title: str(pr.title).slice(0, 200), adds: num(pr.additions), dels: num(pr.deletions), ...checks }
  } catch {
    return { fetch: 'unavailable' } // no gh binary ran at all
  }
}

/** Applies one read to the rows: a PR that is not found twice in a row is dropped. */
function applyRead(ci: MeterPr[], url: string, result: Partial<MeterPr>, at: number): MeterPr[] {
  return ci.flatMap(p => {
    if (p.url !== url) return [p]
    if (result.fetch === 'not-found') {
      const misses = p.misses + 1

      return misses >= 2 ? [] : [{ ...p, fetch: 'not-found' as MeterPrFetch, misses, checkedAt: at }]
    }
    if (result.fetch === 'ok') return [{ ...p, ...result, misses: 0, checkedAt: at }]

    return [{ ...p, fetch: result.fetch ?? 'error', checkedAt: at }]
  })
}

async function refreshCi($: Dollar, urls: string[]): Promise<void> {
  if (ciBusy || urls.length === 0) return
  ciBusy = true
  try {
    // Only PRs the pane already holds are ever checked, never a raw harvest.
    const held = new Set((await readCi($)).map(p => p.url))
    const todo = [...new Set(urls)].filter(u => held.has(u)).slice(0, MAX_PRS)
    for (const url of todo) {
      if (!PR_URL.test(url)) continue // argv below is only ever a validated PR URL
      const result = await readPr($, url)
      const at = await readNow($)
      await commitCi($, ci => applyRead(ci, url, result, at))
    }
  } catch {
    // never throws
  } finally {
    ciBusy = false
  }
}

function scheduleCiRefresh($: Dollar, urls: string[]): void {
  try {
    $.clock.after(1, () => {
      void refreshCi($, urls)
    })
  } catch {
    // no timer, no refresh; the 60 s poll picks the PR up
  }
}

async function noteSeenPrs($: Dollar, urls: string[]): Promise<void> {
  const unique = [...new Set(urls)]
  if (unique.length === 0) return
  const at = await readNow($)
  await commitCi($, current => {
    let ci = current
    for (const url of unique) {
      const known = ci.find(p => p.url === url)
      const row: MeterPr = known
        ? { ...known, addedAt: at }
        : {
            url,
            label: labelOf(url),
            title: '',
            kind: null,
            adds: 0,
            dels: 0,
            pass: 0,
            fail: 0,
            pending: 0,
            failing: [],
            fetch: 'loading',
            misses: 0,
            checkedAt: at,
            addedAt: at,
          }
      ci = [row, ...ci.filter(p => p.url !== url)] // newest first
    }

    return ci.slice(0, MAX_PRS)
  })
  scheduleCiRefresh($, unique)
}

// ---------------------------------------------------------------------------
// The clock: about once a minute, every 10 s in the last 10 minutes of the
// cache. It also catches the cache going cold and polls CI while pending.
// ---------------------------------------------------------------------------
async function tick($: Dollar): Promise<void> {
  try {
    const now = await readNow($)
    const d = await readData($)
    // A step that never reported back (aborted, hook lost) must not hold the
    // cold-cache toast off for ever.
    if (inFlight > 0 && lastActivityAt > 0 && now - lastActivityAt > STUCK_AFTER) inFlight = 0
    const c = cacheInfo({ ...d, nowMs: now })
    const fast = c.state === 'cooling'
    const goesCold = c.state === 'cold' && !d.coldToasted && inFlight === 0
    if (fast || goesCold || now - d.nowMs >= MIN) {
      await commit($, x => {
        const cold = cacheInfo({ ...x, nowMs: now }).state === 'cold'

        return { ...x, nowMs: now, coldToasted: x.coldToasted || (cold && inFlight === 0) }
      })
    }
    if (now - lastCiPollAt >= MIN) {
      // Only while something is pending: a PR not read yet, one with checks still
      // running, or a "not found" given its one retry. Done PRs are never polled.
      const waiting = (await readCi($))
        .filter(p => {
          if (now - p.addedAt >= CI_POLL_WINDOW) return false
          if (p.fetch === 'loading') return true
          if (p.fetch === 'not-found') return p.misses < 2
          return p.fetch === 'ok' && p.pending > 0 && (p.kind === 'open' || p.kind === 'draft')
        })
        .map(p => p.url)
      if (waiting.length > 0) {
        lastCiPollAt = now
        void refreshCi($, waiting)
      }
    }
  } catch {
    // a failing tick must not stop the next one
  }
}

function ensureTicker($: Dollar): void {
  if (ticker !== undefined) return
  try {
    ticker = $.clock.every(10_000, () => {
      void tick($)
    })
  } catch {
    ticker = undefined
  }
}

// `/meter` is registered from session.start AND lazily from the hooks that run
// all the time, so it comes back after a hot reload that does not re-fire
// session.start. Registering a name again replaces it, so this is idempotent.
let commandDone = false
let commandPending: Promise<void> | undefined
let commandTries = 0
function registerCommand($: Dollar): Promise<void> {
  if (commandDone) return Promise.resolve()
  if (commandPending !== undefined) return commandPending
  if (commandTries >= 3) return Promise.resolve()
  commandTries++
  commandPending = (async () => {
    try {
      await $.command.register({ name: 'meter', description: 'Show session cost and agent orchestration in a pane' })
      commandDone = true
    } catch {
      // the pane opens without the command; a later hook tries again (3 tries)
    } finally {
      commandPending = undefined
    }
  })()

  return commandPending
}

function ensureMeter($: Dollar): void {
  ensureTicker($)
  void registerCommand($)
}

/** The engine's cost total BEFORE a step runs: the first step's cost is the growth from here. */
async function primeCursor($: Dollar): Promise<void> {
  try {
    if ((await readData($)).costCursor !== null) return
    const u = await readUsage($)
    const usdNow = u?.usd
    if (usdNow === undefined) return
    await update($, data, x => {
      const s = sane(x)

      return s.costCursor === null ? { ...s, costCursor: usdNow } : s
    })
  } catch {
    // observing never fails a hook
  }
}

// ---------------------------------------------------------------------------
// SVG charts (desktop, vscode, mobile)
//
// Pure string builders: data in, SVG source out. Every colour is a fixed hex
// from a palette (never from data); every drawn string goes through `clean`
// and `esc`. Sizes are CSS pixels (`Svg`'s `width` / `height` are px, not cells).
// ---------------------------------------------------------------------------
/** What a person's `theme` row says, in three palettes: light, dark, and the mid-tone neutral for `auto` and anything unknown. */
export type Palette = {
  name: 'light' | 'dark' | 'neutral'
  text: string
  grid: string
  /** Opacity of grid lines and empty tracks (the neutral palette's are see-through). */
  gridOpacity: number
  read: string
  fresh: string
  answer: string
  compact: string
  ok: string
  warn: string
  bad: string
  bucket: Record<MeterBucket, string>
  before: string
}

// Mid-tone: reads on white and on near-black alike.
const TONES = {
  read: '#A58BC8',
  fresh: '#DDA65A',
  answer: '#55A06A',
  compact: '#B0412E',
  ok: '#55A06A',
  warn: '#DDA65A',
  bad: '#B0412E',
  bucket: { 'opus-main': '#D97757', sonnet: '#3B82D6', haiku: '#55A06A', 'opus-checks': '#9B7BD4' },
  before: '#9CA3AF',
} as const

export const PALETTES: Record<Palette['name'], Palette> = {
  light: { ...TONES, name: 'light', text: '#374151', grid: '#E5E7EB', gridOpacity: 1 },
  dark: { ...TONES, name: 'dark', text: '#D1D5DB', grid: '#374151', gridOpacity: 1 },
  neutral: { ...TONES, name: 'neutral', text: '#8B9099', grid: '#8B9099', gridOpacity: 0.33 },
}

/** `dark` anywhere in the theme name -> dark, `light` -> light, `auto` / `system` / unknown -> neutral. */
export function paletteFor(theme: unknown): Palette {
  const name = typeof theme === 'string' ? theme.toLowerCase() : ''

  return name.includes('dark') ? PALETTES.dark : name.includes('light') ? PALETTES.light : PALETTES.neutral
}

// The person's theme, read from the `/config` row. Cached: the `config.set`
// hook below and `/meter` refresh it; the pane reads it once if nothing has.
let palette: Palette = PALETTES.neutral
let themeKnown = false
let themeTries = 0

/** Takes the theme as the new palette; a drawn pane is asked to draw again when it changed. */
function setTheme($: Dollar, theme: unknown): void {
  const next = paletteFor(theme)
  const changed = themeKnown && next !== palette
  palette = next
  themeKnown = true
  if (changed) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // the next draw picks it up
    }
  }
}

async function refreshTheme($: Dollar): Promise<void> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    setTheme($, row?.value)
  } catch {
    // keep what we had; the neutral palette reads on either theme
  }
}

async function currentPalette($: Dollar): Promise<Palette> {
  if (!themeKnown && themeTries < 3) {
    themeTries++
    await refreshTheme($)
  }

  return palette
}

/** XML-escapes text that goes into SVG source: & < > " ' */
export const esc = (s: string): string => s.replace(/[&<>"']/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'))
/** Text for an SVG `<text>`: control characters gone, then escaped. */
const svgText = (s: string): string => esc(clean(s))
/** A coordinate: two decimals at most, never NaN or Infinity. */
const px = (v: number): string => String(Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)

const FONT = '-apple-system, system-ui, sans-serif'
const CHAR_PX = 6.1 // average width of a 11 px label character
const textWidth = (s: string): number => s.length * CHAR_PX

const svgDoc = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px(w)}" height="${px(h)}" viewBox="0 0 ${px(w)} ${px(h)}" preserveAspectRatio="xMinYMid meet" font-family="${FONT}" font-size="11">${body}</svg>`

const svgLabel = (x: number, y: number, text: string, fill: string, anchor: 'start' | 'middle' | 'end' = 'middle'): string =>
  `<text x="${px(x)}" y="${px(y)}" fill="${fill}" text-anchor="${anchor}">${svgText(text)}</text>`

/** A rectangle with its two top corners rounded, as a path (for a clip). */
const roundedTop = (x: number, y: number, w: number, h: number, r: number): string => {
  const c = Math.max(0, Math.min(r, h, w / 2))

  return `M${px(x)},${px(y + h)}L${px(x)},${px(y + c)}Q${px(x)},${px(y)} ${px(x + c)},${px(y)}L${px(x + w - c)},${px(y)}Q${px(x + w)},${px(y)} ${px(x + w)},${px(y + c)}L${px(x + w)},${px(y + h)}Z`
}

const DOLLARS_HEIGHT = 180
const COLUMN_MAX_PX = 36 // a column is never wider than this (the pitch is a third wider)
const GAP_SHARE = 0.25 // of the pitch
const COMPACT_PILL = '/compact'

/**
 * "Dollars per step": stacked columns, bottom to top re-read / new: stored /
 * answer, in TRUE proportion (no minimum segment); light gridlines (nice ticks) with $
 * labels; step ranges under the columns; a dashed `/compact` line with a pill.
 * `markAt` is the column that holds the first step after /compact, or -1.
 */
export function dollarsSvg(groups: MeterGroup[], markAt: number, pal: Palette, width: number, height = DOLLARS_HEIGHT): string {
  const total = (g: MeterGroup) => g.readUsd + g.newUsd + g.answerUsd
  const { top, ticks } = niceTicks(Math.max(...groups.map(total), 0))
  const gridLabels = ticks.map(t => dollars(t))
  const gutter = Math.ceil(Math.max(...gridLabels.map(textWidth))) + 8
  const padTop = 24 // room for the /compact pill
  const padBottom = 20 // room for the step labels
  const padRight = 6
  const plotX = gutter
  const plotW = Math.max(40, width - gutter - padRight)
  const plotH = Math.max(20, height - padTop - padBottom)
  const baseY = padTop + plotH
  const pitch = Math.min(plotW / Math.max(1, groups.length), COLUMN_MAX_PX / (1 - GAP_SHARE))
  const colW = pitch * (1 - GAP_SHARE)
  const yOf = (usdValue: number) => (usdValue / top) * plotH
  const out: string[] = []

  // gridlines first, so the columns sit on them
  for (let k = 0; k <= ticks.length; k++) {
    const y = baseY - (plotH * (k === 0 ? 0 : (ticks[k - 1] ?? 0))) / top
    out.push(`<line x1="${px(plotX)}" y1="${px(y)}" x2="${px(width - padRight)}" y2="${px(y)}" stroke="${pal.grid}" stroke-opacity="${pal.gridOpacity}" stroke-width="1"/>`)
    if (k > 0) out.push(svgLabel(plotX - 6, y + 4, gridLabels[k - 1] ?? '', pal.text, 'end'))
  }

  // columns
  groups.forEach((g, i) => {
    const x = plotX + i * pitch + (pitch * GAP_SHARE) / 2
    let y = baseY
    const rects: string[] = []
    for (const [value, fill] of [[g.readUsd, pal.read], [g.newUsd, pal.fresh], [g.answerUsd, pal.answer]] as const) {
      const h = Math.min(yOf(Math.max(0, value)), y - padTop)
      if (!(h > 0)) continue
      y -= h
      rects.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(colW)}" height="${px(h)}" fill="${fill}"/>`)
    }
    if (rects.length === 0) return
    out.push(
      `<clipPath id="col${i}"><path d="${roundedTop(x, y, colW, baseY - y, 2)}"/></clipPath>`,
      `<g clip-path="url(#col${i})">${rects.join('')}</g>`,
    )
  })

  // x labels: under every column when each has room, else first, middle and last
  const labels = groups.map(g => groupLabel(g))
  const widest = Math.max(...labels.map(textWidth), 0)
  const every = pitch >= Math.max(28, widest + 4)
  const centre = (i: number) => plotX + i * pitch + pitch / 2
  const wanted = every ? labels.map((_, i) => i) : [...new Set([0, groups.length - 1])]
  const placed: { from: number; to: number }[] = []
  const place = (i: number): void => {
    const text = labels[i] ?? ''
    const w = textWidth(text)
    const at = clamp(centre(i), w / 2, width - w / 2)
    const box = { from: at - w / 2 - 2, to: at + w / 2 + 2 }
    if (placed.some(p => box.from < p.to && p.from < box.to)) return
    placed.push(box)
    out.push(svgLabel(at, height - 5, text, pal.text))
  }
  wanted.forEach(place)
  if (!every && groups.length > 2) place(Math.floor((groups.length - 1) / 2))

  // /compact: a dashed line between the columns and a pill at its top
  if (markAt > 0 && markAt < groups.length) {
    const x = plotX + markAt * pitch
    const pillW = Math.round(COMPACT_PILL.length * 5.7 + 14)
    const pillX = clamp(x - pillW / 2, 0, Math.max(0, width - pillW))
    out.push(
      `<line x1="${px(x)}" y1="18" x2="${px(x)}" y2="${px(baseY)}" stroke="${pal.compact}" stroke-width="1.5" stroke-dasharray="3 3"/>`,
      `<rect x="${px(pillX)}" y="2" width="${pillW}" height="16" rx="8" fill="${pal.compact}"/>`,
      `<text x="${px(pillX + pillW / 2)}" y="13.5" fill="#FFFFFF" font-size="10" font-weight="600" text-anchor="middle">${svgText(COMPACT_PILL)}</text>`,
    )
  }

  return svgDoc(width, height, out.join(''))
}

const zoneHex = (n: number, pal: Palette): string => (n < WARN_AT ? pal.ok : n <= BAD_AT ? pal.warn : pal.bad)
const GAUGE_HEIGHT = 32

/** Context gauge: a rounded bar filled to the tokens, coloured by zone, ticks and labels at 350k and 500k. */
export function gaugeSvg(tokensNow: number, pal: Palette, width: number, height = GAUGE_HEIGHT): string {
  const barH = 10
  const barY = 3
  const fill = clamp(tokensNow / GAUGE_MAX, 0, 1) * width
  const out = [
    `<clipPath id="gauge"><rect x="0" y="${barY}" width="${px(width)}" height="${barH}" rx="${barH / 2}"/></clipPath>`,
    `<rect x="0" y="${barY}" width="${px(width)}" height="${barH}" rx="${barH / 2}" fill="${pal.grid}" fill-opacity="${pal.gridOpacity}"/>`,
  ]
  if (fill > 0) out.push(`<rect x="0" y="${barY}" width="${px(fill)}" height="${barH}" fill="${zoneHex(tokensNow, pal)}" clip-path="url(#gauge)"/>`)
  for (const [at, text] of [[WARN_AT, '350k'], [BAD_AT, '500k']] as const) {
    const x = clamp((at / GAUGE_MAX) * width, 1, width - 1)
    const w = textWidth(text)
    out.push(
      `<line x1="${px(x)}" y1="${barY - 3}" x2="${px(x)}" y2="${barY + barH + 3}" stroke="${pal.text}" stroke-width="1.5"/>`,
      svgLabel(clamp(x, w / 2, width - w / 2), height - 4, text, pal.text),
    )
  }

  return svgDoc(width, height, out.join(''))
}

const BAR_HEIGHT = 6

/** A stacked bar: rounded, 1 px gaps between segments, widths in true proportion. */
export function barSvg(items: { color: string; value: number }[], pal: Palette, width: number, height = BAR_HEIGHT): string {
  const live = items.filter(i => Number.isFinite(i.value) && i.value > 0)
  const total = live.reduce((sum, i) => sum + i.value, 0)
  const out = [
    `<clipPath id="bar"><rect x="0" y="0" width="${px(width)}" height="${px(height)}" rx="${px(height / 2)}"/></clipPath>`,
    `<rect x="0" y="0" width="${px(width)}" height="${px(height)}" rx="${px(height / 2)}" fill="${pal.grid}" fill-opacity="${pal.gridOpacity}"/>`,
  ]
  let cum = 0
  const rects: string[] = []
  live.forEach((item, i) => {
    const from = (cum / total) * width
    cum += item.value
    const to = (cum / total) * width
    const w = to - from
    const drawn = i < live.length - 1 && w > 1 ? w - 1 : w // the 1 px gap, unless the segment is thinner than it
    rects.push(`<rect x="${px(from)}" y="0" width="${px(drawn)}" height="${px(height)}" fill="${item.color}"/>`)
  })
  if (rects.length > 0) out.push(`<g clip-path="url(#bar)">${rects.join('')}</g>`)

  return svgDoc(width, height, out.join(''))
}

const RING_SIZE = 28
const RING_STROKE = 4
const RING_LABEL_SIZE = 11

/**
 * The cache countdown: a ring showing the fraction of the TTL left, or an empty track when there is no colour.
 * `label` (the minutes left, or a `×` when cold) is drawn inside it, 11 px semi-bold, in the ring's colour.
 */
export function ringSvg(fraction: number, color: string | undefined, pal: Palette, size = RING_SIZE, label?: string): string {
  const c = size / 2
  const r = c - RING_STROKE / 2 - 1
  const length = 2 * Math.PI * r
  const f = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1)
  const out = [`<circle cx="${px(c)}" cy="${px(c)}" r="${px(r)}" fill="none" stroke="${pal.grid}" stroke-opacity="${pal.gridOpacity}" stroke-width="${RING_STROKE}"/>`]
  if (color !== undefined && f > 0) {
    out.push(
      `<circle cx="${px(c)}" cy="${px(c)}" r="${px(r)}" fill="none" stroke="${color}" stroke-width="${RING_STROKE}" stroke-linecap="round" stroke-dasharray="${px(length * f)} ${px(length)}" transform="rotate(-90 ${px(c)} ${px(c)})"/>`,
    )
  }
  // The label takes the ring's own state colour (no colour = the palette's text), and sits on the ring's centre line.
  if (label !== undefined && label !== '') {
    out.push(`<text x="${px(c)}" y="${px(c)}" fill="${color ?? pal.text}" font-size="${RING_LABEL_SIZE}" font-weight="600" text-anchor="middle" dominant-baseline="central">${svgText(label)}</text>`)
  }

  return svgDoc(size, size, out.join(''))
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
/** `color` undefined = the empty track. */
type Part = { cells: number; color?: Color }

/**
 * A horizontal bar of text blocks (`█` coloured, `░` dim for the track): the
 * chart where there is no `Svg`, and the fallback if an SVG cannot be built.
 */
function bar(k: Kit, parts: Part[]): RenderElement {
  const { Box, Text } = k
  const shown = parts.filter(p => p.cells > 0)

  return (
    <Box>
      {shown.map(p =>
        p.color ? <Text color={p.color}>{'█'.repeat(p.cells)}</Text> : <Text dimColor>{'░'.repeat(p.cells)}</Text>,
      )}
    </Box>
  )
}

/** Cells of a gauge: filled up to `fill`, with a contrasting cell at each mark. */
function gaugeParts(width: number, fill: number, fillColor: Color, marks: number[]): Part[] {
  const parts: Part[] = []
  for (let i = 0; i < width; i++) {
    const color: Color | undefined = marks.includes(i) ? MARK : i < fill ? fillColor : undefined
    const last = parts[parts.length - 1]
    if (last && last.color === color) last.cells++
    else parts.push({ cells: 1, color })
  }

  return parts
}

function section(k: Kit, title: string, ...body: (RenderElement | null)[]): RenderElement {
  const { Box, Text } = k

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text weight="bold">{title}</Text>
      {body}
    </Box>
  )
}

const big = (k: Kit, text: string, color?: Color) => {
  const { Text } = k

  return (
    <Text size="title" weight="bold" color={color}>
      {text}
    </Text>
  )
}

const caption = (k: Kit, text: string) => {
  const { Text } = k

  return (
    <Text size="caption" dimColor>
      {text}
    </Text>
  )
}

/** First column of a label centred on its mark: markCol - floor(len / 2), kept inside the row. */
export const labelStart = (markCol: number, len: number, width: number): number => clamp(markCol - Math.floor(len / 2), 0, Math.max(0, width - len))

/** A monospace row of labels centred on columns: `[{ at: 12, text: '350k' }]`. */
export function labelRow(width: number, marks: { at: number; text: string }[]): string {
  const row = Array.from({ length: width }, () => ' ')
  for (const m of marks) {
    const start = labelStart(m.at, m.text.length, width)
    for (let i = 0; i < m.text.length; i++) row[start + i] = m.text[i] ?? ' '
  }

  return row.join('')
}

type Layout = {
  surface: Surface
  /** Cells the charts are laid out in. */
  width: number
  /** `Svg` on the surfaces that have it; undefined = draw the cell charts. */
  svg: SvgTag
  palette: Palette
}

/** CSS pixels of one pane cell, to size an SVG to the pane (`Svg` takes pixels). */
const CELL_PX = 8
const svgWidth = (l: Layout): number => l.width * CELL_PX

/**
 * An SVG chart, or undefined when the surface has no `Svg` or the builder
 * threw: the caller then draws its cell chart.
 */
function drawSvg(l: Layout, alt: string, width: number, height: number, build: () => string): RenderElement | undefined {
  const Svg = l.svg
  if (Svg === undefined) return undefined
  try {
    const source = build()

    return <Svg source={source} alt={clean(alt)} width={width} height={height} />
  } catch {
    return undefined
  }
}

// -- 1. Session cost --------------------------------------------------------
function costSection(k: Kit, d: MeterData): RenderElement {
  return section(k, 'Session cost', big(k, usd(d.costUsd)), caption(k, 'this session · list price'))
}

// -- 2. Context -------------------------------------------------------------
const GAUGE_MAX = 600_000
function contextSection(k: Kit, l: Layout, d: MeterData): RenderElement {
  const { Box, Text } = k
  const zone = contextZone(d.contextTokens)
  const w = svgWidth(l)
  const drawn = drawSvg(l, `Context ${tokens(d.contextTokens)} of ${tokens(GAUGE_MAX)}, marks at 350k and 500k`, w, GAUGE_HEIGHT, () => gaugeSvg(d.contextTokens, l.palette, w))
  let gauge: RenderElement
  if (drawn !== undefined) gauge = drawn
  else {
    const at = (n: number) => clamp(Math.round((n / GAUGE_MAX) * l.width), 0, l.width - 1)
    const fill = clamp(Math.round((d.contextTokens / GAUGE_MAX) * l.width), 0, l.width)
    const marks = [
      { at: at(WARN_AT), text: '350k' },
      { at: at(BAD_AT), text: '500k' },
    ]
    gauge = (
      <Box flexDirection="column">
        {bar(k, gaugeParts(l.width, fill, zone, [at(WARN_AT), at(BAD_AT)]))}
        <Text mono dimColor>
          {labelRow(l.width, marks)}
        </Text>
      </Box>
    )
  }

  return section(k, 'Context', big(k, tokens(d.contextTokens), zone), caption(k, 'every call re-reads this'), gauge)
}

// -- 3. Cache ---------------------------------------------------------------
// A ring countdown in one glyph: full, three quarters, half, quarter, empty.
const ring = (fraction: number) =>
  fraction > 0.875 ? '●' : fraction > 0.625 ? '◕' : fraction > 0.375 ? '◑' : fraction > 0.05 ? '◔' : '○'

function cacheSection(k: Kit, l: Layout, d: MeterData): RenderElement {
  const { Box, Text } = k
  const c = cacheInfo(d)
  const color = c.state === 'warm' ? OK : c.state === 'cooling' ? WARN : c.state === 'cold' ? BAD : undefined
  const ringHex = c.state === 'warm' ? l.palette.ok : c.state === 'cooling' ? l.palette.warn : c.state === 'cold' ? l.palette.bad : undefined
  const fraction = clamp(c.leftMs / TTL_MS[d.cacheTtl], 0, 1)
  const drawn = drawSvg(l, `Cache ${c.state === 'none' ? 'no call yet' : c.state}${c.state === 'warm' || c.state === 'cooling' ? `, ${leftLong(c.leftMs)}` : ''}`, RING_SIZE, RING_SIZE, () => ringSvg(fraction, ringHex, l.palette, RING_SIZE, c.state === 'warm' || c.state === 'cooling' ? String(Math.max(1, Math.ceil(c.leftMs / MIN))) : c.state === 'cold' ? '×' : undefined))
  const line =
    c.state === 'none'
      ? 'no call yet'
      : c.state === 'cold'
        ? `cold — next call re-writes ${tokens(d.contextTokens)}.${d.contextTokens > FRESH_AT ? ' A fresh session is cheaper.' : ''}`
        : `${c.state} · ${leftLong(c.leftMs)}`
  const ttl = d.cacheTtl === '1h' ? '1 hour' : '5 minute'
  const source = d.cacheTtlSource === 'assumed' ? ' (assumed)' : d.cacheTtlSource === 'observed' ? ' (observed)' : ''

  return section(
    k,
    'Cache',
    <Box gap={1} alignItems="center">
      {drawn ?? (
        <Text size="title" color={color}>
          {ring(fraction)}
        </Text>
      )}
      <Text color={color} weight="semibold">
        {line}
      </Text>
    </Box>,
    caption(k, `${ttl} cache${source}, resets on every call`),
  )
}

// -- 4. Who did the work ----------------------------------------------------
/** One row of the agent list: every run of one agent type on one model, added up. */
export type AgentGroup = { name: string; model: string; bucket: MeterBucket; runs: number; read: number; written: number; usd: number; running: boolean; failed: number }

/** Runs folded into one row per (type, model), most expensive first. The stored per-run rows are not touched. */
export function groupAgents(agents: MeterAgent[]): AgentGroup[] {
  const by = new Map<string, AgentGroup>()
  for (const a of agents) {
    const name = agentName(a.name)
    const model = clean(a.model)
    const key = `${name}\u0000${model}`
    const g = by.get(key) ?? { name, model, bucket: a.bucket, runs: 0, read: 0, written: 0, usd: 0, running: false, failed: 0 }
    g.runs += 1
    g.read += a.read
    g.written += a.written
    g.usd += a.usd
    if (a.status === 'running') g.running = true
    if (a.status === 'failed') g.failed += 1
    by.set(key, g)
  }
  return [...by.values()].sort((x, y) => y.usd - x.usd)
}

/** The row's text: `implementer · Sonnet · 3 runs · 12.5M read · 135k written · ≈$2.72` (a single run leaves out the runs part). */
export function agentRowText(g: AgentGroup): string {
  const runs = g.runs > 1 ? ` · ${g.runs} runs` : ''
  const state = g.running ? ' · running' : g.failed === 0 ? '' : g.failed === g.runs ? ' · stopped' : ` · ${g.failed} stopped`

  return `${g.name} · ${g.model}${runs} · ${tokens(g.read)} read · ${tokens(g.written)} written · ≈${usd(g.usd)}${state}`
}

type Item = { color: Color; value: number }

/** Parts that cover `width` cells in proportion to the items, ending in the empty track. */
export function splitParts(width: number, items: Item[]): Part[] {
  const total = items.reduce((sum, i) => sum + i.value, 0)
  const parts: Part[] = []
  let cum = 0
  let used = 0
  for (const i of items) {
    cum += i.value
    const edge = total > 0 ? Math.round((cum / total) * width) : 0
    parts.push({ cells: edge - used, color: i.color })
    used = edge
  }
  parts.push({ cells: width - used })

  return parts
}

/** The cost nobody booked to a bucket: what the engine counted before this mod loaded. */
export function beforeLoaded(d: MeterData): number {
  const gap = d.costUsd - BUCKETS.reduce((sum, b) => sum + d.spend[b], 0)

  return gap > 0.01 ? gap : 0
}

/**
 * Each value's share of the total as legend text: `13%`, `<1%` for a non-zero share under 0.5%, `''` when
 * the total is zero. Whole percents by largest remainder, so the shown ones (a `<1%` counts as 0) add up to 100.
 */
export function shares(values: number[]): string[] {
  const vals = values.map(v => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = vals.reduce((sum, v) => sum + v, 0)
  if (total <= 0) {
    return values.map(() => '')
  }
  const exact = vals.map(v => (v / total) * 100)
  const frac = exact.map(e => e - Math.floor(e + 1e-9))
  const tiny = exact.map(e => e > 0 && e < 0.5)
  const out = exact.map((e, i) => (tiny[i] ? 0 : Math.floor(e + 1e-9)))
  const order = exact.flatMap((_, i) => (tiny[i] ? [] : [i])).sort((x, y) => (frac[y] ?? 0) - (frac[x] ?? 0) || x - y)
  let left = 100 - out.reduce((sum, n) => sum + n, 0)
  for (let n = 0; left > 0 && order.length > 0; n = (n + 1) % order.length, left--) {
    const at = order[n] ?? 0
    out[at] = (out[at] ?? 0) + 1
  }

  // a share rounded down to 0 that is not exactly 0 reads as `<1%`, still 0 in the sum
  return out.map((n, i) => (n === 0 && (exact[i] ?? 0) > 0 ? '<1%' : `${n}%`))
}

const barLabel = (k: Kit, text: string) => {
  const { Text } = k

  return (
    <Text size="caption" dimColor>
      {text}
    </Text>
  )
}

function workSection(k: Kit, l: Layout, d: MeterData): RenderElement {
  const { Box, Text } = k
  const before = beforeLoaded(d)
  // A bucket with no cost and nothing written is not drawn at all.
  const shown = BUCKETS.filter(b => d.spend[b] >= 0.005 || d.written[b] > 0)
  // Where the charts are SVG the swatches and dots take the SVG's own hex, so a
  // legend never differs in shade from the bar it names.
  const svgOn = l.svg !== undefined
  const tone = (b: MeterBucket): Color => (svgOn ? l.palette.bucket[b] : MODEL_COLOR[b])
  const grey: Color = svgOn ? l.palette.before : GREY
  const costItems: Item[] = [...(before > 0 ? [{ color: grey, value: before }] : []), ...shown.map(b => ({ color: tone(b), value: d.spend[b] }))]
  const tokenItems: Item[] = shown.map(b => ({ color: tone(b), value: d.written[b] }))
  // One legend under each bar, in the bar's own order: money under Cost, written tokens under Tokens written.
  type LegendEntry = { color: Color; text: string; pct?: string }
  const costRows = [...(before > 0 ? [{ color: grey, text: `Before Meter loaded ≈${usd(before)}`, value: before }] : []), ...shown.map(b => ({ color: tone(b), text: `${BUCKET_LABEL[b]} ≈${usd(d.spend[b])}`, value: d.spend[b] }))]
  const costShare = shares(costRows.map(r => r.value))
  const costLegend: LegendEntry[] = costRows.map((r, i) => ({ color: r.color, text: r.text, pct: costShare[i] }))
  const tokenShare = shares(shown.map(b => d.written[b]))
  const tokenLegend: LegendEntry[] = shown.map((b, i) => ({ color: tone(b), text: `${BUCKET_LABEL[b]} ${tokens(d.written[b])}`, pct: tokenShare[i] }))
  const w = svgWidth(l)
  const stacked = (items: Item[], alt: string): RenderElement =>
    drawSvg(l, alt, w, BAR_HEIGHT, () => barSvg(items, l.palette, w)) ?? bar(k, splitParts(l.width, items))
  // 2 columns when an entry fits in half the width, else one per row.
  const half = Math.floor(l.width / 2)
  const twoCols = half >= 36
  const entry = (e: LegendEntry, w?: number) => (
    <Box width={w} gap={1}>
      <Text color={e.color}>{'■'}</Text>
      <Text wrap="truncate-end">{e.text}</Text>
      {e.pct ? (
        <Text dimColor wrap="truncate-end">
          {`· ${e.pct}`}
        </Text>
      ) : null}
    </Box>
  )
  const step = twoCols ? 2 : 1
  const legendBox = (legend: LegendEntry[]): RenderElement => {
    const rows: RenderElement[] = []
    for (let i = 0; i < legend.length; i += step) {
      rows.push(<Box>{legend.slice(i, i + step).map(e => entry(e, twoCols ? half : undefined))}</Box>)
    }

    return (
      <Box flexDirection="column" marginTop={1}>
        {rows}
      </Box>
    )
  }
  const groups = groupAgents(d.agents)
  const recent = groups.slice(0, 8)

  return section(
    k,
    'Who did the work',
    caption(k, '≈ split of the session total by step · tokens exact'),
    barLabel(k, 'Cost'),
    stacked(costItems, `Cost by who did the work, total ${usd(d.costUsd)}`),
    legendBox(costLegend),
    <Box marginTop={1} flexDirection="column">
      {barLabel(k, 'Tokens written')}
      {stacked(tokenItems, 'Tokens written by who did the work')}
    </Box>,
    legendBox(tokenLegend),
    <Box flexDirection="column" marginTop={1}>
      {d.agents.length === 0 ? caption(k, 'no agents yet') : null}
      {groups.length > recent.length ? caption(k, `${groups.length - recent.length} more agent types not shown`) : null}
      {recent.map(g => (
        <Box gap={1}>
          <Text color={tone(g.bucket)}>{'●'}</Text>
          <Text>{agentRowText(g)}</Text>
        </Box>
      ))}
    </Box>,
  )
}

// -- 5. GitHub: the app's own "Changes" list ---------------------------------
const PR_ICON: Record<MeterPrKind, { glyph: string; color: Color | undefined }> = {
  open: { glyph: '◉', color: OK },
  merged: { glyph: '◆', color: 'merged' },
  closed: { glyph: '✕', color: BAD },
  draft: { glyph: '◌', color: undefined }, // dim
}

const repoName = (label: string) => /^[^/]+\/([^#]+)#/.exec(label)?.[1] ?? label
const prNumber = (label: string) => /#([0-9]+)$/.exec(label)?.[1] ?? ''

function prRow(k: Kit, l: Layout, p: MeterPr): RenderElement {
  const { Box, Text, Link } = k
  const ok = p.fetch === 'ok' && p.kind !== null
  // Line 1: icon + title; a row gh could not read says why, in dim.
  const icon = ok && p.kind !== null ? PR_ICON[p.kind] : { glyph: '◌', color: undefined }
  const headline = ok
    ? clean(p.title) || p.label
    : p.fetch === 'not-found'
      ? 'not found'
      : p.fetch === 'unavailable'
        ? 'gh unavailable'
        : p.fetch === 'error'
          ? "couldn't check"
          : 'checking…'
  const headColor: Color | undefined = !ok && p.fetch === 'unavailable' ? WARN : undefined
  const room = Math.max(8, l.width - 2)
  const total = p.pass + p.fail + p.pending
  const dot: Color | undefined = !ok || total === 0 ? undefined : p.fail > 0 ? BAD : p.pending > 0 ? WARN : OK

  return (
    <Box flexDirection="column" marginTop={1} width={l.width}>
      <Box gap={1}>
        <Text color={icon.color} dimColor={icon.color === undefined}>
          {icon.glyph}
        </Text>
        <Text color={headColor} dimColor={!ok && headColor === undefined} wrap="truncate-end">
          {truncate(headline, room)}
        </Text>
      </Box>
      <Box justifyContent="space-between" width={l.width}>
        <Box gap={1}>
          <Text size="caption" dimColor>
            {repoName(p.label)}
          </Text>
          <Text size="caption">
            <Link href={p.url} label={`#${prNumber(p.label)}`} />
          </Text>
          {ok ? (
            <Text size="caption" color={OK}>
              {`+${p.adds}`}
            </Text>
          ) : null}
          {ok ? (
            <Text size="caption" color={BAD}>
              {`−${p.dels}`}
            </Text>
          ) : null}
        </Box>
        {ok ? (
          <Box>
            <Text size="caption" color={dot} dimColor={dot === undefined}>
              {'● '}
            </Text>
            <Text size="caption" dimColor>
              {`${p.pass}/${total}`}
            </Text>
          </Box>
        ) : null}
      </Box>
      {ok && p.fail > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {p.failing.slice(0, 3).map(name => (
            <Text size="caption" color={BAD} dimColor wrap="truncate-end">
              {truncate(clean(name), room - 2)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function ciSection(k: Kit, l: Layout, ci: MeterPr[]): RenderElement {
  return section(
    k,
    'GitHub',
    ci.length === 0 ? caption(k, 'PRs this session opens, views or merges show up here') : null,
    ...ci.map(p => prRow(k, l, p)),
  )
}

// -- 6. Dollars per step ----------------------------------------------------
// A stacked column chart: x = runs of main-thread steps, y = dollars. Each
// column stacks, bottom to top: re-read (cache reads), new: stored (cache
// writes + uncached input), its answer (output).
const READ_COLOR: Color = 'merged' // purple: what was seen before
const NEW_COLOR: Color = WARN // amber: stored for the first time
const ANSWER_COLOR: Color = OK // green: the model's own output
const COMPACT_COLOR: Color = BAD
const TERMINAL_ROWS = 4
const COLUMN_MAX = 4 // cells a column is wide, at most
const COMPACT_LABEL = '/compact'

/**
 * Anthropic's price STRUCTURE, the same for every Claude model: relative to
 * uncached input = 1, a cache read costs 0.1, a cache write 1.25 (5 minute
 * cache) or 2 (1 hour cache), output 5. No absolute price is stored here: the
 * ratios only SHARE OUT the engine's own, exact cost of a step between the three
 * parts, so the parts always add up to that cost.
 */
export const PRICE_RATIO = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 } as const

type UsageCounts = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }

/** One step's cost shared out as re-read / new: stored / its answer. */
export function splitCost(cost: number, u: UsageCounts, ttl: '5m' | '1h'): Split {
  const count = (n: number) => Math.max(0, fin(n, 0))
  const read = count(u.cache_read_input_tokens) * PRICE_RATIO.cacheRead
  const fresh = count(u.input_tokens) * PRICE_RATIO.input + count(u.cache_creation_input_tokens) * (ttl === '5m' ? PRICE_RATIO.cacheWrite5m : PRICE_RATIO.cacheWrite1h)
  const answer = count(u.output_tokens) * PRICE_RATIO.output
  const total = read + fresh + answer
  if (!(cost > 0) || !Number.isFinite(cost)) return { readUsd: 0, newUsd: 0, answerUsd: 0 }
  // No tokens to share the cost by: it still happened, and the parts must add up to it.
  if (!(total > 0)) return { readUsd: 0, newUsd: cost, answerUsd: 0 }

  return { readUsd: (cost * read) / total, newUsd: (cost * fresh) / total, answerUsd: (cost * answer) / total }
}

/**
 * "Nice ticks" for the y axis: a step of 1, 2 or 5 (or 2.5) times a power of ten, and
 * 3 to 5 gridlines up to a top that is a multiple of the step and holds `max`.
 * The smallest 1/2/5 step that needs 5 lines or fewer wins; 2.5 only when it gives 3 or
 * 4 lines and a lower top ($0.25 $0.5 $0.75 rather than $0.2 .. $0.8). Not a usable `max`: $0.25 .. $1.
 */
export function niceTicks(max: number): { step: number; top: number; ticks: number[] } {
  const fallback = { step: 0.25, top: 1, ticks: [0.25, 0.5, 0.75, 1] }
  if (!(max > 0) || !Number.isFinite(max)) return fallback
  const unit = 10 ** Math.floor(Math.log10(max))
  const lines = (step: number) => Math.ceil(max / step - 1e-9)
  const steps = [unit / 10, unit / 5, unit / 2, unit, unit * 2, unit * 5]
  const plain = steps.find(s => lines(s) <= 5)
  if (plain === undefined || !(plain > 0)) return fallback
  const alt = [unit / 4, unit * 2.5].find(s => lines(s) >= 3 && lines(s) <= 4 && lines(s) * s < lines(plain) * plain - 1e-12)
  const step = alt ?? plain
  const count = lines(step)
  const ticks = Array.from({ length: count }, (_, i) => Number((step * (i + 1)).toPrecision(12)))
  const top = ticks[count - 1] ?? 0

  return Number.isFinite(top) && top > 0 && count >= 1 ? { step: Number(step.toPrecision(12)), top, ticks } : fallback
}

/** The top of the y axis. */
export const niceTop = (max: number): number => niceTicks(max).top

const dollars = (n: number) => `$${n.toFixed(6).replace(/\.?0+$/, '')}`

/**
 * Cells of each part of one column, bottom-up order [re-read, new, answer].
 * The column is `total / top` of `rows`, rounded (at least one cell if it holds
 * anything); the parts share those cells by largest remainder and nothing else:
 * a small part gets no cell rather than a cell too big for it, so the picture
 * never makes the answer look as big as the re-read.
 */
export function stackCells(values: number[], top: number, rows: number): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (!(total > 0) || !(top > 0)) return values.map(() => 0)
  const height = clamp(Math.round((total / top) * rows), 1, rows)
  const exact = values.map(v => (v / total) * height)
  const cells = exact.map(Math.floor)
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let n = height - cells.reduce((a, b) => a + b, 0), j = 0; n > 0; n--, j = (j + 1) % order.length) cells[order[j]?.i ?? 0]!++

  return cells
}

/** One column's colours from the TOP row down: empty (undefined) first, then answer, new, re-read at the bottom. */
export function columnColors(cells: number[], rows: number): (Color | undefined)[] {
  const [read = 0, fresh = 0, answer = 0] = cells
  const bottomUp: Color[] = [
    ...Array.from({ length: read }, () => READ_COLOR),
    ...Array.from({ length: fresh }, () => NEW_COLOR),
    ...Array.from({ length: answer }, () => ANSWER_COLOR),
  ]

  return Array.from({ length: rows }, (_, i) => bottomUp[rows - 1 - i])
}

/** The label under a column: `1` for one step, `44–86` for a run. */
export const groupLabel = (g: MeterGroup): string => (g.fromStep === g.toStep ? `${g.fromStep}` : `${g.fromStep}–${g.toStep}`)

/** The column that holds the first step after the last /compact; -1 = no marker. */
export function markerIndex(d: MeterData): number {
  if (d.compactAt === null) return -1
  const at = d.groups.findIndex(g => g.toStep > (d.compactAt ?? 0))

  return at > 0 ? at : -1
}

type Mark = { start: number; text: string; color?: Color }
const overlaps = (a: Mark, b: Mark) => a.start < b.start + b.text.length + 1 && b.start < a.start + a.text.length + 1

/** A row of text labels at the given starts, left to right, with the gaps between them. */
function axisRow(k: Kit, marks: Mark[]): RenderElement {
  const { Box, Text } = k
  const parts: RenderElement[] = []
  let cursor = 0
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    const text = clean(m.text)
    if (m.start > cursor) {
      parts.push(
        <Text mono dimColor>
          {' '.repeat(m.start - cursor)}
        </Text>,
      )
    }
    parts.push(
      <Text mono color={m.color} dimColor={m.color === undefined}>
        {text}
      </Text>,
    )
    cursor = m.start + text.length
  }

  return <Box>{parts}</Box>
}

function dollarsSection(k: Kit, l: Layout, d: MeterData): RenderElement {
  const { Box, Text } = k
  const title = 'Dollars per step'
  const sub = caption(k, 'main conversation · ≈ split by token type')
  const groups = d.groups
  if (groups.length === 0) return section(k, title, sub, caption(k, 'no steps yet'))

  const markAt = markerIndex(d)
  // Same three parts as the SVG's colours: where it is SVG, the legend takes its hex.
  const svgOn = l.svg !== undefined
  const legend: { color: Color; text: string }[] = [
    { color: svgOn ? l.palette.read : READ_COLOR, text: 're-read' },
    { color: svgOn ? l.palette.fresh : NEW_COLOR, text: 'new: stored' },
    { color: svgOn ? l.palette.answer : ANSWER_COLOR, text: 'answer' },
  ]
  const legendRow = (
    <Box flexWrap="wrap" gap={2} marginTop={1}>
      {legend.map(e => (
        <Box gap={1}>
          <Text color={e.color}>{'■'}</Text>
          <Text>{clean(e.text)}</Text>
        </Box>
      ))}
    </Box>
  )

  const w = svgWidth(l)
  const peak = Math.max(...groups.map(g => g.readUsd + g.newUsd + g.answerUsd))
  const alt = `Dollars per step: ${groups.length} column${groups.length === 1 ? '' : 's'} of main-conversation steps ${groups[0]?.fromStep ?? 1} to ${lastStep(d)}, tallest ${dollars(peak)}${markAt >= 0 ? `, /compact before step ${groups[markAt]?.fromStep ?? ''}` : ''}`
  const drawn = drawSvg(l, alt, w, DOLLARS_HEIGHT, () => dollarsSvg(groups, markAt, l.palette, w))
  if (drawn !== undefined) return section(k, title, sub, drawn, legendRow)

  // No `Svg` (the terminal), or it could not be built: cells of text blocks.
  const rows = TERMINAL_ROWS
  const top = niceTop(peak)
  const topLabel = dollars(top)
  const gutter = Math.max(topLabel.length, 2) + 1
  const markCells = markAt >= 0 ? 1 : 0
  // Column pitch: the room shared out, one cell of it a gap; a column is at most 4 wide.
  const slot = Math.max(1, Math.floor((l.width - gutter - markCells) / groups.length))
  const colW = Math.min(COLUMN_MAX, Math.max(1, slot - 1))
  const colors = groups.map(g => columnColors(stackCells([g.readUsd, g.newUsd, g.answerUsd], top, rows), rows))
  const starts: number[] = []
  let pos = gutter
  groups.forEach((_, i) => {
    if (i === markAt) pos += 1
    starts.push(pos)
    pos += slot
  })
  const chartWidth = pos
  const markerStart = markAt >= 0 ? (starts[markAt] ?? 1) - 1 : -1

  const lines = Array.from({ length: rows }, (_, r) => {
    const runs: { color?: Color; text: string }[] = []
    const push = (color: Color | undefined, text: string) => {
      if (text === '') return
      const last = runs[runs.length - 1]
      if (last && last.color === color) last.text += text
      else runs.push({ color, text })
    }
    groups.forEach((_, i) => {
      if (i === markAt) push(COMPACT_COLOR, '┊')
      const c = colors[i]?.[r]
      push(c, (c ? '█' : ' ').repeat(colW))
      push(undefined, ' '.repeat(slot - colW))
    })
    const gutterText = r === 0 ? topLabel : r === rows - 1 ? '$0' : ''

    return (
      <Box>
        <Text mono dimColor>
          {gutterText.padEnd(gutter)}
        </Text>
        {runs.map(run => (
          <Text mono color={run.color}>
            {run.text}
          </Text>
        ))}
      </Box>
    )
  })
  const chart = <Box flexDirection="column">{lines}</Box>

  // x axis: the first column's label, the last one's range, the middle ones only
  // with room (6 cells a column). `/compact` goes under its line, or above the chart when
  // it would run into a label.
  const place = (marks: Mark[], text: string, centre: number, color?: Color): boolean => {
    const mark: Mark = { start: labelStart(centre, text.length, chartWidth), text, color }
    if (marks.some(m => overlaps(m, mark))) return false
    marks.push(mark)

    return true
  }
  const centre = (i: number) => (starts[i] ?? 0) + Math.floor(colW / 2)
  const label = (i: number) => groupLabel(groups[i] as MeterGroup)
  const axis: Mark[] = []
  place(axis, label(0), centre(0))
  if (groups.length > 1) place(axis, label(groups.length - 1), centre(groups.length - 1))
  let compactAbove = false
  if (markAt >= 0) compactAbove = !place(axis, COMPACT_LABEL, markerStart, COMPACT_COLOR)
  if (slot >= 6) for (let i = 1; i < groups.length - 1; i++) place(axis, label(i), centre(i))

  return section(
    k,
    title,
    sub,
    compactAbove ? axisRow(k, [{ start: labelStart(markerStart, COMPACT_LABEL.length, chartWidth), text: COMPACT_LABEL, color: COMPACT_COLOR }]) : null,
    chart,
    axisRow(k, axis),
    legendRow,
  )
}

// -- 7. Guard ---------------------------------------------------------------
function guardSection(k: Kit, d: MeterData): RenderElement {
  const { Box, Text } = k

  return section(
    k,
    'Guard',
    d.guardLines.length === 0 ? caption(k, 'nothing blocked or switched yet') : null,
    ...d.guardLines.map(g => (
      <Box gap={1}>
        <Text color={g.kind === 'blocked' ? BAD : WARN}>{'●'}</Text>
        <Text>{clean(g.text)}</Text>
      </Box>
    )),
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
async function note($: Dollar, kind: 'blocked' | 'switched', text: string, toast: string): Promise<void> {
  try {
    await commit($, d => guardLine(d, kind, text))
    $.ui.toast(toast)
  } catch {
    // the line and the toast are courtesy; the guard itself already decided
  }
}

const NO_NESTING = 'Meter: no nested agents — return to the main session.'

export const register: Register = (on, options) => {
  void options

  on('session.start', async ($, e, next) => {
    await registerCommand($) // awaited: listed by the first prompt; never throws
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    ensureTicker($)

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    ensureMeter($)
    await refreshTheme($) // the person may have changed it since the pane last drew
    const now = await readNow($)
    const u = await readUsage($)
    const d = await commit($, x => {
      const y: MeterData = { ...x, nowMs: now, costUsd: u?.usd ?? x.costUsd }

      return u ? withContext(y, u.tokens) : y
    })
    // A "gh unavailable" / failed row is tried once more on every /meter (the tick never polls it);
    // a "not found" row only after a minute, so two /meter calls cannot drop it.
    const ci = await readCi($)
    const stale = ci
      .filter(p => (p.fetch === 'not-found' ? now - p.checkedAt >= MIN : now - p.checkedAt >= 10_000 || p.fetch !== 'ok'))
      .map(p => p.url)
    scheduleCiRefresh($, stale)

    return { text: summary(d, ci) }
  })

  // Read-only: the theme is only noticed, never denied or changed. The pane
  // redraws in the new palette.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const out = await next(e)
    try {
      if (out.deny === undefined) setTheme($, out.value)
    } catch {
      // noticing a theme never fails a /config change
    }

    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    ensureMeter($)
    const k = $.ui.resolve(e)
    const { Box, Text } = k
    try {
      const d = await readData($) // never the raw stored value
      const ci = await readCi($)
      const columns = e.props.bodyColumns ?? 40
      // Scale the charts to the room (up to 120 cells). Where the surface has
      // `Svg` they are drawn at 8 px a cell, in the palette of the person's theme.
      const svg: SvgTag = e.surface === 'terminal' ? undefined : (k as Pick<Elements['desktop'], 'Svg'>).Svg
      const layout: Layout = {
        surface: e.surface,
        width: clamp(columns - 2, 16, 120),
        svg: typeof svg === 'function' ? svg : undefined,
        palette: await currentPalette($),
      }

      return (
        <Box flexDirection="column" paddingX={1}>
          {costSection(k, d)}
          {contextSection(k, layout, d)}
          {cacheSection(k, layout, d)}
          {workSection(k, layout, d)}
          {ciSection(k, layout, ci)}
          {dollarsSection(k, layout, d)}
          {guardSection(k, d)}
        </Box>
      )
    } catch {
      // Whatever went wrong, the engine still gets a tree; the next booked step rewrites the value.
      return (
        <Box paddingX={1}>
          <Text dimColor>Meter is resetting…</Text>
        </Box>
      )
    }
  })

  // -- the engine's own numbers: session cost and context --------------------
  // Only the totals are stored here. Who the cost belongs to is decided in
  // `turn.step`, which reads the engine's total right after `next` resolves
  // (the ledger is already updated by then, main thread and subagents alike).
  on('session.measure', async ($, e, next) => {
    try {
      const now = await readNow($)
      const cost = e.cost?.usd
      const ctx = e.context.tokens
      await commit($, d => {
        let n: MeterData = { ...d, nowMs: now }
        if (cost !== undefined) n = { ...n, costUsd: cost }
        if (ctx !== undefined || e.changed.includes('context')) n = withContext(n, ctx ?? 0)

        return n
      })
    } catch {
      // observing never fails a hook
    }

    return next(e)
  })

  // -- every model request: cost per step, per-agent usage, cache clock ------
  on('turn.step', async function* ($, e, next) {
    ensureMeter($)
    inFlight++
    let startedAt = 0
    let r
    try {
      startedAt = await readNow($)
      lastActivityAt = startedAt
      await primeCursor($) // the first step's cost is the growth from this reading
      r = yield* next(e)
    } finally {
      inFlight = Math.max(0, inFlight - 1)
    }
    try {
      const now = await readNow($)
      lastActivityAt = now
      const u = await readUsage($)
      const usage = r.usage
      const agentId = e.agentId
      // A request from an agent we have no spawn row for yet (its first step can
      // land before `agent.spawn` returns, or it came from a workflow): ask the
      // engine what type it is, so the row is not just "agent".
      const label =
        agentId !== undefined && !(await readData($)).agents.some(a => a.id === agentId) ? await agentLabel($, agentId) : undefined
      await commit($, d => {
        let n: MeterData = { ...d, nowMs: now }
        let growth = 0
        if (u?.usd !== undefined) {
          n = { ...n, costUsd: u.usd }
          if (n.costCursor === null) n = { ...n, costCursor: u.usd }
          else {
            growth = Math.max(0, u.usd - n.costCursor)
            n = { ...n, costCursor: Math.max(n.costCursor, u.usd) }
          }
        }
        if (u) n = withContext(n, u.tokens)
        const reads = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0
        const wrote = usage ? usage.output_tokens : 0

        if (agentId === undefined) {
          if (!usage) return n
          // Learn the cache TTL from what a long pause did to the cache.
          let { cacheTtl, cacheTtlSource } = n
          if (d.lastResponseAt !== null && cacheTtlSource !== 'engine') {
            const gap = startedAt - d.lastResponseAt // idle gap: to the step's START, not its end
            if (gap > 5 * MIN && gap < 60 * MIN && d.contextTokens > 0) {
              if (usage.cache_read_input_tokens >= 0.5 * d.contextTokens) [cacheTtl, cacheTtlSource] = ['1h', 'observed']
              else if (usage.cache_read_input_tokens <= 0.1 * d.contextTokens) [cacheTtl, cacheTtlSource] = ['5m', 'observed']
            }
          }
          const model = family(usage.model)
          n = {
            ...n,
            mainModel: model,
            lastResponseAt: now,
            coldToasted: false,
            cacheTtl,
            cacheTtlSource,
          }

          // The chart: this step's exact cost, shared out by token type (main thread only).
          const booked = book(n, mainBucketOf(usage.model), growth, wrote)
          const added = addToGroups(booked.groups, booked.groupSize, splitCost(growth, usage, cacheTtl))

          return { ...booked, groups: added.groups, groupSize: added.groupSize }
        }

        // A subagent's request: usage and model come with its own agentId, so
        // it is told apart from the main thread's.
        const known = n.agents.find(a => a.id === agentId)
        const bucket = known?.bucket ?? bucketOf(usage?.model ?? '')
        const row: MeterAgent = known ?? {
          id: agentId,
          name: agentName(label ?? 'agent'),
          model: family(usage?.model ?? 'unknown'),
          bucket,
          read: 0,
          written: 0,
          usd: 0,
          status: 'running',
          startedAt: now,
          endedAt: null,
          warned: false,
        }
        const updated = { ...row, read: row.read + reads, written: row.written + wrote, usd: row.usd + growth }
        const agents = known ? n.agents.map(a => (a.id === agentId ? updated : a)) : [...n.agents, updated].slice(-MAX_AGENTS)

        return book({ ...n, agents }, bucket, growth, wrote)
      })
    } catch {
      // observing never fails a hook
    }

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    try {
      const now = await readNow($)
      const agentId = e.agentId
      const usage = e.usage
      const label =
        agentId !== undefined && (await readData($)).agents.some(a => a.id === agentId && a.name === 'agent') ? await agentLabel($, agentId) : undefined
      await commit($, d => {
        let n: MeterData = { ...d, nowMs: now }
        if (agentId !== undefined) {
          const total = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined
          const wrote = usage?.output_tokens
          const mine = n.agents.find(a => a.id === agentId)
          // A final total that is bigger than the steps added up means a step was
          // missed: take the bigger number, and book the difference to its bucket.
          const extra = mine && wrote !== undefined ? Math.max(0, wrote - mine.written) : 0
          n = {
            ...n,
            agents: n.agents.map(a =>
              a.id === agentId
                ? {
                    ...a,
                    name: a.name === 'agent' && label !== undefined ? agentName(label) : a.name,
                    status: e.reason === 'answer' ? 'done' : 'failed',
                    endedAt: now,
                    read: total !== undefined ? Math.max(a.read, total) : a.read,
                    written: wrote !== undefined ? Math.max(a.written, wrote) : a.written,
                  }
                : a,
            ),
          }

          return mine && extra > 0 ? { ...n, written: { ...n.written, [mine.bucket]: n.written[mine.bucket] + extra } } : n
        }
        // A main-session turn ended: was an implementer finished after the
        // last verifier started, and not yet flagged?
        const since = n.lastVerifierAt ?? 0
        n = {
          ...n,
          agents: n.agents.map(a =>
            isType(a.name, 'implementer') && a.endedAt !== null && a.endedAt > since && !a.warned ? { ...a, warned: true } : a,
          ),
        }

        return n
      })
    } catch {
      // observing never fails a hook
    }

    return out
  })

  on('session.compact', async ($, e, next) => {
    const out = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && out.skip === undefined) {
        await commit($, d => ({ ...d, compactAt: lastStep(d) > 0 ? lastStep(d) : null }))
      }
    } catch {
      // observing never fails a hook
    }

    return out
  })

  // The engine says the cache TTL on a model switch; nowhere else.
  on('classic.PostModelSwitch', async ($, e, next) => {
    try {
      await commit($, d => ({ ...d, cacheTtl: e.cache_ttl, cacheTtlSource: 'engine', mainModel: family(e.to_model) }))
    } catch {
      // observing never fails a hook
    }

    return next(e)
  })

  // -- the guard --------------------------------------------------------------
  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId !== undefined) {
      await note($, 'blocked', 'Blocked: nested agent', 'Meter: blocked a nested agent')

      return { deny: NO_NESTING }
    }
    let spawn = e
    const inherits = e.model === undefined || e.model === '' || e.model === 'inherit'
    // A workflow script chose its own model, and a resume continues a run that
    // already has one: neither is rewritten, neither gets a guard line or toast.
    if (e.workflow === undefined && e.resume === undefined && inherits && !e.fork && /opus/i.test(e.parentModel) && (e.subagentType === 'Explore' || e.subagentType === 'general-purpose')) {
      const model = e.subagentType === 'Explore' ? 'haiku' : 'sonnet'
      spawn = { ...e, model }
      await note($, 'switched', `${e.subagentType} → switched to ${family(model)}`, `Meter: ${e.subagentType} → ${family(model)}`)
    }
    const started = await next(spawn)
    try {
      if (started.deny === undefined && started.agentId !== undefined) {
        const id = started.agentId
        const model = started.model === 'inherit' || started.model === '' ? e.parentModel : started.model
        const now = await readNow($)
        const resumed = e.resume !== undefined
        await commit($, d => {
          const old = d.agents.find(a => a.id === id)
          // A resumed agent keeps its row (tokens and dollars so far); it only runs again.
          // `subagentType` is the agent type; a teammate has none (`teammate`), so its name stands in.
          const kind = agentName(e.subagentType !== '' && e.subagentType !== 'teammate' ? e.subagentType : (e.name ?? (e.subagentType || 'agent')))
          const row: MeterAgent =
            resumed && old
              ? { ...old, status: 'running', endedAt: null, warned: false }
              : old
                ? { ...old, name: kind, model: family(model) } // its first step ran before this returned: keep what it already booked
                : {
                  id,
                  name: kind,
                  model: family(model),
                  bucket: bucketOf(model),
                  read: 0,
                  written: 0,
                  usd: 0,
                  status: 'running',
                  startedAt: now,
                  endedAt: null,
                  warned: false,
                }
          const agents = old ? d.agents.map(a => (a.id === id ? row : a)) : [...d.agents, row].slice(-MAX_AGENTS)

          return {
            ...d,
            nowMs: now,
            lastVerifierAt: isType(kind, 'verifier') ? now : d.lastVerifierAt,
            agents,
          }
        })
      }
    } catch {
      // recording never fails a spawn
    }

    return started
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Meter: guard failed; agent not started.' }))

  // -- GitHub PRs this session touched ----------------------------------------
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      // Only a command that is itself `gh pr create|view|checks|merge` may add
      // PRs: `gh pr list`, `git log`, `cat notes.md` print URLs that are not ours.
      // Only the MAIN thread's own commands count (no `agentId`): a subagent's
      // test commands are full of made-up URLs that must not reach the pane.
      if (e.agentId === undefined && isGhPrCommand(e.command)) {
        const urls = [...prUrlsIn(e.command), ...prUrlsIn(ran.deny === undefined ? (ran.text ?? '') : '')]
        const fromGh = prUrlFromGh(e.command)
        if (fromGh !== undefined) urls.push(fromGh)
        await noteSeenPrs($, urls)
      }
    } catch {
      // detecting never fails a Bash call
    }

    return ran
  })
}
