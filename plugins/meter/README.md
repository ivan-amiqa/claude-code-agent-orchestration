# Meter

A live cost and orchestration meter for [Claude Code](https://code.claude.com), as a mod. It sits in a pane next to your chat and shows what the session is costing, how big the context has grown, and who did the work: the main model or your sub-agents.

It is the companion to the [agent team](../../README.md) in this repo: the agents make the work cheaper, the meter shows you whether they actually did.

**It uses zero model tokens.** No model calls, no tools registered, nothing added to your prompts or to tool results. It only reads numbers Claude Code already reports and draws them.

## Install

At the prompt of a terminal session:

```text
/plugin install meter --marketplace ivan-amiqa/claude-code-agent-orchestration
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install meter --marketplace ivan-amiqa/claude-code-agent-orchestration`.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ivan-amiqa/claude-code-agent-orchestration`, then **Add plugin**.

Then run `/meter` to open the pane.

**Requirements.** Claude Code 2.1.309 or later (the version it was built and tested on). The GitHub section needs the [`gh` CLI](https://cli.github.com), signed in; without it the rest works and the PR rows say they are unavailable.

## What the pane shows

| Section | What it tells you |
|---|---|
| **Session cost**, **Context**, **Cache** | Three tiles in one row. Cost: dollars so far, at list price. Context: how many tokens every call re-reads, with a full-width gauge under the row marking 350k and 500k. Cache: a countdown to the prompt cache going cold (5 minute or 1 hour), reset on every call, with the minutes left |
| **Who did the work** | A Cost bar and a Tokens written bar, split into Opus (main), Haiku, Sonnet and Opus (agents), with one table under both: per bucket the cost and its share, the tokens written and their share. Below it one line per agent type and model (runs added up, `implementer ×2`): tokens read / written, cost, running or stopped, most expensive first |
| **GitHub** | The PRs this session opened, viewed or merged, with their state and check results |
| **Codex** | Only when this session ran [`codex-review.sh`](#the-codex-section): what Codex did, at API-equivalent prices, a line per run, the totals and the ChatGPT plan limit you typed in. Hidden when there is nothing to show |
| **Dollars per step** | A column chart of main-conversation steps, each split into what was re-read from cache, what was newly stored, and the model's answer, with a mark where you ran `/compact` |
| **Guard** | A line for every agent the mod blocked or switched; one muted line while there is nothing to report |

The status line under the prompt stays empty and only appears with a warning: context past 350k or 500k, or a cold cache while the context is large.

`/meter` also prints a one-line summary into the chat (session cost, context, cache, agents, CI, and `· Codex N runs ≈$X` when this session ran Codex). `/meter codex ...` keeps the Codex plan limit; see below.

## The Codex section

If you run a Codex review next to Claude (a script, here called `codex-review.sh`, that logs one CSV row per attempt), the pane can show what it did in this session. For anyone without that file the section never appears.

**The one file it reads** is `~/.amiqa/codex-review-runs.csv` (a fixed path; `$HOME` plus that name). It is read when a session starts, once a minute (only if the file's modification time changed), and right after a Bash call whose command contains `codex-review`. A missing file just hides the section. The mod never reads anything under `~/.codex`, never starts a `codex` process, and never goes to the network.

**The CSV format.** A header line, then a row per attempt. Columns are found by their header name, so extra columns or a different order do not matter. These are used: `timestamp` (UTC, `2026-11-09T08:16:20Z`), `label` (e.g. `acme/web-api#12`), `auth` (`plan`, `api` or `none`), `fell_back` (`yes`/`no`), `duration_s`, `exit_code`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `skip_reason`. Fields with commas, quotes or line breaks are quoted (RFC 4180); a leading `'` that guards a spreadsheet formula is taken off. **These columns are dropped as the file is parsed and never stored, drawn or put in a reply:** `user` (an email), `repo` and `out_dir` (local paths), `head_sha`, `base_sha`. Only rows at or after the session's start are shown, from the file's last 500 lines; the pane draws the latest 8 and the totals count all of them.

**What it shows.** One number, the session's Codex cost at API-equivalent prices (`(input - cached) x $2 + cached x $0.10 + output x $10` per million tokens; a guess, shown with ≈, and on a plan run nothing was actually billed), then a line per run (`label · 3m26s · 241k in (199k cached) · 6.1k out · plan`, with `↪ fell back` when it fell back from the plan to the API; skipped and failed runs say why, muted), and the totals. On a narrow pane the token counts move to a second line.

**The plan limit.** Codex does not report the ChatGPT plan limit to a script, so you type what [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage) says:

```text
/meter codex 97 6d2h                          weekly: 97% left, resets in 6 days 2 hours
/meter codex 97 6d2h 5h=80 5hreset=2h10m      plus the 5-hour window
/meter codex                                  show what is stored
```

Percentages are 0 to 100; durations are `6d2h`, `2h10m`, `45m`; anything else is refused with a one-line hint. The mod stores the percentage, the reset as an absolute time and when you entered it (in the plugin's own store, key `codex-limits-1`, kept between sessions). The pane then says `Plan: 97% week left · resets Sun 15/11 12:20 · entered 3h ago` and an estimate, `≈ 95.8% now (2 plan reviews since × ~0.6%)`: the number you typed minus about 0.6% for each plan review (`auth=plan`, exit code 0) that finished after you typed it. The 0.6% is a rough reading, not a published number; type a fresh value whenever you look at the real page. Once the reset time has passed the old number is no longer shown.

## Warnings

Toasts, each raised once:

- context passed 350k, and again at 500k ("every call re-reads it, consider a fresh session");
- the cache went cold, with how many tokens the next call will re-write;
- an `implementer` finished and no `verifier` ran after it.

## Guards

The mod enforces two of the rules from the main README:

- **No nested agents.** A sub-agent that tries to start another sub-agent is refused, with a line in the Guard section. This is the rule that would have stopped our 12-checkers-at-once session limit burn.
- **`Explore` and `general-purpose` don't inherit Opus.** When the session runs on Opus and one of those two built-in helpers would inherit it, the mod starts it on Haiku (`Explore`) or Sonnet (`general-purpose`) instead. Agents that name their own model, forks, resumes and workflow runs are left alone.

## The GitHub section

When the main conversation runs `gh pr create`, `view`, `checks` or `merge`, the mod picks the PR URL out of the command or its output and asks your local `gh` for its title, state, size and check results (`gh pr view <url> --json ...`). It refreshes while checks are running, and again each time you run `/meter`. Only PRs from the main conversation count, not those touched inside a sub-agent. Up to 8 PRs are kept.

## Notes

Read these before you quote a number.

- **Dollars are list price, not your bill.** On a subscription plan they are API-equivalent dollars, like the figures in the main README.
- **Per-agent and per-model dollars are approximate** (shown with ≈). The engine reports an exact cost for the session; the mod splits it between agents and models by step. **Token counts are exact.**
- **The dollars-per-step split uses Anthropic's fixed price ratios** (a cache read costs a tenth of input, a cache write 1.25x or 2x, output 5x). No absolute price is stored, so the parts always add up to the engine's own cost for that step, and a price change does not break it.
- **The cache TTL is inferred until observed.** Claude Code tells the mod the TTL only when you switch models. Until then the pane assumes 1 hour and says "(assumed)"; after a long idle gap it learns the real value from how much was read back from cache and says "(observed)".
- **It counts only since the mod loaded.** Earlier spend in the same session is not in the chart or the agent rows.
- **Zero model tokens.** It never calls a model, registers no tool, and adds nothing to prompts or tool results. The only text it reads from a command or result is GitHub PR URLs, and a Bash command is only checked for the word `codex-review`.

## Security

- It reads session numbers (cost, context, token usage) and agent names. Agent names and PR titles are stripped of control characters and length-capped before they are drawn.
- The one file it reads is `~/.amiqa/codex-review-runs.csv` (see [the Codex section](#the-codex-section)): a fixed path, never built from input. A label from it is treated like a PR title (control characters out, cut to 40). The log's email, local paths and SHAs are dropped when it is parsed.
- Its only side effect outside the pane is `gh pr view`, run with an argument array (never through a shell) on a PR URL validated as `https://github.com/<owner>/<repo>/pull/<number>`.
- No other network access.
- State is kept in Claude Code's own plugin storage: PR URLs, titles and counts, the Codex run rows (label, times, token counts) and the numbers above, plus the plan limit you typed.

## Developing it

`hooks/register.tsx` is the mod, `hooks/meter.test.tsx` its tests, `types/index.d.ts` the data contract. Run the tests with `claude plugin test plugins/meter`. Claude Code writes editor typings into `.claude-plugin/types/` when it loads a mod from a folder; that folder is git-ignored and generated, so it is not in this repo and you don't need it to run the tests.

MIT, like the rest of the repo.
