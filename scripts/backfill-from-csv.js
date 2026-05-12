// One-shot: import the 10 rows from the old local paper-trades.csv
// into Supabase. Run once locally after the paper_trades table has
// been created. Idempotent — primary key (surfaced_at, condition_id,
// side) blocks duplicates on re-run.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/backfill-from-csv.js \
//       /home/lastreetchef/clawd/polymarket/btc-momentum-paper/paper-trades.csv

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const csvPath = process.argv[2];
if (!csvPath) { console.error('usage: node backfill-from-csv.js <path-to-csv>'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY required'); process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const text = readFileSync(csvPath, 'utf8');
const lines = text.split('\n').filter(l => l.trim());
const header = parseLine(lines[0]);
const rows = lines.slice(1).map(parseLine).map(arr => Object.fromEntries(header.map((h, i) => [h, arr[i]])));

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function n(v) { if (v === '' || v == null) return null; const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
function b(v) { return v === 'true'; }
function s(v) { return v === '' ? null : v; }

const records = rows.map(r => ({
  surfaced_at: r.surfaced_at,
  condition_id: r.condition_id,
  market: s(r.market),
  side: r.side,
  entry_price: n(r.entry_price),
  recommended_stake: n(r.recommended_stake),
  model_score: r.model_score === '' ? null : parseInt(r.model_score, 10),
  model_verdict: s(r.model_verdict),
  model_composite: n(r.model_composite),
  model_price: n(r.model_price),
  horizon_min_at_surface: n(r.horizon_min_at_surface),
  end_date: s(r.end_date),
  rationale: s(r.rationale),
  resolved: b(r.resolved),
  winning_outcome: s(r.winning_outcome),
  realized_pnl_usd: n(r.realized_pnl_usd),
  resolved_at: s(r.resolved_at),
}));

console.log(`Inserting ${records.length} rows from ${csvPath}`);
const { error } = await supabase.from('paper_trades').upsert(records, { onConflict: 'surfaced_at,condition_id,side' });
if (error) { console.error('insert error:', error.message); process.exit(1); }
console.log('done.');
