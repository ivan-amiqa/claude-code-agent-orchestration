// Contract of the `meter` mod: ONE atom holds everything the pane draws.
// Phase 2: filled from live engine events. Nothing here is ever sent to the
// model; the mod only counts numbers the engine already reports.

/** The four buckets of the "who did the work" bar; each has its own colour. */
export type MeterBucket = 'opus-main' | 'haiku' | 'sonnet' | 'opus-checks'

export type MeterModelCost = { bucket: MeterBucket; label: string; usd: number }

export type MeterAgent = {
  /** The agent's id from `agent.spawn`, as `turn.step` / `turn.complete` carry it. */
  id: string
  /** Agent type as spawned (`subagentType`, else the definition's name): scout, implementer, verifier... Cleaned of control characters, at most 40 characters. */
  name: string
  /** Model as shown in the row: Haiku, Sonnet, Opus (or the raw id). */
  model: string
  bucket: MeterBucket
  /** Tokens its requests read: input + cache read + cache write. */
  read: number
  /** Tokens its requests wrote: output tokens, exact from usage. */
  written: number
  /** Approximate dollars: the ledger's growth around its requests (shown with ≈). */
  usd: number
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number | null
  /** True once the "no verifier after it" toast was raised for this one. */
  warned: boolean
}

export type MeterGuardLine = { kind: 'blocked' | 'switched'; text: string }

/**
 * One column of the "Dollars per step" chart: a run of MAIN-THREAD steps
 * (numbered from 1 since the mod loaded) and what they cost, split by token
 * type. The three parts add up to the engine's exact cost for those steps.
 */
export type MeterGroup = {
  /** First and last step number the column covers (equal for a single step). */
  fromStep: number
  toStep: number
  /** Cache reads ("seen before: re-read"), dollars. */
  readUsd: number
  /** Cache writes + uncached input ("new: stored"), dollars. */
  newUsd: number
  /** Output ("its answer"), dollars. */
  answerUsd: number
}

/** The PR's own state, as GitHub says it (a draft is an open PR with `isDraft`). */
export type MeterPrKind = 'open' | 'draft' | 'merged' | 'closed'

/**
 * What the last `gh pr view` said: `loading` = not asked yet, `ok` = read,
 * `not-found` = gh ran and the PR / repo is not there for us, `error` = gh ran
 * and failed for another reason (offline, auth), `unavailable` = no gh binary ran.
 */
export type MeterPrFetch = 'loading' | 'ok' | 'not-found' | 'error' | 'unavailable'

/** One PR the main session touched. Only URL, title and counts are kept. */
export type MeterPr = {
  url: string
  /** `owner/repo#N` */
  label: string
  title: string
  /** null until the first successful read. */
  kind: MeterPrKind | null
  adds: number
  dels: number
  /** Checks passed / failed / still pending, from `statusCheckRollup`. */
  pass: number
  fail: number
  pending: number
  /** Names of failing checks, at most 3. */
  failing: string[]
  fetch: MeterPrFetch
  /** Consecutive `not-found` reads; a second one drops the row. */
  misses: number
  checkedAt: number
  /** When the PR was first seen (or seen again); polling stops 60 min later. */
  addedAt: number
}

// Bump the atom's `shape` tag in hooks/register.tsx (now `meter-6`) on EVERY
// change to MeterData, and keep `sane()` in step with it: a stored value is
// never trusted to be complete. The tracked PRs are NOT in here: they live in
// their own atom (key `ci`, shape `ci-1`, a `MeterPr[]`) so that a bump of this
// tag never wipes them.
export type MeterData = {
  /** Session cost at list price, dollars: the engine's own total. */
  costUsd: number
  /** Tokens every call re-reads: the engine's `context.tokens`. */
  contextTokens: number
  /** Family of the main model: Opus, Sonnet, Haiku. */
  mainModel: string
  /** Last time the pane's clock was written, ms since epoch. */
  nowMs: number
  /** Time of the last main-thread response; null before the first. */
  lastResponseAt: number | null
  cacheTtl: '5m' | '1h'
  /** Where `cacheTtl` came from: the engine says it (model switch), it was
   * seen from a cache hit/miss, or it is the default. */
  cacheTtlSource: 'engine' | 'observed' | 'assumed'
  /** The "cache went cold" toast was raised since the last response. */
  coldToasted: boolean
  /** Highest context mark passed and already toasted: 0, 350 or 500 (k). */
  crossed: 0 | 350 | 500
  /** Engine cost total already shared out to steps; null until first read. */
  costCursor: number | null
  /** Dollars the cost ledger grew during each bucket's requests. */
  spend: Record<MeterBucket, number>
  /** Output tokens each bucket wrote (exact, from usage). */
  written: Record<MeterBucket, number>
  agents: MeterAgent[]
  /** The chart's columns, oldest first, at most 12. The first is step 1 alone. */
  groups: MeterGroup[]
  /** Steps per column after the first; doubles each time the columns are merged pairwise. */
  groupSize: number
  /** Main-thread steps booked before the last /compact; null = none. The marker sits before the column holding the next step. */
  compactAt: number | null
  /** What the guard did, newest last, at most 5. */
  guardLines: MeterGuardLine[]
  /** Start time of the latest `verifier` agent; null = none yet. */
  lastVerifierAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    meter: { data: Shaped<MeterData>; ci: Shaped<MeterPr[]> }
  }
}
