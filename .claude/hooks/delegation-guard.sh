#!/bin/bash
# PreToolUse guard that nudges the main session to delegate (see the "Delegation"
# section of CLAUDE.md.example). Wired in .claude/settings.json with the matcher
# Bash|Read|Grep|Glob|Agent|Edit|Write|NotebookEdit|mcp__ccd_pr__set_auto_merge.
#
# Per session it tracks:
#   reads    - code-reading calls in the main session since the last scout/log-digger call
#   edits    - code edits in the main session since the last implementer call
#   reviewed - PR numbers a pr-reviewer was started on, with no code edit since ("any" if no number)
#   verify   - a verifier start with no code edit since
#
# Reminds (never blocks) for scout/log-digger, implementer and verifier.
#
# BLOCKS a PR merge (gh pr merge, gh api .../pulls/N/merge, curl / bash -c / eval variants, and
# enabling auto-merge) unless pr-reviewer was started on that PR after the last code edit, or the
# command carries an escape hatch. A Bash merge must be ONE plain command that fits an allowlist
# grammar (see PY_GATE below; anything not listed is denied, so the guard fails closed). The
# desktop app's tool `mcp__ccd_pr__set_auto_merge` is gated too: no grammar, no hatch, checked
# when auto-merge is switched on (a later push is not re-checked).
#
# The hatch, only in a `#` comment outside quotes on the SAME line as the merge command (the lexer's
# newline tokens define the line: continuations are joined, quoted newlines stay in their word; a
# comment on any other line never counts), whose text STARTS with the key and has >= 8 characters
# after the colon. It is honoured only AFTER the command passed the grammar:
#     gh pr merge 123 --squash  # reviewed-by: teammate review in PR comments
# The hook only knows the reviewer was STARTED, not what it concluded: read the verdict before you merge.
#
# The PR number comes from the command when it names one; otherwise from `gh pr view [target]
# [--repo R] --json headRefOid,number`, run once and only when needed. Repo order: -R/--repo flag, the
# command's GH_REPO= prefix, the hook's own environment. gh runs under a perl wrapper that forks it
# into its own process group and, on the alarm, sends it (and its children) SIGKILL (a plain
# alarm()+exec does not stop gh: Go ignores SIGALRM). One overall deadline
# (DELEGATION_GUARD_DEADLINE seconds, default 11, max 12, under the 15 s hook timeout in settings.json)
# covers the lookup; the call gets min(DELEGATION_GUARD_GH_TIMEOUT, default 10, max 12, time left).
# A value that is not a positive integer falls back to the default.
# Fail closed: gh, python3, perl, a timeout, a command outside the grammar all deny. If jq is
# missing, a merge-looking call is refused with exit 2 (everything else is let through with a warning).
#
# THREAT MODEL: a guardrail for an honest Claude, not a security boundary. It reads what Claude
# plausibly writes and denies obscure forms (heredocs, $'..', CR, ...). Deliberate dodges are out of
# scope: python3 -c, a gh alias, a GraphQL mergePullRequest, `gh $(echo pr) merge` and similar.
#
# State lives in a per-user folder claude-delegation-<uid> (mode 0700). An empty or odd session id, or an
# unusable folder (symlink, foreign owner: a planted folder on a shared /tmp), means no state is
# written and any merge is DENIED (fail closed); everything else passes silently.
# Always exits 0 (a block is a "deny" JSON, not an error), except the jq-missing branch.
#
# Configuration (environment variables, all optional):
#   DELEGATION_GUARD_READ_LIMIT   code-reading calls before the scout reminder   (default 6)
#   DELEGATION_GUARD_EDIT_LIMIT   code edits before the implementer reminder     (default 4)
#   DELEGATION_GUARD_IGNORE_GLOB  colon-separated path globs that are NOT code:
#                                 reads/edits there never count towards the limits.
#                                 Default: docs/*:*/docs/*:memory/*:*/memory/*
#                                 (your docs and notes folders). Add your own, e.g.
#                                 DELEGATION_GUARD_IGNORE_GLOB='docs/*:*/docs/*:*/wiki/*'
#   DELEGATION_GUARD_GH_TIMEOUT   seconds for the one `gh pr view` lookup (default 10, max 12)
#   DELEGATION_GUARD_DEADLINE     overall seconds for that lookup (default 11, max 12)
#   TMPDIR                        where per-session counters live (default /tmp), in a
#                                 per-user folder claude-delegation-<uid> (mode 0700)
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
  if printf '%s' "$input" | grep -qE 'pr[[:space:]]+merge|pulls/[0-9]+/merge|set_auto_merge'; then
    echo "[delegation-guard] jq is not installed, so the review check cannot run and this merge is blocked. Install jq (brew install jq) or merge from the GitHub UI." >&2
    exit 2
  fi
  echo "[delegation-guard] jq not found: delegation checks are OFF" >&2
  exit 0
fi
j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

sid=$(j .session_id)
tool=$(j .tool_name)
in_subagent=$([ -n "$(j .agent_id)" ] && echo 1)
# State is unusable (bad="1") if the session id is not plain (it goes into a path) or the
# per-user folder cannot be made or is not ours. Then nothing is created or written, and
# only a merge (Bash or set_auto_merge) is acted on: it is DENIED (fails closed).
bad=""
case "$sid" in ""|*[!A-Za-z0-9_-]*) bad=1 ;; esac
if [ -z "$bad" ]; then
  # Per-user state folder, not readable or writable by other users.
  umask 077
  base="${TMPDIR:-/tmp}/claude-delegation-$(id -u)"
  mkdir -p -m 700 "$base" 2>/dev/null || bad=1
  # Refuse a symlinked, missing or foreign-owned folder (mkdir -p and -O both follow symlinks).
  [ -z "$bad" ] && { [ -L "$base" ] || [ ! -d "$base" ] || [ ! -O "$base" ]; } && bad=1
  if [ -z "$bad" ]; then
    chmod 700 "$base" 2>/dev/null
    dir="$base/$sid"
    mkdir -p "$dir" 2>/dev/null || bad=1
    [ -z "$bad" ] && { [ -L "$dir" ] || [ ! -d "$dir" ] || [ ! -O "$dir" ]; } && bad=1
  fi
fi
[ -n "$bad" ] && [ "$tool" != Bash ] && [ "$tool" != mcp__ccd_pr__set_auto_merge ] && exit 0
# Counters are read back into shell arithmetic: anything but digits counts as 0.
get() { [ -n "$bad" ] && { echo 0; return; }; local v; v=$(cat "$dir/$1" 2>/dev/null); case "$v" in ""|*[!0-9]*) v=0 ;; esac; echo "$v"; }
put() { [ -n "$bad" ] && return 0; echo "$2" > "$dir/$1"; }
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
    # (`<<<` is a here-string, not a heredoc; a terminator may carry leading tabs, as with <<-.)
    raw=$(j .tool_input.command)
    cmd=$(printf '%s\n' "$raw" | awk -v q="'" '
      d != "" { l = $0; sub(/^\t+/, "", l); if (l == d) d = ""; next }
      { print
        if (match($0, "(^|[^<])<<-?[ \t]*[\"" q "]?[A-Za-z_][A-Za-z0-9_]*")) {
          t = substr($0, RSTART, RLENGTH); gsub("^[^<]?<<-?[ \t]*[\"" q "]?", "", t); d = t } }')
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
# ---- Merge gate ----
HATCHES="To skip the pr-reviewer check add a comment on the same line as the merge  # reviewed-by: <which review>  (at least 8 characters after the colon). Text in quotes or in another command never counts."
SHAPES="A merge must be one plain command the guard can read exactly, e.g.  gh pr merge 970 --squash --delete-branch   or   cd /x && gh pr merge 970 --squash --delete-branch 2>&1 | tail -5   or   gh api -X PUT repos/OWNER/REPO/pulls/970/merge -f merge_method=squash. No \$(...), backticks, ||, &, subshells, heredocs, export/env/eval/bash -c or curl. Before it only cd, gh pr view/checks/status, git fetch/status/log, echo and sleep N are allowed; after it only gh pr view/checks/list/status, git checkout/switch/pull/fetch/log/status/branch, echo, sleep N and cd. Use --body-file instead of a heredoc."

reviewer_check() {   # $1 = PR number; denies, or returns 0 when a pr-reviewer started in this session covers it
  rev=$(cat "$dir/reviewed" 2>/dev/null)
  [ -z "$rev" ] && deny "[delegation-guard] Merge blocked: pr-reviewer has not been run in this session since the last code change (see the Delegation section of CLAUDE.md: before merging -> pr-reviewer). Run the pr-reviewer agent on this PR first. If it was reviewed elsewhere, or you are deliberately merging your own work without review, re-run with a comment on the same line as the merge saying so, e.g.  # reviewed-by: teammate review in PR comments   or   # reviewed-by: self, confident because <reason>."
  printf '%s\n' "$rev" | grep -qx any && return 0
  printf '%s' "$1" | grep -qE '^[0-9]+$' || deny "[delegation-guard] Merge blocked: could not work out the PR number this merge targets, so the pr-reviewer check cannot run (fails closed). $HATCHES"
  printf '%s\n' "$rev" | grep -qx "$1" && return 0
  deny "[delegation-guard] Merge blocked: pr-reviewer in this session reviewed PR $(printf '%s' "$rev" | tr '\n' ' ') but not PR $1. Run pr-reviewer on this PR, or add  # reviewed-by: <which review>  as a comment on the same line as the merge."
}

# Allowlist grammar for a merge command. One python3 helper, fed the RAW command (never the awk-stripped text):
# lexes it (quotes resolved, $ ` \ flagged, operators and comments kept apart; $'...', a heredoc/here-string or a CR
# in a command that mentions a merge are errors), finds the merge, enforces the grammar, and reads the hatches from the
# comment on the merge's line. Prints one JSON object: state merge|none|error, error?, unparsed?, suspect?, kind, target, repo,
# number, sha, cwd, hatch_reviewed.
read -r -d '' PY_GATE <<'PY'
import sys, json, re, os
cwd0 = sys.argv[1] or os.getcwd()
text = sys.stdin.read()
def out(d): print(json.dumps(d)); sys.exit(0)
RX_HIT = re.compile(r"pr\s+merge|pulls/\d+/merge")
flat = text.replace("\\\n", "")

# ---- 1. lexer: words (quotes resolved, with flags), operators, comments. Linear time. ----
OPS = ["<<<", "<<-", "<<", "<&", ">&", ">>", ">|", "&>>", "&>", "&&", "||", "|&", ";;", "<(", ">(", "|", "&", ";", "<", ">", "(", ")"]
heredoc = False
def lex(s):
    global heredoc
    toks, i, n, w, ln = [], 0, len(s), None, 0      # ln = logical line = number of newline TOKENS so far (continuations are joined, quoted newlines stay in the word)
    def endw():
        nonlocal w
        if w is not None: w["t"] = "".join(w.pop("p")); w["ln"] = ln; toks.append(w); w = None
    while i < n:
        c = s[i]
        if c in " \t": endw(); i += 1; continue                              # blanks are space and tab only
        if c == "\\" and s[i + 1:i + 2] == "\n": i += 2; continue          # line continuation: removed, like bash
        if c == "\n": endw(); toks.append({"k": "op", "t": "\n", "fd": "", "ln": ln}); ln += 1; i += 1; continue
        if c == "#" and w is None:                                          # comment: only where a word could start
            j = s.find("\n", i); j = n if j < 0 else j
            toks.append({"k": "comment", "t": s[i + 1:j], "ln": ln}); i = j; continue
        if c in ";&|<>()":
            fd = ""
            if c in "<>" and w is not None and not w["q"] and "".join(w["p"]).isdigit(): fd = "".join(w["p"]); w = None
            else: endw()
            op = next(o for o in OPS if s.startswith(o, i))
            if op in ("<<", "<<<", "<<-"): heredoc = True
            toks.append({"k": "op", "t": op, "fd": fd, "ln": ln}); i += len(op); continue
        if w is None: w = {"k": "w", "p": [], "f": set(), "q": False}
        if c == "\\": w["f"].add("bs"); w["p"].append(s[i + 1:i + 2]); i += 2; continue
        if c == "$" and s[i + 1:i + 2] == "'": raise ValueError("ansi-c quote")   # $'...' is not understood: deny
        if c == "'":
            j = s.find("'", i + 1)
            if j < 0: raise ValueError("quote")
            w["p"].append(s[i + 1:j]); w["q"] = True; i = j + 1; continue
        if c == '"':
            w["q"] = True; i += 1
            while True:
                if i >= n: raise ValueError("quote")
                d = s[i]
                if d == '"': i += 1; break
                if d == "\\":
                    nx = s[i + 1:i + 2]
                    if nx == "\n": i += 2; continue
                    if nx in ('"', "\\"): w["p"].append(nx); i += 2; continue
                if d == "`" or (d == "$" and re.match(r"[A-Za-z0-9_{(?!@*#$-]", s[i + 1:i + 2])): w["f"].add("dollar")   # a lone $ ("^$") is literal
                w["p"].append(d); i += 1
            continue
        if c in "$`": w["f"].add("dollar")
        elif c in "*?[]{}" or (c == "=" and not w["p"] and not w["q"]): w["f"].add("glob")
        elif c == "~" and not w["p"] and not w["q"]: w["f"].add("tilde")
        w["p"].append(c); i += 1
    endw()
    return toks
SUSPECT = bool(re.search(r"(^|[^\w-])gh(\s|$)|pulls/\d+/merge", flat))
try: toks = lex(text)
except ValueError: out({"state": "error", "suspect": SUSPECT})

# ---- 3. split into simple commands (any operator separates, for detection) ----
REDIR = {"<", "<<", "<<<", "<<-", "<&", ">", ">>", ">&", ">|", "&>", "&>>"}
SEPOK = {"&&", ";", "\n"}
cmds, viol = [], []
def newcmd(sep, pi): return {"w": [], "r": [], "sep": sep, "pi": pi, "piped_out": False, "ln": -1}
cur, pend = newcmd("start", 0), None
def close():
    if cur["w"] or cur["r"]: cmds.append(cur)
for t in toks:
    if t["k"] == "comment": continue
    if t["k"] == "w":
        if pend is not None: pend["operand"] = t; cur["r"].append(pend); pend = None
        else: cur["w"].append(t)
        cur["ln"] = t["ln"]
        continue
    o = t["t"]
    if pend is not None: viol.append("a redirect without a target"); pend = None
    if o in REDIR: pend = {"fd": t["fd"], "op": o, "operand": None}
    elif o in SEPOK: close(); cur = newcmd(o, 0)
    elif o == "|": cur["piped_out"] = True; close(); cur = newcmd("|", cur["pi"] + 1)
    else:
        viol.append({"||": "`||`", "&": "a background `&`", "(": "`( )` (a subshell or $( ))", ")": "`( )` (a subshell or $( ))", ";;": "`;;` (case)", "|&": "`|&`"}.get(o, "the operator `%s`" % o))
        close(); cur = newcmd(o, 0)
if pend is not None: viol.append("a redirect without a target")
close()

# ---- 4. grammar helpers (an allowlist: anything not listed is denied) ----
class Gram(Exception): pass
def G(m): raise Gram(m)
ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
REPO_OK = re.compile(r"([\w.-]+/)?[\w.-]+/[\w.-]+")
TARGET_URL = re.compile(r"https?://[^/]+/([\w.-]+)/([\w.-]+)/pull/(\d+)/?")
TARGET_BR = re.compile(r"[\w./:@+-]+")
API_END = re.compile(r"/?repos/([\w.-]+)/([\w.-]+)/pulls/(\d+)/merge")
OKREDIR = {("2", ">&", "1"), ("", ">", "/dev/null"), ("2", ">", "/dev/null")}
PIPE_OK = {"tail", "head", "cat", "grep", "jq"}
PRE_GH, POST_GH = {"view", "checks", "status"}, {"view", "checks", "list", "status"}
POST_RUN, POST_WT = {"list", "view", "watch"}, {"remove", "prune"}
def is_gh(x): return x == "gh" or (x.startswith("/") and os.path.basename(x) == "gh")
PRE_GIT, POST_GIT = {"fetch", "status", "log"}, {"checkout", "switch", "pull", "fetch", "log", "status", "branch", "merge-base"}
def word_ok(t, tilde=False):
    f = t["f"]
    if "dollar" in f: G("an argument contains $ or a backtick")
    if "bs" in f: G("an argument contains a backslash outside quotes")
    if "\r" in t["t"]: G("an argument contains a carriage return")
    if "glob" in f: G("an unquoted argument contains a pattern character (* ? [ ] { } or a leading =), quote it")
    if "tilde" in f and not (t["t"].startswith("~/") or (tilde and t["t"] == "~")): G("an unquoted ~ that is not a ~/path")
def need(a, i):
    if i + 1 >= len(a): G("flag `%s` needs a value" % a[i])
    return a[i + 1]
def parse_pr(a, prefix_repo):
    repo, tgt, sha, i, stage, flags = "", "", "", 0, 0, set()
    while i < len(a):
        t = a[i]
        if t in ("-R", "--repo"): repo = need(a, i); i += 2; continue
        if t.startswith("--repo="): repo = t[7:]; i += 1; continue
        if t.startswith("-R") and not t.startswith("--"): repo = t[2:].lstrip("=") if t[2:3] == "=" else t[2:]; i += 1; continue
        if stage == 0:
            if t != "pr": G("unexpected `%s` before `pr merge`" % t)
            stage = 1; i += 1; continue
        if stage == 1:
            if t != "merge": G("unexpected `%s` after `pr`" % t)
            stage = 2; i += 1; continue
        if t.startswith("--"):
            name, eq, val = t.partition("=")
            flags.add(name)
            if name in ("--squash", "--merge", "--rebase", "--delete-branch", "--auto", "--admin", "--disable-auto"):
                if eq: G("flag `%s` takes no value" % name)
            elif name in ("--body", "--body-file", "--subject", "--author-email", "--match-head-commit"):
                if not eq: val = need(a, i); i += 1
                if name == "--match-head-commit": sha = val
            else: G("unknown flag `%s`" % name)
        elif t.startswith("-") and len(t) > 1:
            for k, ch in enumerate(t[1:]):
                flags.add("-" + ch)
                if ch in "smrd": continue
                if ch in "bFtA":
                    r = t[k + 2:]
                    if not r: need(a, i); i += 1
                    break
                G("unknown flag `-%s`" % ch)
        else:
            if tgt: G("more than one PR target")
            tgt = t
        i += 1
    if stage != 2: G("not a `gh pr merge` command")
    if repo and not REPO_OK.fullmatch(repo): G("the repo `%s` is not a literal OWNER/REPO" % repo)
    number, urlrepo = "", ""
    m = TARGET_URL.fullmatch(tgt) if tgt else None
    if m: number, urlrepo = m.group(3), m.group(1) + "/" + m.group(2)
    elif tgt.isdigit(): number = tgt
    elif tgt and not TARGET_BR.fullmatch(tgt): G("the PR target `%s` is not a number, a pull URL or a branch name" % tgt)
    return {"kind": "pr", "target": tgt, "repo": "" if m else (repo or prefix_repo), "number": number, "sha": sha, "flags": flags}
def parse_api(a):
    end, i, stage, shas = "", 0, 0, []
    while i < len(a):
        t = a[i]
        if stage == 0:
            if t != "api": G("unexpected `%s` before `api`" % t)
            stage = 1; i += 1; continue
        val = None
        if t in ("-X", "--method"): val = need(a, i); i += 1
        elif t.startswith("-X") and not t.startswith("--"): val = t[2:]
        elif t.startswith("--method="): val = t[9:]
        if val is not None:
            if val != "PUT": G("gh api must use PUT for a merge")
        elif t in ("-f", "-F", "--field", "--raw-field") or t.startswith(("--field=", "--raw-field=")):
            v = t.partition("=")[2] if t.startswith("--") and "=" in t else need(a, i)
            if not (t.startswith("--") and "=" in t): i += 1
            k, eq, vv = v.partition("=")
            if k == "sha": shas.append(vv)
        elif t in ("-H", "--header", "-q", "--jq") or t.startswith(("--header=", "--jq=")):
            if not (t.startswith("--") and "=" in t): need(a, i); i += 1
        elif t.startswith("-") and len(t) > 1: G("unknown flag `%s`" % t)
        else:
            if end: G("more than one gh api endpoint")
            end = t
        i += 1
    m = API_END.fullmatch(end)
    if not m: G("the gh api endpoint must be exactly [/]repos/OWNER/REPO/pulls/N/merge (no placeholders, no host)")
    if len(shas) > 1: G("more than one sha= field")
    return {"kind": "api", "target": m.group(3), "repo": m.group(1) + "/" + m.group(2), "number": m.group(3), "sha": shas[0] if shas else ""}

# ---- 5. detection: which commands are merges ----
PULLS = re.compile(r"pulls/\d+/merge")
MERGETXT = re.compile(r"pr\s+merge|pulls/\d+/merge")
API_VL = {"--method", "--raw-field", "--field", "--header", "--input", "--jq", "--template", "--hostname", "--preview", "--cache"}
API_VS = "XfFHqtp"
def gh_kind(a):
    pos, j, idx = [], 0, None
    while j < len(a):
        t = a[j]
        if t in ("-R", "--repo"): j += 2; continue
        if t.startswith("-"): j += 1; continue
        pos.append(t)
        if len(pos) == 1: idx = j
        if len(pos) == 2: break
        j += 1
    if pos[:2] == ["pr", "merge"]: return "merge"
    if pos[:1] == ["api"]:
        j = idx + 1
        while j < len(a):                                   # endpoint = anything not swallowed by a known value flag
            t = a[j]
            if t in API_VL: j += 2; continue
            if t.startswith("--"): j += 1; continue
            if t.startswith("-") and len(t) > 1:
                j += 1 if (t[1] not in API_VS or len(t) > 2) else 2; continue
            if PULLS.search(t): return "merge"
            j += 1
    return None
def is_disable(ws):
    """Only `gh pr merge [target] --disable-auto [-R repo]` and nothing else (checked with the real flag table)."""
    ws = list(ws)
    while ws and ASSIGN.match(ws[0]): ws.pop(0)
    if not ws or ws[0] != "gh": return False
    try: r = parse_pr(ws[1:], "")
    except Gram: return False
    return r["flags"] == {"--disable-auto"}
dets, n_disable = [], 0
for ci, c in enumerate(cmds):
    ws = [t["t"] for t in c["w"]]
    for g, wd in enumerate(ws):
        b = os.path.basename(wd)
        if b == "gh":
            if gh_kind(ws[g + 1:]) == "merge":
                if g == 0 or all(ASSIGN.match(x) for x in ws[:g]):
                    if is_disable(ws): n_disable += 1; continue
                dets.append((ci, "gh"))
        elif b == "curl" and any(PULLS.search(x) for x in ws[g + 1:]): dets.append((ci, "curl"))
        elif b in ("bash", "sh", "zsh", "dash", "ksh") and any(re.fullmatch(r"-[a-z]*c[a-z]*", x) for x in ws[g + 1:]) and any(MERGETXT.search(x) for x in ws[g + 1:]): dets.append((ci, "shell"))
        elif b == "eval" and any(MERGETXT.search(x) for x in ws[g + 1:]): dets.append((ci, "eval"))
# ---- 5b. hatch: only a `#` comment on the same logical line as the end of the merge command (its pipeline), found by
# the lexer; its text must start with the key ----
hatch_reviewed = False
if dets:
    mi0 = dets[0][0]; end_ln = cmds[mi0]["ln"]
    for k in range(mi0 + 1, len(cmds)):
        if cmds[k]["pi"] > 0: end_ln = cmds[k]["ln"]
        else: break
    hcs = [t["t"].lstrip() for t in toks if t["k"] == "comment" and t["ln"] == end_ln]
    if hcs and re.match(r"reviewed-by:\s*\S.{7,}", hcs[0]): hatch_reviewed = True
base = {"hatch_reviewed": hatch_reviewed}
raw_hit = bool(RX_HIT.search(flat))
if (dets or raw_hit) and heredoc:
    out(dict(base, state="merge", error="a heredoc or here-string (<<) in a command that mentions a merge is not allowed (write the PR body with the Write tool, or in a separate Bash call, and pass --body-file)"))
if (dets or raw_hit) and "\r" in text:
    out(dict(base, state="merge", error="a carriage return in a command that mentions a merge is not allowed"))
HD = re.compile(r"(?<!<)<<(-?)\s*(['\"]?)([A-Za-z_]\w*)\2")
def strip_heredocs(t):
    """Blank only heredoc bodies: the lines after the <<X line up to and including the line equal to X (leading tabs
    stripped for <<-). Returns (rest, ok); ok is False when a terminator is missing."""
    outp, pos = [], 0
    while True:
        m = HD.search(t, pos)
        if not m: outp.append(t[pos:]); return "".join(outp), True
        eol = t.find("\n", m.end())
        if eol < 0: outp.append(t[pos:]); return "".join(outp), False
        outp.append(t[pos:eol + 1])
        d, tabs, j, found = m.group(3), m.group(1) == "-", eol + 1, False
        while j <= len(t):
            k = t.find("\n", j); line = t[j:k] if k >= 0 else t[j:]
            if (line.lstrip("\t") if tabs else line) == d: found = True; pos = (k + 1) if k >= 0 else len(t); break
            if k < 0: break
            j = k + 1
        if not found: return "".join(outp), False
if not dets:
    # real merges are none; merge text that is not inside a quoted word (e.g. in a comment, or `echo` words) beyond the real
    # --disable-auto commands is a command the guard could not read: deny rather than guess
    unq = " ".join([t["t"] for t in toks if t["k"] == "w" and not t["q"]] + [t["t"] for t in toks if t["k"] == "comment"])
    # a word with an EXECUTABLE substitution ($( ) or backticks) that mentions a merge may run it: count it too. Plain $NAME,
    # ${..} and special parameters cannot run a command. The usual commit-message idiom "$(cat <<'EOF' ... EOF)" is read
    # with ONLY the heredoc body blanked out: the rest of the word (including the rest of the <<EOF line and anything after
    # the terminator) is still checked, and a heredoc with no terminator is denied.
    cnt, forced = len(RX_HIT.findall(unq)), False
    for t in toks:
        if t["k"] != "w" or not ("$(" in t["t"] or "`" in t["t"]): continue
        txt = t["t"]
        if re.search(r"\$\(\s*cat\s+<<", txt):
            txt, okh = strip_heredocs(txt)
            if not okh: forced = True
        cnt += len(RX_HIT.findall(txt))
    out(dict(base, state="none", unparsed=forced or cnt > n_disable))

# ---- 6. grammar for the merge command ----
def analyse():
    if viol: G("this command uses %s, which is not allowed in a merge command" % viol[0])
    if len(dets) > 1: G("more than one merge in one command")
    mi, how = dets[0]
    if how == "curl": G("curl merges are not allowed, use gh")
    if how in ("shell", "eval"): G("a merge inside bash -c / sh -c / eval is not allowed")
    for c in cmds:
        for r in c["r"]:
            if r["operand"] is None: G("a redirect without a target")
            word_ok(r["operand"])
            if (r["fd"], r["op"], r["operand"]["t"]) not in OKREDIR: G("the redirect `%s%s %s` (only 2>&1, >/dev/null and 2>/dev/null are allowed)" % (r["fd"], r["op"], r["operand"]["t"]))
        for t in c["w"]: word_ok(t, tilde=bool(c["w"]) and c["w"][0]["t"] == "cd")
    here, phase, spec = cwd0, "pre", None
    for i, c in enumerate(cmds):
        ws = [t["t"] for t in c["w"]]
        if not ws: G("a redirect with no command")
        if c["pi"] > 0:
            if ws[0] not in PIPE_OK or ASSIGN.match(ws[0]): G("a pipe may only go into tail, head, cat, grep or jq")
            continue
        if i == mi:
            pre = []
            while ws and ASSIGN.match(ws[0]): pre.append(ws.pop(0))
            if len(pre) > 1 or (pre and not (pre[0].startswith("GH_REPO=") and REPO_OK.fullmatch(pre[0][8:]))): G("the only variable allowed before gh is one GH_REPO=OWNER/REPO")
            if not ws or not is_gh(ws[0]): G("run the merge as plain `gh ...` (not through xargs, env, sudo, time or command)")
            prefix_repo = pre[0][8:] if pre else ""
            spec = parse_api(ws[1:]) if len(ws) > 1 and ws[1] == "api" else parse_pr(ws[1:], prefix_repo)
            if "--disable-auto" in spec.get("flags", ()): G("--disable-auto cannot be combined with other flags in a merge command")
            spec.pop("flags", None)
            spec["cwd"] = here                      # the directory at the merge, not after later cds
            phase = "post"; continue
        if ASSIGN.match(ws[0]): G("a variable assignment before `%s`" % ws[0].split("=")[0])
        p = ws[0]
        if p == "cd":
            if len(ws) != 2 or ws[1].startswith("-") or c["piped_out"]: G("cd takes exactly one literal directory")
            here = os.path.normpath(os.path.join(here, os.path.expanduser(ws[1])))
        elif p == "echo": pass
        elif p == "sleep":
            if len(ws) != 2 or not ws[1].isdigit(): G("sleep takes one whole number")
        elif is_gh(p):
            okc = len(ws) >= 3 and ((ws[1] == "pr" and ws[2] in (PRE_GH if phase == "pre" else POST_GH)) or (phase == "post" and ws[1] == "run" and ws[2] in POST_RUN))
            if not okc: G("this gh command is not allowed %s the merge" % ("before" if phase == "pre" else "after"))
        elif p == "git":
            ga = ws[1:]
            if ga[:1] == ["-C"]:                      # git -C <literal path> <subcommand>
                if len(ga) < 3 or ga[1].startswith("-"): G("git -C needs a literal path and a subcommand")
                ga = ga[2:]
            sub = ga[0] if ga else ""
            if not (sub in (PRE_GIT if phase == "pre" else POST_GIT) or (phase == "post" and sub == "worktree" and ga[1:2] and ga[1] in POST_WT)): G("this git command is not allowed %s the merge" % ("before" if phase == "pre" else "after"))
        else: G("`%s` is not allowed %s the merge" % (p, "before" if phase == "pre" else "after"))
    if spec is None: G("no merge command found")
    return spec
res = dict(base, state="merge")
try: res.update(analyse())
except Gram as e: res["error"] = str(e)
out(res)
PY

# gh runner: fork gh into its own process group with stdin from /dev/null; on the alarm KILL the group, exit 124.
PERL_RUN='my $t = shift; my $pid = fork(); defined $pid or exit 125;
if (!$pid) { setpgrp(0, 0); open(STDIN, "<", "/dev/null"); exec @ARGV; exit 127 }
$SIG{ALRM} = sub { kill "KILL", -$pid; kill "KILL", $pid; waitpid($pid, 0); exit 124 };
alarm $t; waitpid($pid, 0); my $s = $?; exit($s & 127 ? 128 + ($s & 127) : $s >> 8);'

lookup_head() {   # fills LK_SHA / LK_NUM with `gh pr view [target] [--repo R] --json headRefOid,number`; denies on any failure
  [ -n "$LK_SHA" ] && return 0
  local ghargs=(pr view) shown left gh_to out rc js
  shown="${G_TARGET:-the PR of the current branch}"; [ -n "$G_REPO" ] && shown="$shown in $G_REPO"
  command -v perl >/dev/null 2>&1 || deny "[delegation-guard] Merge blocked: perl is not installed (used as the gh timeout), so the PR cannot be looked up (fails closed). $HATCHES"
  left=$(( G_DEADLINE - $(date +%s) ))
  [ "$left" -le 0 ] && deny "[delegation-guard] Merge blocked: the time budget for the PR lookup (${G_TOTAL}s) ran out before the head SHA of $shown could be read (fails closed). $HATCHES"
  gh_to=$G_GH_CAP; [ "$left" -lt "$gh_to" ] && gh_to=$left
  [ -n "$G_TARGET" ] && ghargs+=("$G_TARGET")
  case "$G_TARGET" in http*) ;; *) [ -n "$G_REPO" ] && ghargs+=(--repo "$G_REPO") ;; esac
  ghargs+=(--json headRefOid,number)
  out=$(mktemp "$dir/headsha.XXXXXX") || deny "[delegation-guard] Merge blocked: could not create a temp file for the gh output (fails closed). $HATCHES"
  # Output goes to a file (not a pipe) so a child that outlives gh cannot hold this call open.
  ( cd "$G_CWD" 2>/dev/null && GH_PROMPT_DISABLED=1 perl -e "$PERL_RUN" "$gh_to" gh "${ghargs[@]}" >"$out" 2>/dev/null ) 2>/dev/null; rc=$?
  js=$(cat "$out" 2>/dev/null); rm -f "$out"
  [ "$rc" -ne 0 ] && deny "[delegation-guard] Merge blocked: could not read the head SHA of $shown (gh failed, was not found, was killed after ${gh_to}s, or the directory $G_CWD is missing), so the checks cannot run (fails closed). $HATCHES"
  LK_SHA=$(printf '%s' "$js" | jq -r '.headRefOid // empty' 2>/dev/null | tr 'A-F' 'a-f'); LK_NUM=$(printf '%s' "$js" | jq -r '.number // empty' 2>/dev/null)
  printf '%s' "$LK_SHA" | grep -qE '^[0-9a-f]{40}$' && printf '%s' "$LK_NUM" | grep -qE '^[0-9]+$' \
    || { LK_SHA=""; deny "[delegation-guard] Merge blocked: gh did not return a valid head SHA and number for $shown, so the checks cannot run (fails closed). $HATCHES"; }
  return 0
}

run_checks() {   # $1 = reviewed-by hatch present (true|false). Uses G_*.
  # Timeouts: a positive integer, else the default (0, text or negative would mean "no alarm"); both capped at 12 s.
  G_GH_CAP="${DELEGATION_GUARD_GH_TIMEOUT:-}"; G_TOTAL="${DELEGATION_GUARD_DEADLINE:-}"
  printf '%s' "$G_GH_CAP" | grep -qE '^[1-9][0-9]{0,3}$' || G_GH_CAP=10
  printf '%s' "$G_TOTAL" | grep -qE '^[1-9][0-9]{0,3}$' || G_TOTAL=11
  [ "$G_GH_CAP" -gt 12 ] && G_GH_CAP=12
  [ "$G_TOTAL" -gt 12 ] && G_TOTAL=12
  G_DEADLINE=$(( $(date +%s) + G_TOTAL )); LK_SHA=""; LK_NUM=""
  local num="$G_NUM"
  if [ "$1" != true ]; then
    [ -z "$num" ] && { lookup_head; num="$LK_NUM"; }
    reviewer_check "$num"
  fi
  return 0
}

gate_bash() {   # $1 = the RAW command. Python only runs when the text can be a merge at all (it contains "merge").
  local st rv err unp susp
  case "$1" in *[Mm][Ee][Rr][Gg][Ee]*) ;; *) return 0 ;; esac
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | grep -qE '(^|[^[:alnum:]_-])gh([[:space:]]|$)|pulls/[0-9]+/merge' \
      && deny "[delegation-guard] Merge blocked: python3 is not installed, so the merge command cannot be checked (fails closed). Install python3, or merge from the GitHub UI."
    return 0
  fi
  # one jq call; \037 is a non-blank separator, so empty fields survive `read`
  IFS=$'\037' read -r st rv err unp susp G_KIND G_TARGET G_REPO G_NUM G_SHA G_CWD <<< "$(printf '%s' "$1" | python3 -I -c "$PY_GATE" "$(j .cwd)" 2>/dev/null \
    | jq -r '[.state, .hatch_reviewed, .error, .unparsed, .suspect, .kind, .target, .repo, .number, .sha, .cwd] | map(. // "" | tostring) | join("\u001f")' 2>/dev/null)"
  case "$st" in
    merge) ;;
    none) [ "$unp" = true ] && deny "[delegation-guard] Merge blocked: the command mentions a PR merge outside a quoted string (for example in a comment or as plain words) but the guard could not tell which part is the merge, so it fails closed. $SHAPES $HATCHES"
          return 0 ;;
    error) [ "$susp" = true ] && deny "[delegation-guard] Merge blocked: the guard could not read this command (an unclosed quote, or \$'...' quoting, which it does not understand) and it mentions gh and a merge, so it fails closed. $SHAPES $HATCHES"
           return 0 ;;
    *) printf '%s' "$1" | grep -qE '(^|[^[:alnum:]_-])gh([[:space:]]|$)|pulls/[0-9]+/merge' \
         && deny "[delegation-guard] Merge blocked: the merge check could not run on this command (fails closed). $SHAPES $HATCHES"
       return 0 ;;
  esac
  [ -n "$bad" ] && deny "[delegation-guard] Merge blocked: the guard could not verify review state (the session id is empty or not plain, or its per-user state folder under \${TMPDIR:-/tmp} could not be created, is a symlink, or is not owned by you). Fix that, or merge from the GitHub UI."
  [ -n "$err" ] && deny "[delegation-guard] Merge blocked: $err. $SHAPES $HATCHES"
  run_checks "$rv"      # the hatch (the grammar passed) skips the reviewer check, and then no gh call is made
}

gate_mcp() {   # set_auto_merge: no grammar and no hatch; the reviewer check runs at enable time (a later push is not re-checked)
  [ -n "$bad" ] && deny "[delegation-guard] Merge blocked: the guard could not verify review state (the session id is empty or not plain, or its per-user state folder under \${TMPDIR:-/tmp} could not be created, is a symlink, or is not owned by you). Fix that, or merge from the GitHub UI."
  local spec
  # Real schema: {enabled, url, merge_method}. The URL (any string value holding a github.com/O/R/pull/N link) is the
  # primary path. Fallbacks, in case the schema grows: number|pr_number|pull_number|prNumber|pullNumber|pr, repo|repository
  # (O/R) or owner + repo. None found -> the PR of the current branch in .cwd.
  spec=$(printf '%s' "$input" | jq -c '.tool_input as $t
    | ([$t | .. | strings | select(test("github\\.com/[^/]+/[^/]+/pull/[0-9]+"))] | first // "") as $url
    | ([$t.number, $t.pr_number, $t.pull_number, $t.prNumber, $t.pullNumber, $t.pr] | map(select(. != null and (tostring | test("^[0-9]+$")))) | first // "" | tostring) as $num
    | ([$t.repo, $t.repository, $t.repo_full_name] | map(select(type == "string" and test("^[^/]+/[^/]+$"))) | first // (if (($t.owner|type) == "string" and ($t.repo|type) == "string") then $t.owner + "/" + $t.repo else "" end)) as $repo
    | {target:(if $url != "" then $url else $num end), repo:(if $url != "" then "" else $repo end)}' 2>/dev/null)
  G_KIND=pr; G_TARGET=$(printf '%s' "$spec" | jq -r '.target // empty'); G_REPO=$(printf '%s' "$spec" | jq -r '.repo // empty'); G_SHA=""; G_CWD="$(j .cwd)"
  G_NUM=""
  if [[ "$G_TARGET" =~ /pull/([0-9]+) ]]; then G_NUM="${BASH_REMATCH[1]}"; elif [[ "$G_TARGET" =~ ^[0-9]+$ ]]; then G_NUM="$G_TARGET"; fi
  run_checks false
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
  mcp__ccd_pr__set_auto_merge)
    [ "$(printf '%s' "$input" | jq -r '.tool_input.enabled|tostring')" = "false" ] || gate_mcp ;;
  Bash)
    gate_bash "$raw"
    if printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])gh([[:space:]][^;&|]*)?[[:space:]]pr[[:space:]]+(create|merge)' && [ "$(get verify)" != 1 ] && [ -z "$in_subagent" ] && [ -z "$bad" ]; then
      msgs+=("[delegation-guard] No verifier run since the last code change. See the Delegation section of CLAUDE.md: before declaring done -> verifier (fresh context, can contradict you). Run it before you report this as done.")
    fi ;;
esac

[ -n "$bad" ] && exit 0           # no usable state: only the merge gate above applies
[ -n "$in_subagent" ] && exit 0   # subagents do the reading/editing; that's the point

if [ -n "$code_edit" ] && [ "$(get edits)" -ge "$EDIT_LIMIT" ]; then
  put edits 0
  msgs+=("[delegation-guard] $EDIT_LIMIT code edits in this session since the last implementer call. See the Delegation section of CLAUDE.md: once the plan is decided, hand the writing to the implementer agent (Sonnet) with the spec, files and acceptance criteria. Small one-off fixes are fine here.")
fi

if [ -n "$is_read" ]; then
  n=$(( $(get reads) + 1 ))
  if [ "$n" -ge "$READ_LIMIT" ]; then
    put reads 0
    msgs+=("[delegation-guard] $n code-reading calls in this session since the last scout/log-digger call. See the Delegation section of CLAUDE.md: code reading and tracing -> scout; test runs and long output -> log-digger; only one known file at a time here. Finish this call, then delegate the next reading step.")
  else
    put reads "$n"
  fi
fi

if [ ${#msgs[@]} -gt 0 ]; then
  jq -nc --arg m "$(printf '%s\n' "${msgs[@]}")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}'
fi
exit 0
