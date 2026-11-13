# Claude Code agent orchestration

A small, copyable setup for running [Claude Code](https://code.claude.com) as **one boss and a team of cheaper specialists**, plus a script to measure what it saves you.

From the talk *AI in the Wild: what it actually costs to build with it* (Digit, Tartu, 9 October 2026; DevCon Bucharest, 4 November 2026) by Iván Elorza Tahum.

## Meter (cost meter mod)

A Claude Code mod that shows, live next to your chat, what the session costs and who did the work: context size, cache countdown, cost by model and by sub-agent, dollars per step, GitHub checks. It also enforces two of the rules below (no nested agents; `Explore` and `general-purpose` don't inherit Opus). It uses zero model tokens. Details and honest caveats: [`plugins/meter/`](plugins/meter/README.md).

```text
/plugin install meter --marketplace ivan-amiqa/claude-code-agent-orchestration
```

## Use it

Copy the agent files into your project, or into your home folder to use them everywhere:

```bash
git clone https://github.com/ivan-amiqa/claude-code-agent-orchestration
mkdir -p .claude/agents && cp claude-code-agent-orchestration/.claude/agents/*.md .claude/agents/    # this project
# or:  mkdir -p ~/.claude/agents && cp claude-code-agent-orchestration/.claude/agents/*.md ~/.claude/agents/
```

### Optional: the guard hooks

The agents work on their own. The hooks make the rules harder to forget. They need `jq` (the merge gate also needs `python3`, `perl` and `gh`) and are per project: copy them next to your agents.

```bash
mkdir -p .claude/hooks && cp claude-code-agent-orchestration/.claude/hooks/*.sh .claude/hooks/ && chmod +x .claude/hooks/*.sh
cp claude-code-agent-orchestration/.claude/settings.json .claude/settings.json   # or merge its `hooks` and `permissions` blocks into yours
```

- [`delegation-guard.sh`](.claude/hooks/delegation-guard.sh) reminds the boss to delegate (after 6 code-reading calls with no scout/log-digger, after 4 code edits with no implementer, and on `gh pr create`/`merge` with no verifier run). It **blocks** a PR merge unless `pr-reviewer` was started on that PR after the last code change. A Bash merge has to be one plain command that fits a short allowlist (no `$(...)`, backticks, `||`, `&`, subshells, heredocs, `bash -c`, `eval` or `curl`); anything the guard can't read exactly is denied, so it fails closed. `gh api …/pulls/N/merge` and the desktop app's own auto-merge tool (`mcp__ccd_pr__set_auto_merge`) are gated too. When the command doesn't name the PR, the guard looks it up with one bounded `gh pr view` call (killed after a few seconds; a timeout denies). It is a guardrail, not a security boundary: deliberate dodges (`python3 -c`, a `gh` alias, a GraphQL `mergePullRequest`) are out of scope. It only knows the reviewer was started, not its verdict: read it before you merge. If the review happened elsewhere, or you are deliberately merging your own work, add a comment on the same line as the merge: `# reviewed-by: <reason>`. Its counters live in a per-user folder (mode 0700); if that folder or the session id looks wrong, merges are denied rather than waved through.
- [`secret-guard.sh`](.claude/hooks/secret-guard.sh) blocks a Bash command that contains a literal key (common token shapes) or prints a macOS Keychain secret bare. A regex safety net, not the control: the rule in `CLAUDE.md.example` is what holds.
- [`goal-inject.sh`](.claude/hooks/goal-inject.sh) keeps the original goal alive across days and compactions. When a prompt names a task thread file, it injects the top of that file (everything above `## Agenda`) once per session; a long brief that names no thread file gets one warning. See "Task threads" in `CLAUDE.md.example`.
- [`worktree-guard.sh`](.claude/hooks/worktree-guard.sh) never blocks. Before a state-changing `git`/`gh` command it prints which repo and branch it will hit.
- [`context-size-guard.sh`](.claude/hooks/context-size-guard.sh) never blocks. When the main session passes 350k tokens of context it mentions it once; at 500k it recommends `/compact` or a fresh session, because every step re-reads the whole context.

All the knobs are optional environment variables, documented at the top of each script:

| Variable | Default | What it does |
|---|---|---|
| `DELEGATION_GUARD_READ_LIMIT` | `6` | code-reading calls before the scout reminder |
| `DELEGATION_GUARD_EDIT_LIMIT` | `4` | code edits before the implementer reminder |
| `DELEGATION_GUARD_IGNORE_GLOB` | `docs/*:*/docs/*:memory/*:*/memory/*` | colon-separated path globs that are not code (they never count towards the limits) |
| `DELEGATION_GUARD_GH_TIMEOUT` / `DELEGATION_GUARD_DEADLINE` | `10` / `11` | seconds for the one `gh pr view` lookup, and the overall budget (both capped at 12, under the hook's 15 s timeout) |
| `CONTEXT_WARN_1` / `CONTEXT_WARN_2` | `350000` / `500000` | context size (tokens) for the two reminders |
| `GOAL_INJECT_GLOB` | `docs/threads/task-*.md` | where task thread files live (one glob, or several separated by colons) |
| `TMPDIR` | `/tmp` | where the hooks keep their per-session state |

`.claude/settings.json` also carries a `permissions` block: `git push` is denied (Claude asks you to run it, so nothing leaves your machine without your OK), a short allow list of read-only `gh` commands (`pr view/checks/list/diff`, `run view/list/watch`), and a deny for `mcp__ccd_session__start_session` and `mcp__ccd_session__hand_off_to_session`, the Claude desktop app's session tools. That last one is what enforces the "one session, subagents only" rule in [`CLAUDE.md.example`](CLAUDE.md.example): Claude can't start or hand off to another session, only you can. Merge what you want into your own settings.

To disable one hook, delete its entry from `.claude/settings.json`; to disable all, delete the file or the `hooks` block. Without `jq` the delegation checks switch themselves off, except that merges are refused rather than waved through.

The hooks have tests, in [`.claude/hooks/tests/`](.claude/hooks/tests/). They use fake hook inputs, a stub `gh` and a temp folder, and touch nothing else:

```bash
bash .claude/hooks/tests/context-size-guard.test.sh     # context-size-guard, goal-inject, secret-guard, settings.json
/bin/bash .claude/hooks/tests/delegation-guard.test.sh  # the merge gate and the reminders
```

Then let Claude fit them to your project. Paste this into Claude Code:

```text
Read claude-code-agent-orchestration/CLAUDE.md.example and merge its delegation rules into
this project's CLAUDE.md. Don't overwrite what's there: if a rule conflicts with an existing
one, or with my existing agents in .claude/agents/, list the conflicts and ask me before
changing anything. Then replace the placeholder invariants in .claude/agents/implementer.md
and .claude/agents/pr-reviewer.md with this project's real ones, based on the code, and show
me the diff.
```

Finally, start a new Claude Code session and run `/agents` to check they're loaded.

## Why it saves money

You don't pay per question, you pay per token. And **the model has no memory**: on every message, Claude Code sends the whole conversation again. The cache makes re-reading cheap, but not free. So in one long session, everything the model ever read (files, logs, test output) is paid for again on every later turn.

Orchestration attacks that in two ways:

1. **The right price for each job.** Searching and log reading run on Haiku 5.5 ($0.10 / $0.50 per million tokens read / written, for prompts up to 100,000 tokens) instead of the boss's Opus 5.5 ($4 / $20).
2. **Context isolation.** A sub-agent works in its own conversation and returns a short summary. Its reading never enters the boss's context, so the boss doesn't re-read it on every turn.

## The team

| Agent | Model | Job |
|---|---|---|
| the boss (your main session) | Opus 5.5 | plans, decides, talks to you |
| [`scout`](.claude/agents/scout.md) | Haiku 5.5 | finds where things are; read-only tools; answers with `file:line` and the command to reproduce it |
| [`log-digger`](.claude/agents/log-digger.md) | Haiku 5.5 | reads 10,000 noisy lines, returns the 10 that matter |
| [`implementer`](.claude/agents/implementer.md) | Sonnet 5.5 | writes code from a plan that is already decided; asks instead of guessing |
| [`verifier`](.claude/agents/verifier.md) | Opus 5.5 | fresh context, no memory of the boss's reasoning: tries to prove it wrong |
| [`pr-reviewer`](.claude/agents/pr-reviewer.md) | Opus 5.5 | reviews a diff against the right base, findings ranked by what actually breaks |

## Four rules, each from a real mistake

1. **Agents can't start agents.** Every agent that doesn't need it has `disallowedTools: Agent`. We once launched 12 checkers at once; each started its own helpers, and the whole session limit was gone in about ten minutes, with zero results. Test it in a fresh session: ask an agent to list its tools.
2. **Waves of 3 or 4, never 12 at once.** Each wave finishes before the next starts.
3. **Pin `model` in every agent file, with the full model id, and `effort` on the Opus and Sonnet agents (Haiku ignores it).** Claude Code's built-in `Explore` helper has no fixed model: it inherits your session's. In an Opus session, every "cheap" search is an Opus search. And write `claude-haiku-5-5`, not `haiku`: an alias silently moves to the next version, with a new price and new behaviour. (The call-time `model: "sonnet"` override in rule 4 only accepts aliases.)
4. **Copies run on Sonnet.** When one job fans out to many copies (one reviewer per PR, say), pass `model: "sonnet"` on each call instead of letting them inherit the boss's model.

And one habit under all four: **verify, don't assume.** Cheap agents are only a saving if their answers are checked. The scout cites `file:line` with the command to reproduce it, the verifier tries to prove the boss wrong, and [`CLAUDE.md.example`](CLAUDE.md.example) tells the boss to treat every doc, note and summary as a claim until it's checked against live state.

## What it saved us

Our own Claude Code logs for one project (our main workspace), API calls dated 15–29 September 2026, priced at that time's list prices, when the agents still ran Haiku 4.5: 108 sessions, 75 with agents. We're on a Claude Team plan, so these are API-equivalent dollars at list price, and the "saved" side is an estimate (the script's header explains exactly how it's computed).

| | |
|---|---|
| Money | **$1,800–2,500 saved in two weeks**: a 28–35% smaller bill than the boss doing the agents' work itself |
| Time | **40 hours of waiting saved**: 148 h of agent work finished in 108 h, because agents run in parallel |
| Scouting | **−76%**: 137 scout jobs, $39 on Haiku 4.5 instead of $159 |
| Before rule 1 | 106 agents started by other agents: $163 |

## Measure your own

```bash
python3 tools/orchestration_cost.py --from 2026-09-15 --to 2026-09-29
```

It reads your local logs in `~/.claude/projects`, needs only Python 3, and sends nothing anywhere. Add `--project ~/.claude/projects/<dir>` to look at one project. Update `PRICES` at the top when prices change.

**Update, 8 October 2026:** Haiku 5.5 launched on 7 October at a tenth of Haiku 4.5's price, so the scout and log-digger jobs are now about ten times cheaper again. Two catches: prompts over 100,000 tokens cost five times more, and the same text counts as more tokens. The script prices both.

One trap it avoids: don't select sessions by file date. Claude Code can touch old session files, and our first count of "the last two weeks" silently included two older months.

## Updates

**Update, November 2026:** the delegation guard now blocks only what it can read exactly (a merge must be one plain command that fits an allowlist, and it fails closed otherwise); it also gates the desktop app's auto-merge tool, uses a per-user state folder, and looks the PR up with one bounded `gh` call. New hooks: `secret-guard.sh` and `goal-inject.sh`, plus tests for all of them. `CLAUDE.md.example` grew into a template with sections for security by design, the usage budget, plan mode, task threads, verification and reporting. The agents gained a colour each, a verbatim-evidence rule, and generic security invariants in `pr-reviewer`. `settings.json` denies `git push` and allows read-only `gh` commands.

**Update, October 2026:** the repo now ships the hooks above (`delegation-guard.sh`, `worktree-guard.sh`) and a `.claude/settings.json` that wires them in. `CLAUDE.md.example` gained the stricter delegation rules (the main session opens at most one known file; every test-suite run goes to `log-digger`; what stays in the main session; effort pinned on the Opus and Sonnet agents; the `model: "sonnet"` override is an alias), `scout` and `log-digger` now carry `disallowedTools: Agent` so rule 1 is literally true in every file, and `verifier` names any stale doc it finds.

## Licence

MIT. Prices and model names are as of October 2026: check the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) before you rely on them.
