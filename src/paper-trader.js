// Render cron entry: every 5 min, resolve closed paper trades and
// capture new model-actionable picks. Replaces the local-machine cron
// that died with the laptop. Storage: Supabase paper_trades table.
//
// Required env vars (set in Render dashboard):
//   SUPABASE_URL          - shared with the model server
//   SUPABASE_ANON_KEY     - shared with the model server (table RLS
//                           must allow insert/update under this key)
//   BTC_MOMENTUM_URL      - usually https://btc-momentum.onrender.com
//                           but falls back to that if unset

import { createClient } from '@supabase/supabase-js';
import { fetchModelState, fetchCandidateMarkets, pickSideForMarket, fetchMarket, computePnl } from './polymarket-strategy.js';

const MODEL = process.env.BTC_MOMENTUM_URL || 'https://btc-momentum.onrender.com';
const TABLE = 'paper_trades';

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

async function listOpen() {
  const { data, error } = await supabase.from(TABLE).select('*').eq('resolved', false);
  if (error) throw new Error('listOpen: ' + error.message);
  return data || [];
}

async function listAllKeys() {
  // Just (condition_id, side) pairs for dedup. Pagination if needed.
  const out = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(TABLE).select('condition_id,side').range(from, from + 999);
    if (error) throw new Error('listAllKeys: ' + error.message);
    if (!data || !data.length) break;
    for (const r of data) out.add(`${r.condition_id}:${r.side}`);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function resolveOpen() {
  let resolved = 0;
  const open = await listOpen();
  for (const row of open) {
    if (row.end_date && new Date(row.end_date).getTime() > Date.now()) continue;
    const market = await fetchMarket(row.condition_id);
    if (!market || !market.closed) continue;
    const res = computePnl(row, market);
    if (!res) continue;
    const { error } = await supabase.from(TABLE).update({
      resolved: true,
      winning_outcome: res.winningOutcome,
      realized_pnl_usd: res.pnl,
      resolved_at: new Date().toISOString(),
    }).eq('condition_id', row.condition_id).eq('side', row.side).eq('surfaced_at', row.surfaced_at);
    if (error) console.error('  resolve update err:', error.message);
    else resolved++;
  }
  return resolved;
}

async function captureNew(model) {
  const seen = await listAllKeys();
  const candidates = await fetchCandidateMarkets();
  const toInsert = [];
  for (const c of candidates) {
    const side = pickSideForMarket(model, c);
    if (!side) continue;
    const key = `${c.market.conditionId}:${side.side}`;
    if (seen.has(key)) continue;
    let outcomes, prices;
    try { outcomes = JSON.parse(c.market.outcomes); } catch { continue; }
    try { prices = JSON.parse(c.market.outcomePrices); } catch { continue; }
    const sideIdx = outcomes.findIndex(o => o.toUpperCase() === side.side.toUpperCase());
    if (sideIdx < 0) continue;
    const entryPrice = parseFloat(prices[sideIdx]);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
    if (entryPrice >= 0.95 || entryPrice <= 0.05) continue;
    // Full feature vector captured at prediction time so Phase 2 can
    // re-fit weights (not just thresholds) against realized outcomes.
    const sig = model.signals || {};
    toInsert.push({
      surfaced_at: new Date().toISOString(),
      condition_id: c.market.conditionId,
      market: c.market.question,
      side: side.side,
      entry_price: entryPrice,
      recommended_stake: 10,
      model_score: model.score,
      model_verdict: model.verdict,
      model_composite: model.composite,
      model_price: model.price,
      horizon_min_at_surface: c.minutes,
      end_date: c.market.endDate,
      rationale: side.rationale,
      resolved: false,
      model_imbalance: model.imbalance ?? null,
      model_depth_ratio: model.depthRatio ?? null,
      model_buy_pct: model.buyPct ?? null,
      model_tick_dir: model.tickDir ?? null,
      model_spread: model.spread ?? null,
      model_spread_pct: model.spreadPct ?? null,
      model_sig_ob: sig.sigOB ?? null,
      model_sig_flow: sig.sigFlow ?? null,
      model_sig_spread: sig.sigSpread ?? null,
      model_sig_depth: sig.sigDepth ?? null,
      model_sig_tick: sig.sigTick ?? null,
      model_sig_poly: sig.sigPoly ?? null,
      model_ref_px: model.refPx ?? null,
      model_ref_spread: model.refSpread ?? null,
    });
  }
  if (toInsert.length) {
    const { error } = await supabase.from(TABLE).insert(toInsert);
    if (error) throw new Error('captureNew insert: ' + error.message);
  }
  return toInsert.length;
}

async function main() {
  if (!supabase) {
    console.error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
    process.exit(1);
  }
  console.log(`[paper] tick ${new Date().toISOString()} · model=${MODEL}`);

  const resolved = await resolveOpen();
  console.log(`  resolved this tick: ${resolved}`);

  const model = await fetchModelState(MODEL);
  if (!model) {
    console.log(`  ⚠️  model state unreachable at ${MODEL} — skipped capture`);
    return;
  }
  console.log(`  model score=${model.score} verdict=${model.verdict} price=$${model.price?.toFixed?.(0)}`);

  const added = await captureNew(model);
  console.log(`  captured this tick: ${added}`);
}

main().catch(e => { console.error('[paper] FATAL', e); process.exit(1); });
