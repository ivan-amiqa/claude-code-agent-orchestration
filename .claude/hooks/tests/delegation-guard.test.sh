#!/bin/bash
# Tests for delegation-guard.sh: the merge gate (allowlist grammar, reviewed-by hatch, pr-reviewer check, bounded
# `gh pr view` lookup, fail-closed paths, per-user state folder) and the reminders, with fake hook inputs,
# a stub `gh` on PATH and a temp TMPDIR. Needs bash, jq, python3 and perl.
# Run: /bin/bash .claude/hooks/tests/delegation-guard.test.sh
H="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); export TMPDIR="$T"; trap 'rm -rf "$T"' EXIT
fail=0; n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then :; else fail=$((fail+1)); echo "FAIL: $1 (expected $2, got $3)"; fi; }

# Make sure the knobs from the developer's own shell cannot change the results.
unset DELEGATION_GUARD_READ_LIMIT DELEGATION_GUARD_EDIT_LIMIT DELEGATION_GUARD_IGNORE_GLOB

mkdir -p "$T/bin" "$T/work/sub"
export STUB_LOG="$T/gh.log"; export DELEGATION_GUARD_GH_TIMEOUT=1 DELEGATION_GUARD_DEADLINE=3
# A unique sleep length, so the "no stray process" check below counts only this run's own sleeps.
export STUB_SLEEP="5.$RANDOM$RANDOM"
cat > "$T/bin/gh" <<'STUB'
#!/bin/bash
echo "$PWD|$*|GH_REPO=$GH_REPO" >> "$STUB_LOG"
num="${STUB_NUM:-970}"; for a in "$@"; do case "$a" in *[!0-9]*|"") ;; *) num="$a" ;; esac; done
for a in "$@"; do case "$a" in */pull/*) num="${a##*/pull/}"; num="${num%%/*}" ;; esac; done
case "${STUB_MODE:-ok}" in
  ok) printf '{"headRefOid":"%s","number":%s}\n' "$STUB_SHA" "$num" ;;
  fail) echo "boom" >&2; exit 1 ;;
  garbage) echo "not json" ;;
  shortsha) printf '{"headRefOid":"abc123","number":%s}\n' "$num" ;;
  sleep) trap "" ALRM; sleep "$STUB_SLEEP" ;;   # ignores SIGALRM like Go, and has a child: only a KILL of the group stops it
esac
STUB
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

A=$(printf 'a%.0s' $(seq 1 40)); B=$(printf 'b%.0s' $(seq 1 40))
export STUB_SHA="$A" STUB_MODE=ok

hook() { # <session> <json tool_input> <tool> [cwd]
  jq -nc --arg s "$1" --arg t "$3" --arg c "${4:-$T/work}" --argjson i "$2" '{session_id:$s,tool_name:$t,tool_input:$i,cwd:$c}' | /bin/bash "$H/delegation-guard.sh"
}
bash_cmd() { hook "$1" "$(jq -nc --arg c "$2" '{command:$c}')" Bash "$3"; }
denied() { printf '%s' "$1" | grep -c '"permissionDecision":"deny"'; }
reason() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty'; }
calls() { [ -f "$STUB_LOG" ] && wc -l < "$STUB_LOG" | tr -d ' ' || echo 0; }
reset() { rm -f "$STUB_LOG"; }
lastcall() { tail -1 "$STUB_LOG"; }
V="--json headRefOid,number"
quick() { local s0 s1; s0=$(date +%s); "$@" >/dev/null 2>&1; s1=$(date +%s); [ $((s1-s0)) -lt 5 ] && echo 1 || echo 0; }

# session r: pr-reviewer on 970 7 5 9 2 123 ; session w: only PR 7 ; session u: none
hook r '{"subagent_type":"pr-reviewer","prompt":"Review PR #970, PR #7, PR #5, PR #9, PR #2 and PR #123"}' Agent >/dev/null
hook w '{"subagent_type":"pr-reviewer","prompt":"Review PR #7"}' Agent >/dev/null
M="gh pr merge 970 --squash --delete-branch"
MB="gh pr merge feat/x --squash"          # a branch target: the PR number has to come from the gh lookup

# ---------------------------------------------------------------- shapes that PASS
# When the command names the PR (number, URL, gh api endpoint) the guard needs no gh call at all.
pass() { # <name> <command> [expected gh call, or NOCALL]
  reset; o=$(bash_cmd r "$2"); ok "PASS: $1" 0 "$(denied "$o")"
  if [ "$3" = NOCALL ]; then ok "PASS no gh call: $1" 0 "$(calls)"
  elif [ -n "$3" ]; then ok "PASS args: $1" "$3" "$(lastcall)"; fi
}
pass "plain merge" "$M" NOCALL
pass "cd && merge 2>&1 | tail" "cd $T/work/sub && gh pr merge 970 -sd 2>&1 | tail -5" NOCALL
pass "URL target" "gh pr merge https://github.com/O/R/pull/970 --squash" NOCALL
pass "branch target, no repo" "$MB" "$T/work|pr view feat/x $V|GH_REPO="
pass "-R O/R" "gh pr merge -R O/R feat/x --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
pass "-R=O/R" "gh -R=O/R pr merge feat/x --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
pass "-RO/R" "gh pr merge feat/x -RO/R --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
pass "--repo=O/R" "gh pr merge feat/x --repo=O/R --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
pass "--repo O/R after merge" "gh pr merge feat/x --repo O/R --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
pass "GH_REPO prefix" "GH_REPO=O/R gh pr merge feat/x --squash" "$T/work|pr view feat/x --repo O/R $V|GH_REPO="
reset; o=$(GH_REPO=X/Y bash_cmd r "$MB"); ok "PASS: inherited GH_REPO is used as it is" 0 "$(denied "$o")"
ok "inherited GH_REPO reaches gh, no --repo added" "$T/work|pr view feat/x $V|GH_REPO=X/Y" "$(lastcall)"
reset; o=$(GH_REPO=X/Y bash_cmd r "gh pr merge feat/x -R O/R --squash"); ok "flag beats inherited GH_REPO" "$T/work|pr view feat/x --repo O/R $V|GH_REPO=X/Y" "$(lastcall)"
pass "gh api merge" "gh api -X PUT repos/O/R/pulls/7/merge -f merge_method=squash" NOCALL
pass "gh api flags after endpoint" "gh api repos/O/R/pulls/7/merge --method=PUT -F sha=$A -H 'Accept: x'" NOCALL
pass "gh api -XPUT /repos" "gh api -XPUT /repos/O/R/pulls/7/merge --field merge_method=squash" NOCALL
pass "checks; merge; view; checkout && pull" "gh pr checks 970; gh pr merge 970 --squash; gh pr view 970 --json state; git checkout main && git pull"
pass "--auto" "gh pr merge 970 --auto --squash"
pass "--body with ; in quotes" "gh pr merge 970 --squash --body 'literal ; text'"
pass "--body with && | in double quotes" "gh pr merge 970 --squash --body \"a && b | c\""
pass "two-line continuation" $'gh pr merge 970 --squash \\\n  --delete-branch'
pass "combined -sdb 7 then target" "gh pr merge -sdb 7 970"
pass "optional --match-head-commit is accepted" "gh pr merge 970 --squash --match-head-commit $A" NOCALL
pass "--match-head-commit=SHA form" "gh pr merge 970 --squash --match-head-commit=$A"
pass "no target (current branch)" "gh pr merge --squash" "$T/work|pr view $V|GH_REPO="
pass "echo and sleep around it" "echo start; sleep 2; $M; echo done"
pass "git fetch/status/log before, git branch after" "git fetch origin && git status && git log -1; $M; git branch -d x"
pass "quoted literal program word" "gh \"pr\" \"merge\" 970 --squash"
pass "quoted api endpoint" "gh api \"repos/O/R/pulls/7/merge\" -X PUT -f merge_method=squash"
pass "pipe into grep and jq" "$M 2>&1 | grep -v x | jq ."
pass ">/dev/null and 2>/dev/null" "gh pr checks 970 >/dev/null; $M 2>/dev/null"

# set_auto_merge
reset; o=$(hook r '{"enabled":true,"url":"https://github.com/O/R/pull/970","merge_method":"squash"}' mcp__ccd_pr__set_auto_merge); ok "PASS: set_auto_merge with url (reviewed PR)" 0 "$(denied "$o")"; ok "set_auto_merge url: number known, no gh call" 0 "$(calls)"
reset; o=$(hook w '{"enabled":true,"url":"https://github.com/O/R/pull/970","merge_method":"squash"}' mcp__ccd_pr__set_auto_merge); ok "set_auto_merge for a PR that was not reviewed denied" 1 "$(denied "$o")"; ok "set_auto_merge: message names the PR" 1 "$(reason "$o" | grep -c 'but not PR 970')"
reset; o=$(hook u '{"enabled":false}' mcp__ccd_pr__set_auto_merge); ok "set_auto_merge disabled untouched" 0 "$(denied "$o")"; ok "set_auto_merge disabled: gh not called" 0 "$(calls)"
reset; o=$(hook u '{"enabled":true,"url":"https://github.com/O/R/pull/970"}' mcp__ccd_pr__set_auto_merge); ok "set_auto_merge no reviewer denied" 1 "$(denied "$o")"; ok "set_auto_merge no reviewer: gh not called" 0 "$(calls)"
reset; hook r '{"enabled":true}' mcp__ccd_pr__set_auto_merge >/dev/null; ok "set_auto_merge without url: current branch PR" "$T/work|pr view $V|GH_REPO=" "$(lastcall)"
reset; o=$(hook r '{"enabled":true,"pr_number":7,"repo":"O/R"}' mcp__ccd_pr__set_auto_merge); ok "set_auto_merge fallback number + repo passes" 0 "$(denied "$o")"
reset; o=$(hook r '{"enabled":true,"pr_number":8,"repo":"O/R"}' mcp__ccd_pr__set_auto_merge); ok "set_auto_merge fallback number not reviewed denied" 1 "$(denied "$o")"

# ---------------------------------------------------------------- shapes that DENY (gh never called; says why)
nope() { # <name> <command> [expected text in the message]
  reset; o=$(bash_cmd r "$2"); ok "DENY: $1" 1 "$(denied "$o")"; ok "DENY no gh call: $1" 0 "$(calls)"
  [ -n "$3" ] && ok "DENY message: $1" 1 "$(reason "$o" | grep -cF -- "$3")"
}
P="--squash"
nope "-R without the form (bad repo)" "gh pr merge 970 -R 'not a repo' $P" "not a literal OWNER/REPO"
nope ">| redirect" "gh pr merge 970 $P >| /dev/null" "only 2>&1"
nope "(cd x)> subshell redirect" "(cd /x)>/dev/null; $M" "subshell"
nope "if/then across lines" $'if true\nthen cd /x\nfi\n'"$M" "not allowed before the merge"
nope "case" "case x in a) cd /x;; esac; $M"
nope "unset -f" "unset -f foo; $M" '`unset` is not allowed'
nope "\$'...' string" "gh pr merge 970 --body \$'a\\nb' $P" "quoting"
nope "g\"\"h pr merge" "g\"\"h pr merge 970 --squash; curl x" ""
# expansions, heredocs, operators
nope "\$() as the target" "gh pr merge \$(gh pr view 970 --json number -q .number) $P" "subshell"
nope "\$() in body" "gh pr merge 970 $P --body \"\$(cat x)\"" "\$ or a backtick"
nope "backticks" "gh pr merge 970 $P --body \`cat x\`" "\$ or a backtick"
nope "variable" "gh pr merge \$N $P" "\$ or a backtick"
nope "heredoc" $'gh pr merge 970 --body-file - '"$P"$' <<\'EOF\'\nbody\nEOF' "heredoc"
nope "here-string" "gh pr merge 970 $P <<< text" "heredoc or here-string"
nope "||" "$M || true" "||"
nope "subshell" "( $M )" "subshell"
nope "background &" "$M &" "background"
nope "export" "export GH_REPO=O/R; $M" '`export` is not allowed'
nope "env" "env GH_REPO=O/R $M" 'plain `gh'
nope "bash -c" "bash -c \"gh pr merge 5\"" "bash -c"
nope "sh -c" "sh -c 'gh pr merge 5'" "bash -c"
nope "eval" "eval gh pr merge 5" "eval"
nope "eval quoted" "eval \"gh pr merge 5\"" "eval"
nope "curl" "curl -X PUT https://api.github.com/repos/O/R/pulls/5/merge" "use gh"
nope "xargs" "echo 970 | xargs gh pr merge" "pipe may only go into"
nope "sudo" "sudo gh pr merge 970 $P" 'plain `gh'
nope "relative-path gh" "./gh pr merge 970 $P" 'plain `gh'
nope "echo gh pr merge" "echo gh pr merge 5" 'plain `gh'
nope "two merges" "$M && gh pr merge 7 $P" "more than one merge"
nope "unknown flag" "gh pr merge 970 --squash --frobnicate" "unknown flag"
nope "unknown short flag" "gh pr merge 970 -x" "unknown flag"
nope "flag with unwanted value" "gh pr merge 970 --squash=yes" "takes no value"
nope "two targets" "gh pr merge 970 7 $P" "more than one PR target"
nope "glob in target" "gh pr merge 970* $P" "pattern character"
nope "brace expansion" "gh pr merge {5,7} $P" "pattern character"
nope "backslash outside quotes" "gh pr merge 970 \\--squash" "backslash"
nope "~user outside cd" "gh pr merge 970 $P --body-file ~root/x" "~"
nope "gh api placeholders" "gh api -X PUT repos/{owner}/{repo}/pulls/5/merge" "pattern character"
nope "gh api full URL" "gh api -X PUT https://api.github.com/repos/O/R/pulls/5/merge" "endpoint must be exactly"
nope "gh api POST" "gh api -X POST repos/O/R/pulls/5/merge" "PUT"
nope "gh api unknown flag" "gh api -X PUT repos/O/R/pulls/5/merge --silent" "unknown flag"
nope "gh api two sha fields" "gh api -X PUT repos/O/R/pulls/5/merge -f sha=$A -f sha=$A" "more than one sha"
nope "gh api -R" "gh api -R O/R repos/O/R/pulls/5/merge" "unknown flag"
# redirects and pipes
nope "redirect to a file" "$M > out.txt" "redirect"
nope "&> redirect" "$M &> /dev/null" "redirect"
nope "pipe into tee" "$M | tee out.txt" "pipe may only go into"
nope "pipe into sh" "$M | sh" "pipe may only go into"
nope "merge as a pipe stage" "echo 970 | gh pr merge $P" "pipe may only go into"
# neighbours
nope "rm before" "rm -rf x; $M" '`rm` is not allowed before'
nope "git push after" "$M; git push" "git command is not allowed after"
nope "git reset before" "git reset --hard; $M" "git command is not allowed before"
nope "gh pr create after" "$M; gh pr create" "gh command is not allowed after"
nope "gh pr edit before" "gh pr edit 5; $M" "gh command is not allowed before"
nope "git checkout before" "git checkout x; $M" "git command is not allowed before"
nope "cd with two args" "cd /x /y && $M" "cd takes exactly one"
nope "cd -" "cd - && $M" "cd takes exactly one"
nope "assignment before echo" "X=1 echo hi; $M" "variable assignment"
nope "two GH_REPO prefixes" "GH_REPO=O/R FOO=1 gh pr merge 970 $P" "only variable allowed"
nope "sleep with text" "sleep abc; $M" "whole number"
nope "unclosed quote with merge text" "gh pr merge 970 --body 'oops" ""
# the head pin is optional now: no pin is fine for a reviewed PR
reset; o=$(bash_cmd r "gh pr merge 970 --squash"); ok "no head pin needed" 0 "$(denied "$o")"; ok "no head pin: no gh call" 0 "$(calls)"
reset; o=$(bash_cmd r "gh api -X PUT repos/O/R/pulls/7/merge -f merge_method=squash"); ok "gh api without sha= passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd r "$M || true"); m=$(reason "$o")
ok "grammar deny: example shape" 1 "$(printf '%s' "$m" | grep -cF 'cd /x && gh pr merge 970 --squash --delete-branch 2>&1 | tail -5')"
ok "grammar deny: reviewed-by hatch" 1 "$(printf '%s' "$m" | grep -cF '# reviewed-by:')"
ok "grammar deny: no leftover references to a head pin" 0 "$(printf '%s' "$m" | grep -ciE 'match-head-commit|head sha')"
ok "all denies exit 0 with JSON" 0 "$(bash_cmd r "$M || true" >/dev/null; echo $?)"

# ---------------------------------------------------------------- hatch
HC="# reviewed-by: teammate review in PR comments"
reset; o=$(bash_cmd u "$M"); ok "no hatch, no reviewer: reviewer message" 1 "$(reason "$o" | grep -c 'pr-reviewer has not been run')"; ok "no reviewer: no gh call" 0 "$(calls)"
ok "reviewer message mentions the hatch" 1 "$(reason "$o" | grep -cF '# reviewed-by:')"
reset; o=$(bash_cmd u "$M  $HC"); ok "reviewed-by skips the reviewer check" 0 "$(denied "$o")"; ok "reviewed-by: no gh call" 0 "$(calls)"
STUB_MODE=fail; reset; o=$(bash_cmd u "$MB  $HC"); ok "reviewed-by on a branch target: gh is not needed, even a broken one" 0 "$(denied "$o")"; ok "reviewed-by on a branch target: no gh call" 0 "$(calls)"; STUB_MODE=ok
reset; o=$(bash_cmd u "curl -X PUT https://x/repos/O/R/pulls/5/merge  $HC"); ok "the hatch does NOT excuse a grammar failure" 1 "$(denied "$o")"; ok "hatch + curl: no gh call" 0 "$(calls)"
reset; o=$(bash_cmd u "$M  # reviewed-by: self ok"); ok "short hatch (under 8 chars) does not count" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "gh pr merge 970 --squash --body \"$HC\""); ok "hatch inside a quoted body does not count" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "echo \"$HC\"; $M"); ok "hatch inside an echo string does not count" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "echo hi $HC"$'\n'"$M"); ok "a comment that is not the trailing one does not count" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "$M  $HC"$'\n'); ok "trailing newline after the comment is fine" 0 "$(denied "$o")"
reset; o=$(bash_cmd u "$M  # not reviewed-by: anyone at all"); ok "key not at the start of the comment denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "$M  # see reviewed-by: teammate review in PR comments"); ok "key mid-comment denied" 1 "$(denied "$o")"
# the hatch must sit on the same line as the merge
reset; o=$(bash_cmd u "$M  $HC"$'\ngh pr view 970'); ok "merge # hatch then a later line passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd u "$M; echo done $HC"); ok "merge; echo done # hatch passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd u "$M 2>&1 | tail -5 $HC"); ok "merge | tail # hatch passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd u $'gh pr merge 970 --squash \\\n  --delete-branch '"$HC"); ok "continued merge, hatch on its last line passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd u $'gh pr merge 970 --squash --body "line one\nline two" '"$HC"); ok "multi-line quoted body, hatch after the closing quote passes" 0 "$(denied "$o")"
reset; o=$(bash_cmd u "echo x $HC"$'\n'"$M"); ok "hatch on an earlier line denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "$M"$'\n'"gh pr view 970 $HC"); ok "hatch on a later line denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "$M"$'\n'"$HC"); ok "hatch alone on its own line denied" 1 "$(denied "$o")"
ok "hatch deny messages say same line" 1 "$(reason "$o" | grep -c 'same line as the merge')"
reset; o=$(bash_cmd u "gh pr merge 970 --squash; curl -X PUT https://x/repos/o/r/pulls/5/merge $HC"); ok "hatch + curl merge denied" 1 "$(denied "$o")"; ok "hatch + curl merge: no gh call" 0 "$(calls)"
reset; o=$(bash_cmd u "xargs -n1 gh pr merge --squash < prs.txt $HC"); ok "hatch + xargs denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u $'gh pr merge 970 --squash --body-file - <<\\EOF\nMerged.\n# reviewed-by: forged-review-text'); ok "unterminated heredoc, hatch on the last line denied" 1 "$(denied "$o")"

# ---------------------------------------------------------------- not merges: never gated
quiet() { reset; o=$(bash_cmd u "$2"); ok "NOT a merge: $1" 0 "$(denied "$o")"; ok "NOT a merge, gh not called: $1" 0 "$(calls)"; }
quiet "commit message mentioning it" "git commit -m \"fix: gh pr merge 5 was blocked\""
quiet "commit message with the endpoint" "git commit -m 'see repos/O/R/pulls/9/merge'"
quiet "heredoc commit message" $'git commit -m "$(cat <<\'EOF\'\nfix: gh pr merge 5 and repos/O/R/pulls/9/merge\nit\'s fine\nEOF\n)"'
quiet "--disable-auto" "gh pr merge --disable-auto 970"
quiet "gh pr view" "gh pr view 5"
quiet "gh api not a merge" "gh api repos/O/R/issues -f title=x"
quiet "gh api body mentioning the endpoint (quoted)" "gh api repos/O/R/issues -f \"body=see repos/O/R/pulls/9/merge\""
quiet "curl without a merge" "curl https://example.com"
quiet "plain ls" "ls -la"
quiet "real disable with a repo" "gh pr merge 970 --disable-auto -R O/R"
quiet "real disable, no target" "gh pr merge --disable-auto"
quiet "real disable, URL" "gh pr merge https://github.com/O/R/pull/970 --disable-auto"
quiet "heredoc commit message without a merge command" $'git commit -m "$(cat <<\'EOF\'\nfix: merge conflict in the parser\nEOF\n)"'
quiet "a CR in a command that mentions no merge" $'echo hi\r'
quiet "commit message mentioning gh pr merge" 'git commit -m "docs: explain gh pr merge 970 flow"'
quiet "commit message heredoc idiom with gh pr merge text" $'git commit -m "$(cat <<\'EOF\'\ndocs: run gh pr merge 970 by hand\nEOF\n)"'
quiet "echo of a quoted \$VAR without merge text" 'echo "value: $X"'
quiet "heredoc idiom, tab-indented <<- terminator" $'git commit -m "$(cat <<-\'E\'\n\tfix: gh pr merge 5 by hand\n\tE\n)"'
quiet "heredoc idiom, merge text only in the body (unquoted delimiter)" $'git commit -m "$(cat <<EOF\ndocs: gh pr merge 970 flow\nEOF\n)"'
quiet "commit message with \$BRANCH" 'git commit -m "fix: gh pr merge parsing for $BRANCH"'
quiet "commit message with \${BRANCH} and \$?" 'git commit -m "fix: gh pr merge ${BRANCH} exit $?"'
# --disable-auto is a waiver only for the real, bare disable command
for c in 'gh pr merge 970 --squash --body "--disable-auto"' 'gh pr merge 970 -b --disable-auto' 'gh pr merge 970 --squash --disable-auto' \
         'gh pr merge 1 --disable-auto; gh $(true) pr merge 970' 'gh pr merge 970 --disable-auto --body x' 'xargs gh pr merge 970 --disable-auto'; do
  reset; o=$(bash_cmd u "$c"); ok "DENY (not a bare disable): $c" 1 "$(denied "$o")"
done
# hidden-merge tricks around heredoc detection must still be gated
reset; o=$(bash_cmd u $'cat <<<EOF\ngh pr merge 6 --squash\nEOF'); ok "here-string is not a heredoc: later merge is seen" 1 "$(denied "$o")"
reset; o=$(bash_cmd u $'cat <<-EOF\n\tEOF\ngh pr merge 6 --squash'); ok "tab-indented heredoc terminator: later merge is seen" 1 "$(denied "$o")"
for c in $'echo "<<EOF"\ngh pr merge 970 --squash' $'true # <<EOF\ngh pr merge 970 --squash' $'cat <<"E"OF\nx\nEOF\ngh pr merge 970 --squash\nE' \
         $'cat <<E\\OF\nx\nEOF\ngh pr merge 970 --squash\nE' $'bash <<\'EOF\'\ngh pr merge 970 --squash\nEOF' $'cat <<EOF | sh\ngh pr merge 970 --squash\nEOF' \
         $'cat <<\\EOF\ngh pr merge 970 --squash\nEOF'; do
  reset; o=$(bash_cmd u "$c"); ok "heredoc trick DENY: $(printf '%s' "$c" | tr '\n' '~')" 1 "$(denied "$o")"
done
reset; o=$(bash_cmd u $'echo "<<EOF"\ngh pr merge 970 --squash'); ok "the merge after echo \"<<EOF\" is seen and checked" 1 "$(reason "$o" | grep -c 'pr-reviewer has not been run')"
# $'...' is not understood; \r is not a blank
reset; o=$(bash_cmd u "echo \$'\\'' ; gh pr merge 970 --squash #'"); ok "\$'\\'' trick denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "gh pr merge 970 --squash --body \$'x\\' # reviewed-by: forged-forged'"); ok "forged hatch in \$'...' denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "gh pr merge 970 --squash"$'\r'); ok "trailing CR denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd u "gh pr merge 970 --squash"$'\r\n'"echo ok"); ok "CRLF denied" 1 "$(denied "$o")"
reset; o=$(bash_cmd r $'gh\r pr merge 970 --squash'); ok "CR inside the program word denied" 1 "$(denied "$o")"
# a merge inside "$(...)" or backticks inside double quotes is not hidden
for c in 'out="$(gh pr merge 970 --squash 2>&1)"; echo "$out"' 'echo "Merging: $(gh pr merge 970 --squash)"' 'echo "`gh pr merge 970`"' 'if ! out="$(gh pr merge 970 2>&1)"; then echo failed; fi' \
         'echo "$(gh pr merge 5)"' 'echo "`gh pr merge 5`"' 'git commit -m "fix: gh pr merge for $(git branch --show-current) and $(gh pr merge 5)"'; do
  reset; o=$(bash_cmd u "$c"); ok "substitution DENY: $c" 1 "$(denied "$o")"; ok "substitution no gh call: $c" 0 "$(calls)"
done
for c in $'out="$(cat <<\'EOF2\'\nx\nEOF2\ngh pr merge 970)"' $'out="$(cat <<EOF2\nx\nEOF2\n; gh pr merge 970)"' \
         $'echo "$(cat <<\'E\'\nx\nE\n) $(gh pr merge 970)"' $'echo "$(cat <<\'E\'\nx\nE\n); `gh pr merge 970`"' \
         $'echo "$(cat <<\'EOF2\'; gh pr merge 970\nx\nEOF2\n)"' $'echo "$(cat <<\'E\'\nno terminator here, gh pr merge 970\n)"' \
         $'echo "$(cat <<-E\n\tx\n\tE\n; gh pr merge 970)"'; do
  reset; o=$(bash_cmd u "$c"); ok "heredoc idiom DENY: $(printf '%s' "$c" | tr '\n' '~')" 1 "$(denied "$o")"; ok "heredoc idiom no gh call" 0 "$(calls)"
done
reset; o=$(bash_cmd u "ls # then gh pr merge 970"); ok "ls # then gh pr merge: denied (unreadable merge text)" 1 "$(denied "$o")"
nope "echo next: gh pr merge" "echo next: gh pr merge 970" 'plain `gh'

# ---------------------------------------------------------------- reviewer_check uses the parsed number
reset; o=$(bash_cmd w "gh pr merge 2>&1 5 $P"); ok "redirect first, PR 5 not reviewed -> deny" 1 "$(denied "$o")"; ok "message names PR 5" 1 "$(reason "$o" | grep -c 'but not PR 5')"
reset; o=$(bash_cmd w "gh pr merge \"5\" $P"); ok "quoted \"5\" not reviewed -> deny" 1 "$(denied "$o")"; ok "message names PR 5 (quoted)" 1 "$(reason "$o" | grep -c 'but not PR 5')"
reset; o=$(bash_cmd w "gh pr merge 2>&1 7 $P"); ok "redirect first, PR 7 reviewed -> pass" 0 "$(denied "$o")"
reset; o=$(bash_cmd w "gh pr merge https://github.com/O/R/pull/5 $P"); ok "URL PR 5 not reviewed -> deny" 1 "$(denied "$o")"; ok "URL: no gh call before the reviewer deny" 0 "$(calls)"
reset; o=$(bash_cmd w "gh pr merge feature/x $P"); ok "branch target: number comes from the lookup (970) -> deny" 1 "$(denied "$o")"; ok "branch target: lookup ran" 1 "$(calls)"; ok "message names the looked-up PR" 1 "$(reason "$o" | grep -c 'but not PR 970')"
reset; o=$(bash_cmd w "gh api -X PUT repos/O/R/pulls/5/merge"); ok "gh api PR 5 not reviewed -> deny" 1 "$(denied "$o")"
hook anyrev '{"subagent_type":"pr-reviewer","prompt":"review please"}' Agent >/dev/null
reset; o=$(bash_cmd anyrev "$M"); ok "an 'any' reviewer still passes" 0 "$(denied "$o")"

# ---------------------------------------------------------------- allowed neighbours and shapes
reset; o=$(HOME="$T/work" bash_cmd r "cd ~/sub && $MB"); ok "cd ~/sub allowed" 0 "$(denied "$o")"; ok "cd ~/sub expands to HOME" "$T/work/sub|pr view feat/x $V|GH_REPO=" "$(lastcall)"
reset; bash_cmd r "cd $T/work/sub && $MB ; cd .." >/dev/null; ok "the lookup runs in the dir at the merge, not after a later cd" "$T/work/sub|pr view feat/x $V|GH_REPO=" "$(lastcall)"
pass "--body-file ~/x" "gh pr merge 970 --squash --body-file ~/body.md"
pass "-F ~/x" "gh pr merge 970 -sF ~/body.md"
pass "git -C <path> pull after" "$M && git -C /some/repo pull"
pass "git -C <path> status/log/fetch/checkout after" "$M; git -C /some/repo status; git -C /some/repo log -1; git -C /some/repo fetch; git -C /some/repo checkout main"
pass "git merge-base after" "$M && git merge-base --is-ancestor $A origin/main"
nope "git merge-base before" "git merge-base a b; $M" "git command is not allowed before"
nope "git -C with a flag path" "$M && git -C -x pull" "git -C needs"
nope "git -C push" "$M && git -C /some/repo push" "git command is not allowed after"
pass "body with ; and && in -b, -t" "gh pr merge 970 -s -d -t \"feat(x): thing (#970)\" -b \"body; with && stuff\""
pass "api with --jq" "gh api -X PUT repos/O/R/pulls/970/merge -f merge_method=squash --jq .merged"
pass "merge then view state" "$M 2>&1 | tail -5; gh pr view 970 --json state,mergeCommit"
pass "admin merge with reviewed-by" "gh pr merge 970 --squash --delete-branch --admin --body-file /tmp/body.md $HC"
pass "gh run list/view/watch after" "$M; gh run list; gh run view 5; gh run watch 5"
pass "git worktree remove/prune after" "$M; git worktree remove ../x; git worktree prune"
pass "git -C <path> worktree remove after" "$M; git -C /some/repo worktree remove ../y"
nope "gh run before the merge" "gh run list; $M" "gh command is not allowed before"
nope "git worktree add after" "$M; git worktree add ../x" "git command is not allowed after"
nope "gh run rerun after" "$M; gh run rerun 5" "gh command is not allowed after"
pass "full gh path" "/opt/homebrew/bin/gh pr merge 970 --squash"
pass "full gh path for pr checks" "/opt/homebrew/bin/gh pr checks 970; $M"
nope "relative gh path" "./gh pr merge 970 $P" 'plain `gh'
pass "grep -v \"^\$\" in the pipe" "$M 2>&1 | grep -v \"^\$\""
pass "a lone \$ in double quotes" "gh pr merge 970 --squash --body \"costs 5\$\""
for c in 'gh pr merge 970 --body "$X"' 'gh pr merge 970 --body "${X}"' 'gh pr merge 970 --body "$(x)"' 'gh pr merge 970 --body "$1"' 'gh pr merge 970 --body "$?"' 'gh pr merge 970 --body "a`b`"'; do
  reset; o=$(bash_cmd r "$c --squash"); ok "DENY expansion in an argument: $c" 1 "$(denied "$o")"
done
reset; o=$(bash_cmd r $'gh pr merge 970 --body-file - <<EOF\nx\nEOF'); ok "heredoc deny says Write tool" 1 "$(reason "$o" | grep -c 'Write tool')"
# the lexer is linear (1 MB commands)
BIGM=$(head -c 1000000 /dev/zero | tr '\0' x)
ok "1 MB merge-ish command: lexed in time (<5s)" 1 "$(quick bash_cmd r "gh pr merge 970 --squash --body \"$BIGM\"")"
ok "1 MB command with no merge: fast (<5s)" 1 "$(quick bash_cmd r "echo $BIGM")"
ok "1 MB merge-ish command: still denied without a reviewer" 1 "$(denied "$(bash_cmd u "gh pr merge 970 --squash --body \"$BIGM\"")")"

# ---------------------------------------------------------------- lookup failures fail closed
for m in fail garbage shortsha; do STUB_MODE=$m; reset; o=$(bash_cmd r "$MB"); ok "gh $m denied" 1 "$(denied "$o")"; ok "gh $m: says fails closed" 1 "$(reason "$o" | grep -c 'fails closed')"; done
STUB_MODE=sleep; ok "gh that ignores SIGALRM is killed (<5s)" 1 "$(quick bash_cmd r "$MB")"; ok "gh hang denied" 1 "$(denied "$(bash_cmd r "$MB")")"
sleep 0.3; ok "killed gh leaves no stray sleep (this run's unique sleep length)" 0 "$(ps -axo command | grep -c "[s]leep $STUB_SLEEP")"
for gt in 0 abc -1 ""; do ok "GH_TIMEOUT='$gt' still killed (<5s)" 1 "$(DELEGATION_GUARD_GH_TIMEOUT=$gt DELEGATION_GUARD_DEADLINE=2 quick bash_cmd r "$MB")"; done
for dl in 0 abc -3; do ok "DEADLINE='$dl' still killed (<5s)" 1 "$(DELEGATION_GUARD_GH_TIMEOUT=1 DELEGATION_GUARD_DEADLINE=$dl quick bash_cmd r "$MB")"; done
STUB_MODE=ok
ls "$T"/claude-delegation-"$(id -u)"/r/headsha.* >/dev/null 2>&1; ok "no leftover headsha temp files" 1 "$?"
NOGH="$T/nogh"; mkdir -p "$NOGH"; for t in bash jq perl python3 mktemp rm cat tr grep sed mkdir dirname date wc head awk sort mv id chmod; do p=$(command -v $t) && ln -sf "$p" "$NOGH/$t"; done
reset; o=$(jq -nc --arg c "$MB" '{session_id:"r",tool_name:"Bash",tool_input:{command:$c},cwd:"/"}' | PATH="$NOGH" /bin/bash "$H/delegation-guard.sh"); ok "gh missing: branch-target merge denied" 1 "$(denied "$o")"
NOPERL="$T/noperl"; mkdir -p "$NOPERL"; for t in bash jq python3 mktemp rm cat tr grep sed mkdir dirname date wc head awk sort mv id chmod; do p=$(command -v $t) && ln -sf "$p" "$NOPERL/$t"; done
cp "$T/bin/gh" "$NOPERL/gh"
o=$(jq -nc --arg c "$MB" '{session_id:"r",tool_name:"Bash",tool_input:{command:$c},cwd:"/"}' | PATH="$NOPERL" /bin/bash "$H/delegation-guard.sh"); ok "perl missing: lookup denied" 1 "$(denied "$o")"; ok "perl missing: says so" 1 "$(reason "$o" | grep -c 'perl is not installed')"
NOPY="$T/nopy"; mkdir -p "$NOPY"; for t in bash jq perl mktemp rm cat tr grep sed mkdir dirname date wc head awk sort mv id chmod; do p=$(command -v $t) && ln -sf "$p" "$NOPY/$t"; done
cp "$T/bin/gh" "$NOPY/gh"
o=$(jq -nc --arg c "$M" '{session_id:"r",tool_name:"Bash",tool_input:{command:$c},cwd:"/"}' | PATH="$NOPY" /bin/bash "$H/delegation-guard.sh"); ok "python3 missing: merge denied" 1 "$(denied "$o")"; ok "python3 missing: says so" 1 "$(reason "$o" | grep -c 'python3 is not installed')"
NOJQ="$T/nojq"; mkdir -p "$NOJQ"; for t in bash cat grep sed tr; do p=$(command -v $t) && ln -sf "$p" "$NOJQ/$t"; done
ok "jq missing: merge blocked (exit 2)" 2 "$(jq -nc --arg c "$M" '{session_id:"r",tool_name:"Bash",tool_input:{command:$c},cwd:"/"}' | PATH="$NOJQ" /bin/bash "$H/delegation-guard.sh" >/dev/null 2>&1; echo $?)"
ok "jq missing: set_auto_merge blocked (exit 2)" 2 "$(jq -nc '{session_id:"r",tool_name:"mcp__ccd_pr__set_auto_merge",tool_input:{enabled:true,url:"https://github.com/O/R/pull/970"},cwd:"/"}' | PATH="$NOJQ" /bin/bash "$H/delegation-guard.sh" >/dev/null 2>&1; echo $?)"
ok "jq missing: other command passes (exit 0)" 0 "$(jq -nc '{session_id:"r",tool_name:"Bash",tool_input:{command:"ls"},cwd:"/"}' | PATH="$NOJQ" /bin/bash "$H/delegation-guard.sh" >/dev/null 2>&1; echo $?)"

# ---------------------------------------------------------------- the unrelated reminders still work
reset; o=$(bash_cmd u "gh pr create --title x"); ok "verifier reminder on gh pr create" 1 "$(printf '%s' "$o" | grep -c 'No verifier run')"
for i in 1 2 3 4 5 6; do o=$(hook rd '{"file_path":"/x/y.ts"}' Read); done; ok "read-count reminder after 6 reads" 1 "$(printf '%s' "$o" | grep -c 'code-reading calls')"
o=$(hook ed '{"subagent_type":"scout","prompt":"x"}' Agent); ok "agent call is silent" "" "$o"
for i in 1 2 3; do o=$(hook ee '{"file_path":"/x/y.ts"}' Edit); done; ok "3 edits: still silent" "" "$o"
o=$(hook ee '{"file_path":"/x/y.ts"}' Edit); ok "4th edit: implementer reminder" 1 "$(printf '%s' "$o" | grep -c 'code edits in this session')"
o=$(hook ef '{"file_path":"/x/y.md"}' Edit); ok "markdown edit is not code" "" "$o"
# env knobs: limits and ignore globs
for i in 1 2 3; do o=$(DELEGATION_GUARD_READ_LIMIT=3 hook rk '{"file_path":"/x/y.ts"}' Read); done; ok "READ_LIMIT=3: reminder fires on the 3rd read" 1 "$(printf '%s' "$o" | grep -c '3 code-reading calls')"
for i in 1 2 3 4 5 6; do o=$(hook ri '{"file_path":"/x/docs/guide.txt"}' Read); done; ok "default ignore glob: docs/ reads never count" "" "$o"
for i in 1 2 3 4 5 6; do o=$(hook rj '{"file_path":"/x/wiki/guide.txt"}' Read); done; ok "wiki/ reads count by default" 1 "$(printf '%s' "$o" | grep -c 'code-reading calls')"
for i in 1 2 3 4 5 6; do o=$(DELEGATION_GUARD_IGNORE_GLOB='*/wiki/*' hook rl '{"file_path":"/x/wiki/guide.txt"}' Read); done; ok "IGNORE_GLOB='*/wiki/*': wiki reads never count" "" "$o"
for i in 1 2 3 4 5 6; do o=$(bash_cmd rm "cat docs/INDEX.md"); done; ok "Bash read of an ignored path never counts" "" "$o"

# ---------------------------------------------------------------- bad session id / state folder: merges fail closed, nothing else is touched
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
UD="$T/claude-delegation-$(id -u)"
ok "state folder is per-user and mode 700" 700 "$(mode "$UD")"
ok "session subfolder is mode 700" 700 "$(mode "$UD/r")"
ok "no legacy shared claude-delegation folder" 0 "$([ -e "$T/claude-delegation" ] && echo 1 || echo 0)"
BADM="gh pr merge 970 --squash  # reviewed-by: self, confident because this is a test"
for sid in "" "../x" "a/b" 'a b' 'x$y' ".." "a.b"; do
  reset; o=$(bash_cmd "$sid" "$M"); ok "bad sid '$sid': merge denied" 1 "$(denied "$o")"; ok "bad sid '$sid': deny says session id" 1 "$(reason "$o" | grep -c 'session id')"; ok "bad sid '$sid': no gh call" 0 "$(calls)"
  o=$(bash_cmd "$sid" "$BADM"); ok "bad sid '$sid': merge with the hatch still denied" 1 "$(denied "$o")"
  o=$(bash_cmd "$sid" "gh api -X PUT repos/O/R/pulls/7/merge"); ok "bad sid '$sid': gh api merge denied" 1 "$(denied "$o")"
  o=$(bash_cmd "$sid" "ls -la"); ok "bad sid '$sid': non-merge Bash silent" "" "$o"
  o=$(bash_cmd "$sid" "git commit -m 'docs: gh pr merge flow'"); ok "bad sid '$sid': quoted merge text silent" "" "$o"
  o=$(hook "$sid" '{"file_path":"/x/y.ts"}' Read); ok "bad sid '$sid': Read silent" "" "$o"
  o=$(hook "$sid" '{"file_path":"/x/y.ts"}' Edit); ok "bad sid '$sid': Edit silent" "" "$o"
  o=$(hook "$sid" '{"subagent_type":"pr-reviewer","prompt":"Review PR #970"}' Agent); ok "bad sid '$sid': Agent silent" "" "$o"
  o=$(hook "$sid" '{"enabled":true,"url":"https://github.com/O/R/pull/970","merge_method":"squash"}' mcp__ccd_pr__set_auto_merge); ok "bad sid '$sid': set_auto_merge enable denied" 1 "$(denied "$o")"
  o=$(hook "$sid" '{"enabled":false,"url":"https://github.com/O/R/pull/970"}' mcp__ccd_pr__set_auto_merge); ok "bad sid '$sid': set_auto_merge disable passes" "" "$o"
done
ok "bad sid '../x' wrote nothing outside the state folder" 0 "$([ -e "$T/x" ] && echo 1 || echo 0)"
# unusable state folder: a symlink is refused, merges denied, nothing written through the link
T2=$(mktemp -d); export TMPDIR="$T2"; mkdir "$T2/elsewhere"; ln -s "$T2/elsewhere" "$T2/claude-delegation-$(id -u)"
reset; o=$(bash_cmd r "$M"); ok "symlinked state folder: merge denied" 1 "$(denied "$o")"; ok "symlinked state folder: no gh call" 0 "$(calls)"
o=$(bash_cmd r "ls"); ok "symlinked state folder: non-merge silent" "" "$o"
ok "symlinked state folder: nothing written through the link" 0 "$(ls -A "$T2/elsewhere" | wc -l | tr -d ' ')"
rm -rf "$T2"; export TMPDIR="$T"

# ---------------------------------------------------------------- settings
S="$H/../settings.json"
ok "settings valid json" 0 "$(jq . "$S" >/dev/null 2>&1; echo $?)"
ok "settings timeout >= 15" 1 "$(jq '[.. | objects | select(.command? // "" | test("delegation-guard.sh")) | .timeout] | .[0] >= 15 | if . then 1 else 0 end' "$S")"
ok "settings matcher gates set_auto_merge" 1 "$(jq '[.. | objects | select(.matcher? // "" | test("mcp__ccd_pr__set_auto_merge"))] | length | if . > 0 then 1 else 0 end' "$S")"

echo "delegation-guard tests: $((n-fail))/$n passed"
[ "$fail" -eq 0 ]
