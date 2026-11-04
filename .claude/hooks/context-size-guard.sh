#!/bin/bash
# context-size-guard — PostToolUse hook: when the main session's context gets
# big, tell the user, so they can /compact or start a fresh session.
#
# Every call re-reads the whole conversation, so the size of the context is
# the cost of every step. The size is the last main-thread reply's prompt as
# the API counted it (input + cache read + cache creation), read from the
# transcript's tail. Two levels, each reminded once per session:
#   CONTEXT_WARN_1 (default 350000): mention it in one line.
#   CONTEXT_WARN_2 (default 500000): recommend /compact or a fresh session now.
# Dropping back under the first level (after a compaction) re-arms both.
# Warn-only: never blocks. Always exits 0. Needs jq; without it, does nothing.

command -v jq >/dev/null 2>&1 || exit 0

W1=${CONTEXT_WARN_1:-350000}
W2=${CONTEXT_WARN_2:-500000}

input=$(cat)
j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

sid=$(j .session_id)
tp=$(j .transcript_path)
[ -n "$sid" ] && [ -n "$tp" ] && [ -f "$tp" ] || exit 0
case "$sid" in *[!A-Za-z0-9_-]*) exit 0 ;; esac   # used in a path: keep it plain
# Sub-agents run in their own short conversations; this is about the main one.
[ -n "$(j .agent_id)" ] && exit 0

# The tail is enough: the newest assistant reply is near the end. A cut
# first line is skipped by fromjson?.
tokens=$(tail -c 2000000 "$tp" | jq -Rr '
  fromjson? | select(.type == "assistant" and (.isSidechain | not))
  | .message.usage // empty
  | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)
  | select(. > 0)
' 2>/dev/null | tail -1)
[ -n "$tokens" ] || exit 0

# Per-user state folder, not readable or writable by other users.
umask 077
base="${TMPDIR:-/tmp}/claude-context-size-$(id -u)"
mkdir -p -m 700 "$base" 2>/dev/null || exit 0
[ -O "$base" ] || exit 0
dir="$base/$sid"
if [ "$tokens" -lt "$W1" ]; then
  rm -rf "$dir"
  exit 0
fi
mkdir -p "$dir"
done_level=$(cat "$dir/level" 2>/dev/null || echo 0)
k=$((tokens / 1000))

if [ "$tokens" -ge "$W2" ] && [ "$done_level" -lt 2 ]; then
  echo 2 >"$dir/level"
  msg="[context-size-guard] Context is ~${k}k tokens. Recommend to the user now that they /compact or start a fresh session (every step re-reads all of it). Save the task's notes first."
elif [ "$tokens" -lt "$W2" ] && [ "$done_level" -lt 1 ]; then
  echo 1 >"$dir/level"
  msg="[context-size-guard] Context is ~${k}k tokens. Tell the user in one line at the top of your reply; they decide: carry on, /compact, or start a fresh session."
else
  exit 0
fi

jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
