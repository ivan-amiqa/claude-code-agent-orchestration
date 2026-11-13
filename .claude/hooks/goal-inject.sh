#!/bin/bash
# UserPromptSubmit hook for the "Task threads" section of CLAUDE.md.example: when a prompt names an
# existing task thread file, inject the top of that file (the original ask + acceptance criteria, up to
# the "## Agenda" heading, max 80 lines) once per session, so the goal survives compactions and new days.
# A long first prompt (>= 400 chars, i.e. a brief) that names no thread file and contains no `no-task:`
# gets one warning per session. Never blocks. Always exits 0. Needs jq; without it, does nothing.
#
# Configuration (environment variables, all optional):
#   GOAL_INJECT_GLOB   where thread files live: one path glob, or several separated by colons.
#                      Default: docs/threads/task-*.md
#                      A `*` matches within one folder name. Files ending in -plan.md are never injected.
#                      Relative paths are tried as written, then under $CLAUDE_PROJECT_DIR.
#   TMPDIR             where the once-per-session markers live (per-user folder, mode 0700)
# Thread files are yours to write: keep the ask and acceptance criteria above "## Agenda" and never rewrite them.

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }
sid=$(j .session_id); prompt=$(j .prompt)
[ -n "$sid" ] && [ -n "$prompt" ] || exit 0
case "$sid" in *[!A-Za-z0-9_-]*) exit 0 ;; esac   # used in a path: keep it plain

GLOBS="${GOAL_INJECT_GLOB:-docs/threads/task-*.md}"
# Per-user marker folder; a symlinked or foreign-owned folder is refused (the hook then does nothing).
umask 077
base="${TMPDIR:-/tmp}/claude-goal-inject-$(id -u)"
mkdir -p -m 700 "$base" 2>/dev/null || exit 0
{ [ -L "$base" ] || [ ! -d "$base" ] || [ ! -O "$base" ]; } && exit 0
dir="$base"

# Find the first existing, non-plan file in the prompt that matches one of the globs.
thread=""
while IFS= read -r g; do
  [ -z "$g" ] && continue
  # glob -> extended regex: escape the specials, then `*` = any run inside one folder name, `?` = one such char
  re=$(printf '%s' "$g" | sed -e 's/[][\.^$+(){}|\\]/\\&/g' -e 's/\*/[^\/[:space:]]*/g' -e 's/?/[^\/[:space:]]/g')
  while IFS= read -r p; do
    p="${p/#\~/$HOME}"
    if [ ! -f "$p" ] && [ -n "$CLAUDE_PROJECT_DIR" ] && [ -f "$CLAUDE_PROJECT_DIR/$p" ]; then p="$CLAUDE_PROJECT_DIR/$p"; fi
    [ -f "$p" ] || continue
    case "$p" in *-plan.md) ;; *) [ -z "$thread" ] && thread="$p" ;; esac
  done < <(printf '%s' "$prompt" | grep -oE "[^[:space:]\`\"'()<>]*$re")
done <<< "$(printf '%s' "$GLOBS" | tr ':' '\n')"

if [ -z "$thread" ]; then
  # A long first prompt (a brief, not a chat line) that names no thread file gets one warning per session.
  if [ ! -f "$dir/$sid.warned" ] && [ ! -s "$dir/$sid" ] && [ "${#prompt}" -ge 400 ] && ! printf '%s' "$prompt" | grep -q 'no-task:'; then
    : > "$dir/$sid.warned"
    msg="No task thread file was named in this brief. Before acting, find the task's thread file (it matches $GLOBS) and read its original ask and acceptance criteria; if there is none, say so to the user. (Put 'no-task:' in the prompt to silence this.)"
    jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$m}}'
  fi
  exit 0
fi

grep -qxF "$thread" "$dir/$sid" 2>/dev/null && exit 0
echo "$thread" >> "$dir/$sid"

body=$(awk '/^## Agenda/ {exit} {print}' "$thread" | head -80)
msg="Original goal of this task (from $thread), read before acting:

$body"
jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$m}}'
exit 0
