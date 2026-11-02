# Claude Code agent orchestration

A small, copyable setup for running [Claude Code](https://code.claude.com) as **one boss and a team of cheaper specialists**, plus a script to measure what it saves you.

From the talk *AI in the Wild: what it actually costs to build with it* (Digit, Tartu, 9 October 2026) by Iván Elorza Tahum.

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

The agents work on their own. Two hooks make the rules harder to forget. They need `jq` and are per project: copy them next to your agents.

```bash
mkdir -p .claude/hooks && cp claude-code-agent-orchestration/.claude/hooks/*.sh .claude/hooks/ && chmod +x .claude/hooks/*.sh
cp claude-code-agent-orchestration/.claude/settings.json .claude/settings.json   # or merge its "hooks" block into yours
```

- [`delegation-guard.sh`](.claude/hooks/delegation-guard.sh) reminds the boss to delegate (after 6 code-reading calls with no scout/log-digger, after 4 code edits with no implementer, and on `gh pr create`/`merge` with no verifier run). It **blocks** `gh pr merge` unless `pr-reviewer` was started on that PR after the last code change. It only knows the reviewer was started, not its verdict: read it before you merge. If the review happened elsewhere, add `# reviewed-by: <reason>` to the merge command. Thresholds and the folders it treats as "not code" are environment variables, documented at the top of the script.
- [`worktree-guard.sh`](.claude/hooks/worktree-guard.sh) never blocks. Before a state-changing `git`/`gh` command it prints which repo and branch it will hit.

To disable one, delete its entry from `.claude/settings.json`; to disable both, delete the file or the `hooks` block. Without `jq` the delegation checks switch themselves off, except that merges are refused rather than waved through.

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

**Update, October 2026:** the repo now ships the hooks above (`delegation-guard.sh`, `worktree-guard.sh`) and a `.claude/settings.json` that wires them in. `CLAUDE.md.example` gained the stricter delegation rules (the main session opens at most one known file; every test-suite run goes to `log-digger`; what stays in the main session; effort pinned on the Opus and Sonnet agents; the `model: "sonnet"` override is an alias), `scout` and `log-digger` now carry `disallowedTools: Agent` so rule 1 is literally true in every file, and `verifier` names any stale doc it finds.

## Licence

MIT. Prices and model names are as of October 2026: check the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) before you rely on them.
