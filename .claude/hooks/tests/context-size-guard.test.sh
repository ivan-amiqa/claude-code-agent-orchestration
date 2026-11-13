#!/bin/bash
# Tests for context-size-guard.sh, goal-inject.sh, secret-guard.sh and the session deny rules in settings.json,
# with fake hook inputs and a temp TMPDIR. Needs bash and jq.
# Run: bash .claude/hooks/tests/context-size-guard.test.sh
H="$(cd "$(dirname "$0")/.." && pwd)"
S="$H/../settings.json"
T=$(mktemp -d); export TMPDIR="$T"; trap 'rm -rf "$T"' EXIT
fail=0; n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then :; else fail=$((fail+1)); echo "FAIL: $1 (expected $2, got $3)"; fi; }

# The knobs from the developer's own shell must not change the results.
unset CONTEXT_WARN_1 CONTEXT_WARN_2 GOAL_INJECT_GLOB CLAUDE_PROJECT_DIR

# context-size-guard: token count = input + cache read + cache creation of the last main-thread assistant reply
ctx() { f="$T/ctx.jsonl"; echo "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":$1}}}" > "$f"; jq -nc --arg tp "$f" --arg s "$2" '{session_id:$s,transcript_path:$tp}' | bash "$H/context-size-guard.sh"; }
txt() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty'; }
# "hand off" may only appear as the prohibition "Do not start or hand off a session yourself"
nohand() { printf '%s' "$1" | sed 's/Do not start or hand off a session yourself//' | grep -ci 'hand.\?off'; }

ok "ctx 300k silent" "" "$(ctx 300000 c1)"
o=$(txt "$(ctx 360000 c1)")
ok "ctx 360k tells the user" 1 "$(printf '%s' "$o" | grep -c 'Tell the user in one line')"
ok "ctx 360k offers compact/fresh" 1 "$(printf '%s' "$o" | grep -c '/compact, or start a fresh session themselves')"
ok "ctx 360k forbids self hand-off" 1 "$(printf '%s' "$o" | grep -c 'Do not start or hand off a session yourself')"
ok "ctx 360k no hand-off instruction" 0 "$(nohand "$o")"
ok "ctx 360k says ~360k" 1 "$(printf '%s' "$o" | grep -c '~360k')"
ok "ctx 360k once" "" "$(ctx 360000 c1)"
o=$(txt "$(ctx 510000 c1)")
ok "ctx 510k recommends compact" 1 "$(printf '%s' "$o" | grep -c 'recommend to the user now that they /compact or start a fresh session')"
ok "ctx 510k no hand-off instruction" 0 "$(nohand "$o")"
ok "ctx 510k once" "" "$(ctx 510000 c1)"
ctx 100000 c1 >/dev/null
ok "ctx re-armed" 1 "$(txt "$(ctx 360000 c1)" | grep -c 'Tell the user in one line')"
ok "ctx subagent silent" "" "$(f="$T/sub.jsonl"; echo '{"type":"assistant","message":{"usage":{"input_tokens":600000}}}' > "$f"; jq -nc --arg tp "$f" '{session_id:"c9",transcript_path:$tp,agent_id:"a1"}' | bash "$H/context-size-guard.sh")"
# the thresholds are env knobs
ok "ctx CONTEXT_WARN_1=100000: 150k warns" 1 "$(txt "$(CONTEXT_WARN_1=100000 ctx 150000 k1)" | grep -c 'Tell the user in one line')"
ok "ctx CONTEXT_WARN_1=100000: 90k silent" "" "$(CONTEXT_WARN_1=100000 ctx 90000 k2)"
ok "ctx CONTEXT_WARN_2=200000: 250k recommends compact" 1 "$(txt "$(CONTEXT_WARN_1=100000 CONTEXT_WARN_2=200000 ctx 250000 k3)" | grep -c 'recommend to the user now')"

# state folder hardening: per-user 0700 folder, plain session ids only, symlinks refused
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
ctx 360000 c2 >/dev/null
ok "ctx state folder is per-user, mode 700" 700 "$(mode "$T/claude-context-size-$(id -u)")"
ok "ctx session folder mode 700" 700 "$(mode "$T/claude-context-size-$(id -u)/c2")"
ok "ctx no legacy shared folder" 0 "$([ -e "$T/claude-context-size" ] && echo 1 || echo 0)"
ok "ctx bad sid ../x silent" "" "$(ctx 360000 '../x')"
ok "ctx bad sid ../x wrote nothing" 0 "$([ -e "$T/x" ] && echo 1 || echo 0)"
ok "ctx empty sid silent" "" "$(ctx 360000 '')"
T3=$(mktemp -d); mkdir "$T3/elsewhere"; ln -s "$T3/elsewhere" "$T3/claude-context-size-$(id -u)"
ok "ctx symlinked folder silent" "" "$(TMPDIR="$T3" ctx 360000 c3)"
ok "ctx symlinked folder: nothing written" 0 "$(ls -A "$T3/elsewhere" | wc -l | tr -d ' ')"
rm -rf "$T3"

# goal-inject: default glob docs/threads/task-*.md, resolved under CLAUDE_PROJECT_DIR when the path is relative
P="$T/project"; mkdir -p "$P/docs/threads" "$P/notes"
THREAD="$P/docs/threads/task-x-thing.md"
printf '# T\nthe original ask\n## Agenda\nsecret agenda\n' > "$THREAD"
printf '# P\nthe plan text\n' > "$P/docs/threads/task-x-thing-plan.md"
gi() { jq -nc --arg p "$1" --arg s "$2" '{prompt:$p,session_id:$s}' | bash "$H/goal-inject.sh"; }
out=$(gi "go $THREAD" g1)
ok "inject has ask" 1 "$(printf '%s' "$out" | grep -c 'the original ask')"
ok "inject omits agenda" 0 "$(printf '%s' "$out" | grep -c 'secret agenda')"
ok "inject once per session" "" "$(gi "again $THREAD" g1)"
ok "inject no path short" "" "$(gi "hello" g3)"
out=$(CLAUDE_PROJECT_DIR="$P" gi "continue docs/threads/task-x-thing.md please" g6)
ok "inject relative path under CLAUDE_PROJECT_DIR" 1 "$(printf '%s' "$out" | grep -c 'the original ask')"
ok "inject skips -plan.md files" "" "$(gi "see $P/docs/threads/task-x-thing-plan.md" g7)"
ok "inject ignores files outside the glob" "" "$(printf '# T\nelsewhere\n' > "$P/notes/task-y.md"; gi "see $P/notes/task-y.md" g8)"
# GOAL_INJECT_GLOB: another folder, several globs
out=$(GOAL_INJECT_GLOB='notes/task-*.md' gi "see $P/notes/task-y.md" g9)
ok "GOAL_INJECT_GLOB picks another folder" 1 "$(printf '%s' "$out" | grep -c 'elsewhere')"
out=$(GOAL_INJECT_GLOB='wiki/t-*.md:notes/task-*.md' gi "see $P/notes/task-y.md" g10)
ok "GOAL_INJECT_GLOB accepts several globs" 1 "$(printf '%s' "$out" | grep -c 'elsewhere')"
LONG=$(printf 'x%.0s' $(seq 1 450))
w=$(gi "$LONG" g4)
ok "warn long brief no thread" 1 "$(printf '%s' "$w" | grep -c 'No task thread file')"
ok "warn names the glob" 1 "$(printf '%s' "$w" | grep -cF 'docs/threads/task-*.md')"
ok "warn only once" "" "$(gi "$LONG" g4)"
ok "no warn with no-task" "" "$(gi "no-task: x $LONG" g5)"
ok "goal-inject marker folder mode 700" 700 "$(mode "$T/claude-goal-inject-$(id -u)")"
ok "goal-inject bad sid silent" "" "$(gi "go $THREAD" '../x')"

# secret-guard: exit 2 blocks, 0 allows
sg() { jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$H/secret-guard.sh" >/dev/null 2>&1; echo $?; }
FAKE_KEY="sk_live_$(printf 'A%.0s' $(seq 1 24))"
ok "secret-guard blocks a literal key" 2 "$(sg "curl -H 'Authorization: $FAKE_KEY' https://example.com")"
ok "secret-guard blocks a GitHub token shape" 2 "$(sg "echo ghp_$(printf 'a%.0s' $(seq 1 30))")"
ok "secret-guard blocks a bare Keychain read" 2 "$(sg 'security find-generic-password -s my-token -w')"
ok "secret-guard allows an inline Keychain read" 0 "$(sg 'curl -H "Authorization: $(security find-generic-password -s my-token -w)" https://example.com')"
ok "secret-guard allows a Keychain read piped to pbcopy" 0 "$(sg 'security find-generic-password -s my-token -w | pbcopy')"
ok "secret-guard allows an ordinary command" 0 "$(sg 'ls -la')"

# settings.json
ok "settings valid json" 0 "$(jq . "$S" >/dev/null 2>&1; echo $?)"
ok "deny start_session" true "$(jq '.permissions.deny | index("mcp__ccd_session__start_session") != null' "$S")"
ok "deny hand_off_to_session" true "$(jq '.permissions.deny | index("mcp__ccd_session__hand_off_to_session") != null' "$S")"
ok "deny git push" true "$(jq '.permissions.deny | index("Bash(git push:*)") != null' "$S")"
ok "no write-capable gh command is pre-allowed" 0 "$(jq -r '.permissions.allow[]' "$S" | grep -cE 'gh (pr (create|merge|edit|close)|run rerun)')"
ok "goal-inject wired" 1 "$(grep -c 'goal-inject.sh' "$S")"
ok "secret-guard wired" 1 "$(grep -c 'secret-guard.sh' "$S")"
ok "context-size-guard wired" 1 "$(grep -c 'context-size-guard.sh' "$S")"
ok "every wired hook script exists" 0 "$(jq -r '.. | objects | .command? // empty' "$S" | grep -oE '[A-Za-z-]+\.sh' | while read -r f; do [ -f "$H/$f" ] || echo missing; done | wc -l | tr -d ' ')"

echo "$((n-fail))/$n passed"; [ "$fail" -eq 0 ]
