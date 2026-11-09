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
| **Session cost**, **Context**, **Cache** | Three tiles in one row. Cost: dollars so far, at list price; when Codex ran in this session it is the **total** (Claude + Codex), with `Claude $10.65` and `Codex ≈$1.74 API-eq` under it. Context: how many tokens every call re-reads, with a full-width gauge under the row marking 350k and 500k. Cache: a countdown to the prompt cache going cold (5 minute or 1 hour), reset on every call, with the minutes left |
| **Limits** (under the tiles) | `Claude · 5h 62% left · week 80% left` with when each resets (`5h resets 14:00 · week resets Sun 15/11 12:20`, shortened on a narrow pane; live, from what Claude Code reports; only on a subscription), then `Codex · week 95% left` with the value you typed ([below](#the-codex-plan-limit)) and a link to the page that shows the real number. Hidden when there is nothing to show |
| **Who did the work** | A Cost bar and a Tokens written bar, split into Opus (main), Haiku, Sonnet, Opus (agents) and, when Codex ran, **Codex (GPT)** in its own colour, with one table under both: per bucket the cost and its share, the tokens written and their share. Below it one line per agent type and model (runs added up, `implementer ×2`, and `codex ×3 · GPT`): tokens read / written, cost, running or stopped, most expensive first, at most 8 |
| **GitHub** | The PRs this session opened, viewed or merged, with their state and check results |
| **Dollars per step** | A column chart of main-conversation steps, each split into what was re-read from cache, what was newly stored, and the model's answer, with a mark where you ran `/compact` |
| **Guard** | A line for every agent the mod blocked or switched; one muted line while there is nothing to report |

The status line under the prompt stays empty and only appears with a warning: context past 350k or 500k, or a cold cache while the context is large.

`/meter` also prints a one-line summary into the chat (session cost, context, cache, agents, CI). When Codex ran in this session the cost reads `Session $12.39 (Claude $10.65 + Codex ≈$1.74 API-eq)`. `/meter codex ...` keeps the Codex plan limit; see below.

## Codex

If you run a Codex review next to Claude (a script, here called `codex-review.sh`, that logs one CSV row per attempt), Meter counts what **this session's** reviews did and folds it in as one more model: Codex (GPT). For anyone without that file nothing about Codex appears.

**Which runs are this session's.** The log has no session column, so the mod ties rows to the session itself. When a Bash call (the main thread's or a sub-agent's) runs `codex-review.sh` and is not a `--classify` call, the mod notes a launch: the `--label` it was given (bare, `'single'` or `"double"` quoted, or `--label=x`) and the second it started. A log row counts when a launch of the **same label**, made at or before the row's timestamp, claims it: the latest such launch, for at most two hours. One launch can claim several rows (a plan run that failed and the API fallback it wrote); the pane counts reviews, not rows, so those two are one run (`codex · GPT`, not `×2`), while the tokens and dollars of both rows add up. The launch is read from plain commands and from `for` / `if` / `while` bodies; `bash -n` (a syntax check) is not a launch. A row nobody claimed was written by another terminal and is ignored, and so is anything before the session started. A review you start in the background counts too: rows are matched by the log's timestamp, not by when the Bash call ended. Launches are kept with the rest of the Codex data, so they survive a reload. Limits: a command that hides the call inside `bash -c "..."` or builds the label from a variable is not seen; a launch with no `--label` is not counted (the script then names it after the repository folder); and if another session reviews the **same label** at the same time, its rows can be counted here too.

**The one file it reads** is `~/.amiqa/codex-review-runs.csv` (a fixed path; `$HOME` plus that name). It is read when a session starts, once a minute (only if the file's modification time changed), and right after a Bash call whose command contains `codex-review`. A missing file just means no Codex. Claude Code refuses to read a file over 4 MiB (about 10,000 rows): past that the mod stops reading, keeps the last good rows with a muted line ("Codex log over 4 MB, rotate ~/.amiqa/codex-review-runs.csv"), and picks up again once you rotate or trim the file. The mod never reads anything under `~/.codex`, never starts a `codex` process, and never goes to the network.

**The CSV format.** A header line, then a row per attempt. Columns are found by their header name, so extra columns or a different order do not matter. These are used: `timestamp` (UTC, `2026-11-09T08:16:20Z`), `label` (e.g. `acme/web-api#12`), `auth` (`plan`, `api` or `none`), `fell_back` (`yes`/`no`), `duration_s`, `exit_code`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `skip_reason`. Fields with commas, quotes or line breaks are quoted (RFC 4180); a leading `'` that guards a spreadsheet formula is taken off. **These columns are dropped as the file is parsed and never stored, drawn or put in a reply:** `user` (an email), `repo` and `out_dir` (local paths), `head_sha`, `base_sha`. Of `skip_reason` only what is before the first `:` is kept (the script writes `reused:<folder>`), and a label that is an e-mail address or a path is cut down to `…` or its last part. The file's last 500 records are looked at.

**What it shows.**

- The **Session cost** tile becomes the total, Claude plus Codex, with the two parts under it (amounts from $1000 show as `$1.2k` in the narrow tile rather than being cut). Without a Codex run it is as before (`list price`).
- Codex's dollars are API-equivalent prices (gpt-6.1-sol list prices, `(input - cached) x $2 + cached x $0.10 + output x $10` per million tokens; a guess, always shown with ≈; on a plan run nothing was actually billed).
- **Codex (GPT)** is a bucket in the Cost bar (its dollars) and the Tokens written bar (its output tokens), with its own colour (the SVG charts use rose; the terminal uses the theme's `remember` colour, the one theme key none of the Claude buckets share, though in the dark theme it sits close to the purple of Opus (agents)) and a legend line with its share; the shares still add up to 100%.
- One agent line, `codex ×3 · GPT`: input tokens read, output tokens written, ≈ dollars, sorted with the rest.
- The Dollars-per-step chart stays Claude only.

### The Codex plan limit

Codex does not report the ChatGPT plan limit to a script, so you type what [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage) says:

```text
/meter codex 97 6d2h                          weekly: 97% left, resets in 6 days 2 hours
/meter codex 97 6d2h 5h=80 5hreset=2h10m      plus the 5-hour window
/meter codex                                  show what is stored
```

Percentages are 0 to 100; durations are `6d2h`, `2h10m`, `45m`; anything else is refused with a one-line hint. The mod stores the percentage, the reset as an absolute time and when you entered it (in the plugin's own store, key `codex-limits-1`, kept between sessions). The Limits row then says `Codex · week 97% left` with `resets Sun 15/11 12:20 · typed 3h ago` under it, and an estimate, `≈ 95.8% now (2 plan reviews since × ~0.6%)`: the number you typed minus about 0.6% for each plan review (`auth=plan`, exit code 0) that finished after you typed it. That estimate counts **every** plan review on the machine, not only this session's, because the limit belongs to the account. The 0.6% is a rough reading, not a published number; type a fresh value whenever you look at the real page. If Codex ran in this session and nothing is typed, the row says so and shows the command. Once the reset time has passed, the old percentage is not shown at all, in the pane or in the `/meter codex` answer: it says to type a new value instead, and the same for the 5-hour window.

The Claude half of the row is live: Claude Code reports how much of the 5-hour and weekly windows is used (on a subscription), and the row shows what is left. Other window kinds (such as a gateway's spend limit) are not drawn.

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
- **Zero model tokens.** It never calls a model, registers no tool, and adds nothing to prompts or tool results. The only text it reads from a command or result is GitHub PR URLs, and, in a Bash command that runs `codex-review.sh`, its `--label` word.

## Security

- It reads session numbers (cost, context, token usage) and agent names. Agent names and PR titles are stripped of control characters and length-capped before they are drawn.
- The one file it reads is `~/.amiqa/codex-review-runs.csv` (see [Codex](#codex)): a fixed path, never built from input. A label from it is treated like a PR title (control characters out, cut to 40). The log's email, local paths and SHAs are dropped when it is parsed.
- Its only side effect outside the pane is `gh pr view`, run with an argument array (never through a shell) on a PR URL validated as `https://github.com/<owner>/<repo>/pull/<number>`.
- No other network access.
- State is kept in Claude Code's own plugin storage: PR URLs, titles and counts, the Codex run rows and launches (label, times, token counts) and the numbers above, plus the plan limit you typed. No email, path or SHA is ever kept.

## Developing it

`hooks/register.tsx` is the mod, `hooks/meter.test.tsx` its tests, `types/index.d.ts` the data contract. Run the tests with `claude plugin test plugins/meter`. Claude Code writes editor typings into `.claude-plugin/types/` when it loads a mod from a folder; that folder is git-ignored and generated, so it is not in this repo and you don't need it to run the tests.

MIT, like the rest of the repo.
