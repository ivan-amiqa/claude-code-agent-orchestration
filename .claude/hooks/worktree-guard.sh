#!/bin/bash
# PreToolUse guard (Bash matcher): before a state-changing git/gh command runs,
# print which repo/worktree and branch it will hit, so wrong-worktree drift is
# caught before the damage (two sessions sharing one checkout once put a commit
# on the wrong branch and auto-closed a PR).
# Silent for everything else: read-only commands add zero noise. Warn-only,
# never blocks (always exits 0).

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

if ! printf '%s' "$cmd" | grep -qE '(^|[;&|(]\s*)(git\s+(commit|push|merge|rebase|cherry-pick|switch|checkout|reset|branch|worktree|am|revert)|gh\s+pr\s+(create|merge|close|edit))'; then
  exit 0
fi

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd=$(pwd)
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "NOT-A-REPO")
br=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-")

note=""
if printf '%s' "$cmd" | grep -qE '(^|[;&|(]\s*)cd\s'; then
  note=" (command cd's on its own — the guard shows the PRE-cd location; check the cd target)"
fi

msg="[worktree-guard] repo=$top branch=$br — confirm intended worktree/branch before this state-changing git command$note"
# additionalContext reaches the model; plain stdout on PreToolUse only shows in the transcript view.
jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || echo "$msg"
exit 0
