# Claude Code agent orchestration

A small, copyable setup for running [Claude Code](https://code.claude.com) as **one boss and a team of cheaper specialists**, plus a script to measure what it saves you.

From the talk *AI in the Wild: what it actually costs to build with it* (Digit, Tartu, 9 October 2026) by Iván Elorza Tahum.

## Use it

Copy the agent files into your project, or into your home folder to use them everywhere:

```bash
git clone https://github.com/ivan-amiqa/claude-code-agent-orchestration
mkdir -p .claude/agents && cp claude-code-agent-orchestration/.claude/agents/*.md .claude/agents/    # this project
# or:  mkdir -p ~/.claude/agents && cp claude-code-agent-orchestration/.claude/agents/*.md ~/.claude/agents/
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

1. **The right price for each job.** Searching and log reading run on Haiku ($1 / $5 per million tokens read / written) instead of the boss's Opus ($4 / $20).
2. **Context isolation.** A sub-agent works in its own conversation and returns a short summary. Its reading never enters the boss's context, so the boss doesn't re-read it on every turn.

## The team

| Agent | Model | Job |
|---|---|---|
| the boss (your main session) | Opus | plans, decides, talks to you |
| [`scout`](.claude/agents/scout.md) | Haiku | finds where things are; read-only tools; answers with `file:line` and the command to reproduce it |
| [`log-digger`](.claude/agents/log-digger.md) | Haiku | reads 10,000 noisy lines, returns the 10 that matter |
| [`implementer`](.claude/agents/implementer.md) | Sonnet | writes code from a plan that is already decided; asks instead of guessing |
| [`verifier`](.claude/agents/verifier.md) | Opus | fresh context, no memory of the boss's reasoning: tries to prove it wrong |
| [`pr-reviewer`](.claude/agents/pr-reviewer.md) | Opus | reviews a diff against the right base, findings ranked by what actually breaks |

## Four rules, each from a real mistake

1. **Agents can't start agents.** Every agent that doesn't need it has `disallowedTools: Agent`. We once launched 12 checkers at once; each started its own helpers, and the whole session limit was gone in about ten minutes, with zero results. Test it in a fresh session: ask an agent to list its tools.
2. **Waves of 3 or 4, never 12 at once.** Each wave finishes before the next starts.
3. **Pin `model` and `effort` in every agent file.** Claude Code's built-in `Explore` helper has no fixed model: it inherits your session's. In an Opus session, every "cheap" search is an Opus search.
4. **Copies run on Sonnet.** When one job fans out to many copies (one reviewer per PR, say), pass `model: "sonnet"` on each call instead of letting them inherit the boss's model.

## What it saved us

Our own Claude Code logs, API calls dated 15–29 September 2026: 108 sessions, 75 with agents. We're on a Claude Team plan, so these are API-equivalent dollars at list price, and the "saved" side is an estimate (the script's header explains exactly how it's computed).

| | |
|---|---|
| Money | **$1,800–2,500 saved in two weeks**: a 28–35% smaller bill than the boss doing the agents' work itself |
| Time | **40 hours of waiting saved**: 148 h of agent work finished in 108 h, because agents run in parallel |
| Scouting | **−76%**: 137 scout jobs, $39 on Haiku instead of $159 |
| Before rule 1 | 106 agents started by other agents: $163 |

## Measure your own

```bash
python3 tools/orchestration_cost.py --from 2026-09-15 --to 2026-09-29
```

It reads your local logs in `~/.claude/projects`, needs only Python 3, and sends nothing anywhere. Add `--project ~/.claude/projects/<dir>` to look at one project. Update `PRICES` at the top when prices change.

One trap it avoids: don't select sessions by file date. Claude Code can touch old session files, and our first count of "the last two weeks" silently included two older months.

## Licence

MIT. Prices and model names are as of October 2026: check the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) before you rely on them.
