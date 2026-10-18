#!/bin/bash
# PreToolUse guard that nudges the main session to delegate (see the "Delegation"
# section of CLAUDE.md.example). Wired in .claude/settings.json with the matcher
# Bash|Read|Grep|Glob|Agent|Edit|Write|NotebookEdit.
#
# Per session it tracks:
#   reads    - code-reading calls in the main session since the last scout/log-digger call
#   edits    - code edits in the main session since the last implementer call
#   reviewed - PR numbers a pr-reviewer was started on, with no code edit since ("any" if no number)
#   verify   - a verifier start with no code edit since
#
# Reminds (never blocks) for scout/log-digger, implementer and verifier.
# BLOCKS a PR merge (`gh pr merge`, `gh api .../pulls/N/merge`, including
# `gh pr merge --auto`) unless pr-reviewer was started on that PR after the last
# code edit, or the command carries an escape hatch:
#     gh pr merge 123 ...  # reviewed-by: teammate review in PR comments
# The hook only knows the reviewer was STARTED, not what it concluded: read the
# verdict before you merge. Always exits 0 (a block is a "deny" JSON, not an error),
# except the jq-missing fallback below, which refuses merges with exit 2.
#
# Configuration (environment variables, all optional):
#   DELEGATION_GUARD_READ_LIMIT   code-reading calls before the scout reminder   (default 6)
#   DELEGATION_GUARD_EDIT_LIMIT   code edits before the implementer reminder     (default 4)
#   DELEGATION_GUARD_IGNORE_GLOB  colon-separated path globs that are NOT code:
#                                 reads/edits there never count towards the limits.
#                                 Default: docs/*:*/docs/*:memory/*:*/memory/*
#                                 (your docs and notes folders). Add your own, e.g.
#                                 DELEGATION_GUARD_IGNORE_GLOB='docs/*:*/docs/*:*/wiki/*'
#   TMPDIR                        where per-session counters live (default /tmp)
# To turn the guard off: remove its entry from .claude/settings.json.

READ_LIMIT="${DELEGATION_GUARD_READ_LIMIT:-6}"
EDIT_LIMIT="${DELEGATION_GUARD_EDIT_LIMIT:-4}"
IGNORE_GLOB="${DELEGATION_GUARD_IGNORE_GLOB:-docs/*:*/docs/*:memory/*:*/memory/*}"
CODE_EXT='ts|tsx|js|jsx|mjs|cjs|py|sql|sh|json|ya?ml|css|scss|html|tf|hcl|go|rb'
# Redirect targets: source only (json/yaml dumps of command output are not code edits).
SRC_EXT='ts|tsx|js|jsx|mjs|cjs|py|sql|sh|css|scss|html|tf|hcl|go|rb'

input=$(cat)
if ! command -v jq >/dev/null 2>&1; then
  # Can't parse; still refuse anything that looks like a merge (exit 2 = block, stderr reaches the model).
  if printf '%s' "$input" | grep -qE 'pr[[:space:]]+merge|pulls/[0-9]+/merge'; then
    echo "[delegation-guard] jq is not installed, so the review check cannot run and this merge is blocked. Install jq (brew install jq) or merge from the GitHub UI." >&2
    exit 2
  fi
  echo "[delegation-guard] jq not found: delegation checks are OFF" >&2
  exit 0
fi
j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

sid=$(j .session_id); [ -z "$sid" ] && exit 0
tool=$(j .tool_name)
in_subagent=$([ -n "$(j .agent_id)" ] && echo 1)
dir="${TMPDIR:-/tmp}/claude-delegation/$sid"; mkdir -p "$dir"
get() { cat "$dir/$1" 2>/dev/null || echo 0; }
put() { echo "$2" > "$dir/$1"; }
msgs=()

# True if the path matches one of the ignore globs (colon-separated, see header).
ignored_path() {
  local pat
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$1" in $pat) return 0 ;; esac
  done <<< "$(printf '%s' "$IGNORE_GLOB" | tr ':' '\n')"
  return 1
}
# True if any word of a command segment is an ignored path (e.g. `cat docs/INDEX.md`).
segment_touches_ignored() {
  local w rc=1
  set -f
  for w in $1; do ignored_path "$w" && { rc=0; break; }; done
  set +f
  return $rc
}
# A path counts as code unless it is in an ignored folder, scratch, Claude config or markdown.
is_code() {
  case "$1" in
    ""|*.md|/tmp/*|/private/tmp/*|"$HOME"/.claude/*) return 1 ;;
  esac
  ignored_path "$1" && return 1
  return 0
}
# Command segments (split on ; & |), with leading `cd X`, `VAR=val` and paths stripped from the program.
segments() {
  printf '%s\n' "$1" | tr ';&|' '\n\n\n' | sed -E 's/^[[:space:]]*//; s/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//'
}
prog() { printf '%s' "$1" | awk '{print $1}' | sed 's#.*/##'; }
touches_code_file() { printf '%s' "$1" | grep -qE "\.($CODE_EXT)([[:space:]\"']|$)"; }

deny() {
  jq -nc --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

cmd=""; code_edit=""; is_read=""
case "$tool" in
  Edit|Write|NotebookEdit)
    is_code "$(j .tool_input.file_path)$(j .tool_input.notebook_path)" && code_edit=1 ;;
  Read|Grep|Glob)
    p="$(j .tool_input.file_path)$(j .tool_input.path)"
    { [ -z "$p" ] || is_code "$p"; } && is_read=1 ;;
  Bash)
    # Drop heredoc bodies (commit messages, file contents) and quoted strings before
    # looking at the command, so text *about* a command is never taken for the command.
    cmd=$(j .tool_input.command | awk -v q="'" '
      d != "" { if ($0 == d) d = ""; next }
      { print
        if (match($0, "<<-?[ \t]*[\"" q "]?[A-Za-z_][A-Za-z0-9_]*")) {
          t = substr($0, RSTART, RLENGTH); gsub("<<-?[ \t]*[\"" q "]?", "", t); d = t } }')
    hatchsrc="$cmd"
    cmd=$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")
    while IFS= read -r seg; do
      [ -z "$seg" ] && continue
      case "$(prog "$seg")" in
        sed)  printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*i|--in-place)([[:space:]]|$)' && touches_code_file "$seg" && code_edit=1 ;;
        perl) printf '%s' "$seg" | grep -qE '(^|[[:space:]])-[a-zA-Z]*i([[:space:]]|$)' && touches_code_file "$seg" && code_edit=1 ;;
        tee)  for t in $(printf '%s' "$seg" | awk '{for(i=2;i<=NF;i++) if ($i !~ /^-/) print $i}'); do
                printf '%s' "$t" | grep -qE "\.($SRC_EXT)$" && is_code "$t" && code_edit=1
              done ;;
        cd) ;;
        cat|head|tail|grep|rg|find|ls|awk|wc|less|tree)
          segment_touches_ignored "$seg" || is_read=1 ;;
        npx|npm|pnpm|yarn|jest|vitest|pytest)
          printf '%s' "$seg" | grep -qE '(vitest|jest|pytest|(npm|pnpm|yarn)( run)? test)' && is_read=1 ;;
      esac
      # Redirect into a code file in a repo (cat > x.ts <<EOF, echo >> y.py), not into scratch or memory.
      for t in $(printf '%s' "$seg" | grep -oE "(^|[[:space:]0-9])>>?[[:space:]]*[^[:space:]>&]+" | sed -E 's/^[[:space:]0-9]*>>?[[:space:]]*//'); do
        printf '%s' "$t" | grep -qE "\.($SRC_EXT)$" && is_code "$t" && code_edit=1
      done
    done <<< "$(segments "$cmd")"
    [ -n "$code_edit" ] && is_read="" ;;
esac

# Any code edit, even inside implementer, makes an earlier review/verification stale.
if [ -n "$code_edit" ]; then
  put reviewed ""; put verify 0
  [ -z "$in_subagent" ] && put edits $(( $(get edits) + 1 ))
fi

# PR numbers a reviewer prompt names: pull/N, pulls/N, a standalone #N, PR N. Not tracker-style ids like ABC#121.
pr_numbers() { printf '%s' "$1" | grep -oE '(pull/|pulls/|(^|[^[:alnum:]_-])#|PR[[:space:]]*#?)[0-9]+' | grep -oE '[0-9]+$' | sort -u; }
# The PR a merge targets: first bare number or pull URL after `pr merge`, or pulls/N/merge.
merge_target() {
  printf '%s' "$1" | grep -oE 'pulls/[0-9]+/merge' | grep -oE '[0-9]+' | head -1
  printf '%s' "$1" | grep -oE 'pr[[:space:]]+merge([[:space:]]+[^;&|]*)?' | head -1 | tr ' ' '\n' \
    | grep -E '^([0-9]+|.*/pull/[0-9]+)$' | grep -oE '[0-9]+$' | head -1
}

merge_gate() {   # $1 = text naming the PR (the command), $2 = text that may carry the hatch
  hatch=$(printf '%s' "$2" | grep -oE '#[[:space:]]*reviewed-by:[[:space:]]*[^[:space:]].{7,}' | head -1)
  [ -n "$hatch" ] && return 0
  rev=$(cat "$dir/reviewed" 2>/dev/null)
  [ -z "$rev" ] && deny "[delegation-guard] Merge blocked: pr-reviewer has not been run in this session since the last code change (CLAUDE.md: before merging -> pr-reviewer). Run the pr-reviewer agent on this PR first. If it was reviewed elsewhere, or you are merging your own work without review as CLAUDE.md allows, re-run with a trailing comment saying so, e.g.  gh pr merge 123 ...  # reviewed-by: teammate review in PR comments   or   # reviewed-by: self, confident because <reason>"
  want=$(merge_target "$1" | head -1)
  [ -z "$want" ] && return 0
  printf '%s\n' "$rev" | grep -qx any && return 0
  for n in $want; do printf '%s\n' "$rev" | grep -qx "$n" && return 0; done
  deny "[delegation-guard] Merge blocked: pr-reviewer in this session reviewed PR $(printf '%s' "$rev" | tr '\n' ' ') but not PR $(printf '%s' "$want" | tr '\n' ' '). Run pr-reviewer on this PR, or add  # reviewed-by: <which review>  to the command."
}

case "$tool" in
  Agent)
    prompt="$(j .tool_input.prompt) $(j .tool_input.description)"
    case "$(j .tool_input.subagent_type)" in
      scout|log-digger) put reads 0 ;;
      implementer)      put edits 0 ;;
      verifier)         put verify 1 ;;
      pr-reviewer)
        nums=$(pr_numbers "$prompt"); [ -z "$nums" ] && nums=any
        { cat "$dir/reviewed" 2>/dev/null; printf '%s\n' "$nums"; } | grep -v '^$' | sort -u > "$dir/reviewed.tmp" && mv "$dir/reviewed.tmp" "$dir/reviewed" ;;
    esac
    exit 0 ;;
  Bash)
    if printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])gh([[:space:]][^;&|]*)?[[:space:]]pr[[:space:]]+merge|pulls/[0-9]+/merge'; then
      merge_gate "$cmd" "$hatchsrc"
    fi
    if printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])gh([[:space:]][^;&|]*)?[[:space:]]pr[[:space:]]+(create|merge)' && [ "$(get verify)" != 1 ] && [ -z "$in_subagent" ]; then
      msgs+=("[delegation-guard] No verifier run since the last code change. CLAUDE.md: before declaring done -> verifier (fresh context, can contradict you). Run it before you report this as done.")
    fi ;;
esac

[ -n "$in_subagent" ] && exit 0   # subagents do the reading/editing; that's the point

if [ -n "$code_edit" ] && [ "$(get edits)" -ge "$EDIT_LIMIT" ]; then
  put edits 0
  msgs+=("[delegation-guard] $EDIT_LIMIT code edits in this session since the last implementer call. CLAUDE.md: once the plan is decided, hand the writing to the implementer agent (Sonnet) with the spec, files and acceptance criteria. Small one-off fixes are fine here.")
fi

if [ -n "$is_read" ]; then
  n=$(( $(get reads) + 1 ))
  if [ "$n" -ge "$READ_LIMIT" ]; then
    put reads 0
    msgs+=("[delegation-guard] $n code-reading calls in this session since the last scout/log-digger call. CLAUDE.md: code reading and tracing -> scout; test runs and long output -> log-digger; only one known file at a time here. Finish this call, then delegate the next reading step.")
  else
    put reads "$n"
  fi
fi

if [ ${#msgs[@]} -gt 0 ]; then
  jq -nc --arg m "$(printf '%s\n' "${msgs[@]}")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}'
fi
exit 0
