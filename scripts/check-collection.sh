#!/usr/bin/env bash
# Quick paper_trades collection check.
#   ./scripts/check-collection.sh
#
# Requires SUPABASE_ANON_KEY in env. The anon key has read-only access
# to paper_trades via the permissive RLS policy set up in
# migrations/paper_trades.sql — safe to keep in a shell profile.

set -euo pipefail
SUPA_URL="${SUPABASE_URL:-https://ujthozdtdqdwgvguztbr.supabase.co}"
SUPA_KEY="${SUPABASE_ANON_KEY:-}"

if [ -z "$SUPA_KEY" ]; then
  echo "SUPABASE_ANON_KEY not set."
  echo "Set it once:  export SUPABASE_ANON_KEY=ey..."
  exit 1
fi

H1="apikey: $SUPA_KEY"
H2="Authorization: Bearer $SUPA_KEY"

total=$(curl -sI -H "$H1" -H "$H2" -H "Prefer: count=exact" \
  "$SUPA_URL/rest/v1/paper_trades?select=surfaced_at" \
  | awk -F'/' '/[Cc]ontent-[Rr]ange/ {gsub("\r",""); print $NF}')

latest=$(curl -s -H "$H1" -H "$H2" \
  "$SUPA_URL/rest/v1/paper_trades?order=surfaced_at.desc&limit=1&select=surfaced_at" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['surfaced_at'] if r else '')")

age_min=""
status="?"
if [ -n "$latest" ]; then
  age_sec=$(python3 -c "
from datetime import datetime, timezone
t = datetime.fromisoformat('$latest'.replace('Z','+00:00'))
print(int((datetime.now(timezone.utc) - t).total_seconds()))
")
  age_min=$(( age_sec / 60 ))
  if [ "$age_min" -le 10 ]; then status="OK"
  elif [ "$age_min" -le 30 ]; then status="STALE — model may be NEUTRAL"
  else status="STUCK — check Render cron service"
  fi
fi

echo "=== paper_trades ==="
echo "total rows:      ${total}"
echo "last capture:    ${latest:-<none>}  (${age_min} min ago)"
echo "status:          ${status}"
echo
echo "=== latest 3 captures ==="
curl -s -H "$H1" -H "$H2" \
  "$SUPA_URL/rest/v1/paper_trades?order=surfaced_at.desc&limit=3&select=surfaced_at,market,side,model_score,model_verdict,model_sig_ob,model_sig_flow,model_ref_spread,resolved,realized_pnl_usd" \
  | python3 -m json.tool

echo
echo "=== resolution stats ==="
curl -s -H "$H1" -H "$H2" \
  "$SUPA_URL/rest/v1/paper_trades?select=resolved,realized_pnl_usd,model_verdict,model_score" \
  | python3 -c "
import json,sys
from collections import defaultdict
rows = json.load(sys.stdin)
total = len(rows)
res = [r for r in rows if r['resolved'] and r['realized_pnl_usd'] is not None]
won = [r for r in res if float(r['realized_pnl_usd']) > 0]
pnl = sum(float(r['realized_pnl_usd']) for r in res)
print(f'  resolved: {len(res)} / {total}')
if not res: sys.exit()
print(f'  hit rate: {len(won)}/{len(res)} = {len(won)/len(res)*100:.1f}%')
print(f'  total p&l: \${pnl:+.2f}')
print()

# By verdict
g = defaultdict(lambda: {'n':0,'won':0,'pnl':0.0})
for r in res:
    v = r.get('model_verdict') or '?'
    p = float(r['realized_pnl_usd'])
    g[v]['n'] += 1
    if p > 0: g[v]['won'] += 1
    g[v]['pnl'] += p
print('  by verdict:')
print(f'    {\"verdict\":<12} {\"n\":>4} {\"hit%\":>7} {\"pnl\":>10} {\"ROI%\":>8}')
order = ['BEARISH','MILD BEAR','NEUTRAL','MILD BULL','BULLISH']
for v in order + [k for k in g if k not in order]:
    if v not in g: continue
    d = g[v]
    hp = d['won']/d['n']*100
    roi = d['pnl']/(d['n']*10)*100
    print(f'    {v:<12} {d[\"n\"]:>4} {hp:>6.1f}% \${d[\"pnl\"]:>+8.2f} {roi:>+7.1f}%')
print()

# By score bucket
def bucket(s):
    if s is None: return '??'
    if s < 30: return '00-29 deep bear'
    if s < 40: return '30-39 bear'
    if s < 60: return '40-59 neutral'
    if s < 70: return '60-69 mild bull'
    if s < 80: return '70-79 bull'
    return '80-100 deep bull'
gb = defaultdict(lambda: {'n':0,'won':0,'pnl':0.0})
for r in res:
    b = bucket(r.get('model_score'))
    p = float(r['realized_pnl_usd'])
    gb[b]['n'] += 1
    if p > 0: gb[b]['won'] += 1
    gb[b]['pnl'] += p
print('  by score bucket:')
print(f'    {\"bucket\":<18} {\"n\":>4} {\"hit%\":>7} {\"pnl\":>10} {\"ROI%\":>8}')
for b in sorted(gb.keys()):
    d = gb[b]
    hp = d['won']/d['n']*100
    roi = d['pnl']/(d['n']*10)*100
    print(f'    {b:<18} {d[\"n\"]:>4} {hp:>6.1f}% \${d[\"pnl\"]:>+8.2f} {roi:>+7.1f}%')
"
