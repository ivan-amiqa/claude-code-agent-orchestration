#!/usr/bin/env bash
# PreToolUse hook for Bash: blocks commands that would put a secret into the conversation
# (see the "Secrets in the conversation" section of CLAUDE.md.example):
#   - a literal key in the command (common token shapes), or
#   - a macOS Keychain read whose value is printed bare.
# A secret that reaches the chat is leaked: the fix is to rotate it, so stop it before it is printed.
#
# It is a regex safety net, not the control. It misses `echo $VAR`, a bare secrets-manager read and
# any token shape it does not know; the rule in CLAUDE.md is what holds.
# Fail-open by design: without jq it lets everything through rather than break Bash.
# Exit 2 = block (the message on stderr reaches the model). Wired in .claude/settings.json (matcher: Bash).
command -v jq >/dev/null 2>&1 || exit 0
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0
if printf '%s' "$cmd" | grep -Eq '(sk|rk)_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[bpa]-[A-Za-z0-9-]{20,}'; then
  echo "secret-guard: the command contains a literal secret. Read it inline from the Keychain or your secrets manager instead; if it already reached the chat, rotate it." >&2
  exit 2
fi
# `security find-generic-password ... -w` prints the secret unless it sits inside $( ... )
# or its output goes to a pipe or a redirect (e.g. `| pbcopy`).
if printf '%s' "$cmd" | grep -Eq 'find-(generic|internet)-password[^)]*-w' \
  && ! printf '%s' "$cmd" | grep -Eq '\$\([^)]*find-(generic|internet)-password[^)]*-w' \
  && ! printf '%s' "$cmd" | grep -Eq 'find-(generic|internet)-password[^;&]*-w[^;&]*[|>]'; then
  echo "secret-guard: this prints a Keychain secret. Use it inline as \"\$(security find-generic-password -s <name> -w)\" or pipe it to pbcopy." >&2
  exit 2
fi
exit 0
