#!/usr/bin/env python3
"""What did sub-agents save you? Reads your local Claude Code logs (~/.claude/projects) and estimates,
for a date window, the money and the waiting time that agent orchestration saved compared with the
main session (the "boss") doing the agents' work itself.

    python3 tools/orchestration_cost.py --from 2026-09-15 --to 2026-09-29
    python3 tools/orchestration_cost.py --from 2026-09-15 --to 2026-09-29 --project ~/.claude/projects/-Users-me-myrepo

Nothing leaves your machine. Only the standard library is used.

How it counts
- Every API call is kept only if its own timestamp is inside the window, and each message id is counted
  once. (Selecting sessions by file date is a trap: Claude Code can touch old session files, which
  silently pulls months of old work into "the last two weeks".)
- Dollars are API list prices from PRICES below. On a subscription these are API-equivalent dollars,
  not your invoice. Cache writes are priced at 1.25x input (the 5-minute cache); on a subscription
  Claude Code uses the 1-hour cache (2x), so real cache-write cost is somewhat higher.
- "If the boss did it": the agents' tokens at the price of the session's own main model, plus the
  extra context the boss would have carried. What an agent read during its job would have stayed in
  the boss's conversation and been re-read (at cache-read price) on every later boss turn. That extra
  context is capped at 300k and at 600k tokens, which gives a low and a high estimate.
- Waiting saved = total agent run time minus the wall-clock time they took (overlaps counted once).
  It assumes the boss would have done the same work, one job after another, at the same speed.
"""
import argparse, glob, json, os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# $ per million tokens: (input, output, cache read). Check https://platform.claude.com/docs/en/about-claude/pricing
# Keys are matched as substrings of the model id, in this order.
PRICES = {
    'opus-5-5': (4, 20, 0.20),
    'opus-5': (5, 25, 0.50),
    'fable': (10, 50, 0.25),
    'sonnet': (2, 10, 0.20),
    'haiku': (1, 5, 0.10),
}
CACHE_WRITE = 1.25   # x input price

def price(model):
    for k, p in PRICES.items():
        if k in (model or ''):
            return p

def cost(u, p):
    i, o, r = p
    return (u.get('input_tokens', 0) * i + (u.get('cache_creation_input_tokens') or 0) * i * CACHE_WRITE
            + (u.get('cache_read_input_tokens') or 0) * r + u.get('output_tokens', 0) * o) / 1e6

def context(u):
    return u.get('input_tokens', 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)

def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--from', dest='frm', required=True, help='first day, YYYY-MM-DD (UTC)')
    ap.add_argument('--to', required=True, help='last day, YYYY-MM-DD (UTC, inclusive)')
    ap.add_argument('--project', action='append', help='a ~/.claude/projects/<dir> to read (repeatable); default: all')
    a = ap.parse_args()
    lo = datetime.fromisoformat(a.frm).replace(tzinfo=timezone.utc).timestamp()
    hi = (datetime.fromisoformat(a.to).replace(tzinfo=timezone.utc) + timedelta(days=1)).timestamp()
    dirs = [os.path.expanduser(d) for d in a.project] if a.project else glob.glob(os.path.expanduser('~/.claude/projects/*'))
    seen = set()

    def calls(path):
        """(time, model, usage) per API call inside the window; each message id once across all files."""
        out = {}
        for line in open(path, errors='ignore'):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('type') != 'assistant':
                continue
            m = d.get('message', {}); u = m.get('usage')
            if not u or m.get('model') in (None, '<synthetic>') or 'timestamp' not in d:
                continue
            t = ts(d['timestamp'])
            if not (lo <= t < hi):
                continue
            mid = m.get('id') or f'{path}:{len(out)}'
            if mid in seen and mid not in out:
                continue
            out[mid] = (t, m['model'], u)
        seen.update(out)
        return sorted(out.values(), key=lambda x: x[0])

    T = defaultdict(float); by = defaultdict(lambda: defaultdict(float))
    sessions = with_agents = 0
    for d in dirs:
        for f in sorted(glob.glob(d + '/*.jsonl')):
            sid = os.path.basename(f)[:-6]
            mc = calls(f)
            if not mc:
                continue
            sessions += 1
            n = defaultdict(int)
            for _, m, _ in mc:
                n[m] += 1
            boss = price(max(n, key=n.get)) or PRICES['opus-5-5']
            T['main'] += sum(cost(u, price(m)) for _, m, u in mc if price(m))
            spans, reads = [], []
            for s in sorted(glob.glob(f'{d}/{sid}/subagents/*.jsonl')):
                sc = calls(s)
                if not sc:
                    continue
                try:
                    meta = json.load(open(s[:-6] + '.meta.json'))
                except (OSError, ValueError):
                    meta = {}
                kind = f"{meta.get('agentType', '?')} [{sc[0][1].replace('claude-', '')}]"
                actual = sum(cost(u, price(m)) for _, m, u in sc if price(m))
                as_boss = sum(cost(u, boss) for _, m, u in sc)
                dur = sc[-1][0] - sc[0][0]
                B = by[kind]; B['runs'] += 1; B['actual'] += actual; B['as_boss'] += as_boss; B['hours'] += dur / 3600
                if meta.get('spawnDepth', 1) >= 2:          # an agent started by another agent
                    T['nested_runs'] += 1; T['nested_$'] += actual
                T['agents'] += actual; T['agents_as_boss'] += as_boss; T['agent_hours'] += dur / 3600
                spans.append((sc[0][0], sc[-1][0])); reads.append((sc[0][0], max(0, context(sc[-1][2]) - context(sc[0][2]))))
            if spans:
                with_agents += 1
            spans.sort(); wall = 0; cs = ce = None
            for s0, s1 in spans:
                if ce is None or s0 > ce:
                    if cs is not None:
                        wall += ce - cs
                    cs, ce = s0, s1
                else:
                    ce = max(ce, s1)
            if cs is not None:
                wall += ce - cs
            T['wall_hours'] += wall / 3600
            reads.sort()
            for cap in (300_000, 600_000):
                carried = 0; j = 0
                for t, _, _ in mc:
                    while j < len(reads) and reads[j][0] <= t:
                        carried += reads[j][1]; j += 1
                    T[f'carry_{cap}'] += min(carried, cap) * boss[2] / 1e6

    actual = T['main'] + T['agents']
    print(f'{a.frm} to {a.to} (UTC): {sessions} sessions, {with_agents} with sub-agents')
    print(f"Actual (API-equivalent): ${actual:,.0f}  = main ${T['main']:,.0f} + agents ${T['agents']:,.0f}")
    for cap in (300_000, 600_000):
        cf = T['main'] + T['agents_as_boss'] + T[f'carry_{cap}']
        if cf:
            print(f'If the boss did it all (extra context capped at {cap // 1000}k): ${cf:,.0f} -> saved ${cf - actual:,.0f} ({(cf - actual) / cf:.0%})')
    print(f"Waiting saved: {T['agent_hours'] - T['wall_hours']:.0f} h ({T['agent_hours']:.0f} h of agent work in {T['wall_hours']:.0f} h)")
    print(f"Agents started by other agents: {T['nested_runs']:.0f} runs, ${T['nested_$']:,.0f}")
    print('\nBy agent [model]                                runs  actual $  as boss $  hours')
    for k, B in sorted(by.items(), key=lambda x: -x[1]['actual']):
        print(f"{k[:46]:46} {int(B['runs']):5} {B['actual']:9.1f} {B['as_boss']:10.1f} {B['hours']:6.1f}")

if __name__ == '__main__':
    main()
