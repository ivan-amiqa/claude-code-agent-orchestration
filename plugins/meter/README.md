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
| **Session cost** | Dollars so far, at list price |
| **Context** | How many tokens every call re-reads, with the 350k and 500k marks |
| **Cache** | A countdown to the prompt cache going cold (5 minute or 1 hour), reset on every call |
| **Who did the work** | Cost and tokens written, split into Opus (main), Haiku, Sonnet and Opus (checks), plus one row per agent type and model (runs added up): runs, tokens read and written, cost, running or done, most expensive first |
| **GitHub** | The PRs this session opened, viewed or merged, with their state and check results |
| **Dollars per step** | A column chart of main-conversation steps, each split into what was re-read from cache, what was newly stored, and the model's answer, with a mark where you ran `/compact` |
| **Guard** | A line for every agent the mod blocked or switched |

The status line under the prompt carries the same headline: context size, cache state, cost, agents.

`/meter` also prints a one-line summary into the chat (session cost, context, cache, agents, CI).

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
- **Zero model tokens.** It never calls a model, registers no tool, and adds nothing to prompts or tool results. The only text it reads from a command or result is GitHub PR URLs.

## Security

- It reads session numbers (cost, context, token usage) and agent names. Agent names and PR titles are stripped of control characters and length-capped before they are drawn.
- Its only side effect outside the pane is `gh pr view`, run with an argument array (never through a shell) on a PR URL validated as `https://github.com/<owner>/<repo>/pull/<number>`.
- No other network access.
- State is kept in Claude Code's own plugin storage: PR URLs, titles and counts, and the numbers above.

## Developing it

`hooks/register.tsx` is the mod, `hooks/meter.test.tsx` its tests, `types/index.d.ts` the data contract. Run the tests with `claude plugin test plugins/meter`. Claude Code writes editor typings into `.claude-plugin/types/` when it loads a mod from a folder; that folder is git-ignored and generated, so it is not in this repo and you don't need it to run the tests.

MIT, like the rest of the repo.
