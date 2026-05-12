// Polymarket market discovery + classifier for btc-momentum.
//
// IMPORTANT — this is duplicated from ~/clawd/polymarket/btc-momentum.js
// because that file lives in the polymarket-trader repo and is used by
// the live picks panel + manual scan command. This copy is the one
// that runs in the Render cron service for paper trading. If you
// change a threshold/classifier in one, update the other.
//
// What was dropped vs. the polymarket version:
//   - scan() and its loadConfig() dependency (paper-trader does its
//     own bookkeeping; no bankroll math needed)
//   - filesystem state writes (Supabase is the store)
//
// Pure HTTP + pure functions. No filesystem or env reads.

const GAMMA = 'https://gamma-api.polymarket.com';

export const SIGNAL_BULL_THRESHOLD = 65;
export const SIGNAL_BEAR_THRESHOLD = 35;
const MIN_HORIZON_MIN = 5;
const MAX_HORIZON_MIN = 120;

// --- Forward-edge model ---------------------------------------------------
// The momentum signal predicts BTC direction 5–15 min ahead. Naively
// firing on any market within 120 min causes us to bet far-future
// resolutions on a near-future signal — which has zero predictive
// value at long horizons.
//
// Instead: compute the model-implied probability for the SIDE we'd
// take, decayed by lead time, and only fire when that probability
// exceeds the market-implied probability by EDGE_PP_THRESHOLD.
//
// Calibration baseline (from 102 paper-trade resolutions, 2026-05-12):
//   deep-bear bucket (composite ~ -0.5) hit 60% on 5-min markets
//   → ~10pp observed edge over 50/50
//   → MAX_EDGE_PP_AT_COMPOSITE_1 ≈ 20 (linear extrapolation)
// SIGNAL_DECAY_MINUTES matches the model's internal trade-flow decay
// (buyVol/sellVol decay 30%/min → ~3 min half-life of trade memory).

export const EDGE_PP_THRESHOLD = 5;            // fire when fair_p > market_p by this much
export const SIGNAL_DECAY_MINUTES = 3;         // exp-decay constant on the directional signal
export const MAX_EDGE_PP_AT_COMPOSITE_1 = 20;  // |composite|=1 + zero lead → this much edge

export function forwardEdge(pick, modelComposite, now = Date.now()) {
  if (modelComposite == null || pick == null || pick.endDate == null) return null;
  const endTime = new Date(pick.endDate).getTime();
  if (!Number.isFinite(endTime)) return null;
  const leadMin = Math.max(0, (endTime - now) / 60000);
  const decay = Math.exp(-leadMin / SIGNAL_DECAY_MINUTES);
  // Side convention: Up/Yes = positive direction (idx 0), Down/No = idx 1
  const sideUpper = (pick.side || '').toUpperCase();
  const sideAlignsBull = sideUpper === 'UP' || sideUpper === 'YES';
  const sideSign = sideAlignsBull ? 1 : -1;
  const edgeAtZeroLeadPp = sideSign * modelComposite * MAX_EDGE_PP_AT_COMPOSITE_1;
  const fairP = 0.5 + (edgeAtZeroLeadPp * decay) / 100;
  const marketP = parseFloat(pick.entryPrice);
  if (!Number.isFinite(marketP) || marketP <= 0) return null;
  return {
    fair_p: fairP,
    edge_pp: (fairP - marketP) * 100,
    lead_min: leadMin,
    decay,
  };
}

export async function fetchModelState(modelUrl) {
  try {
    const r = await fetch(`${modelUrl}/api/state`);
    if (!r.ok) return null;
    const s = await r.json();
    if (!s || typeof s.score !== 'number') return null;
    return s;
  } catch { return null; }
}

export async function fetchCandidateMarkets() {
  // Gamma keeps stale-resolved markets flagged active=true for hours/days
  // after their endDate. Without end_date_min the endDate-asc sort
  // returns ~500 5-month-old "active" markets and never reaches today's
  // 5-min windows. end_date_min filters them out server-side.
  const nowIso = new Date().toISOString();
  const queries = [
    `closed=false&active=true&end_date_min=${encodeURIComponent(nowIso)}&limit=500&order=volume24hr&ascending=false`,
    `closed=false&active=true&end_date_min=${encodeURIComponent(nowIso)}&limit=500&order=endDate&ascending=true`,
  ];
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    for (let off = 0; off < 3000; off += 500) {
      let r; try { r = await fetch(`${GAMMA}/markets?${q}&offset=${off}`); } catch { break; }
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch) || !batch.length) break;
      let hitsInPage = 0;
      for (const m of batch) {
        if (!m.conditionId || seen.has(m.conditionId)) continue;
        seen.add(m.conditionId);
        if (!m.question || !/\bbitcoin|\bbtc\b/i.test(m.question)) continue;
        if (!m.endDate) continue;
        const minutes = (new Date(m.endDate).getTime() - Date.now()) / 60000;
        if (minutes < MIN_HORIZON_MIN || minutes > MAX_HORIZON_MIN) continue;
        const shape = classifyShape(m.question);
        if (!shape) continue;
        out.push({ market: m, minutes, shape });
        hitsInPage++;
      }
      if (hitsInPage === 0 && off > 0) break;
      if (batch.length < 500) break;
    }
  }
  return out;
}

function classifyShape(question) {
  const q = question.toLowerCase();
  if (/\bbitcoin up or down\b/.test(q)) return { kind: 'updown' };
  const mAbove = q.match(/bitcoin\s+(?:be\s+)?above\s+\$?([\d,]+)\s+on\b/);
  if (mAbove) {
    const strike = parseInt(mAbove[1].replace(/,/g, ''), 10);
    if (Number.isFinite(strike) && strike > 1000) return { kind: 'above', strike };
  }
  return null;
}

// pickSideForMarket — gates on forward edge, not raw score buckets.
//
// modelState must include `composite` (range [-1,1]) — used to compute
// forward edge. `score` is kept in the rationale text for traceability.
// Returns null if:
//   - signal too weak (|composite| < 0.05)
//   - market shape unsupported
//   - forward edge < EDGE_PP_THRESHOLD on both sides
//
// Note: above-strike markets are gated by Up-side edge approximation
// (treating "Yes" as Up directionally). A proper above-strike path
// would use GBM with implied vol — see btc-iv.js benchmark module.
// Tracked as a follow-up; for now we use the same momentum drift
// projection but flag the source in the rationale.
export function pickSideForMarket(modelState, candidate) {
  const composite = typeof modelState === 'number'
    ? null  // legacy callers passed `score` directly; reject
    : (modelState && typeof modelState.composite === 'number' ? modelState.composite : null);
  const score = modelState && typeof modelState.score === 'number' ? modelState.score : null;
  if (composite == null || Math.abs(composite) < 0.05) return null;

  let outcomes, prices;
  try { outcomes = JSON.parse(candidate.market.outcomes); } catch { return null; }
  try { prices = JSON.parse(candidate.market.outcomePrices); } catch { return null; }
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;

  // Try both sides; pick the one with positive edge above threshold.
  let best = null;
  for (let idx = 0; idx < 2; idx++) {
    const side = outcomes[idx];
    const entryPrice = parseFloat(prices[idx]);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
    if (entryPrice >= 0.95 || entryPrice <= 0.05) continue;
    const fe = forwardEdge({ side, endDate: candidate.market.endDate, entryPrice }, composite);
    if (!fe) continue;
    if (fe.edge_pp < EDGE_PP_THRESHOLD) continue;
    if (!best || fe.edge_pp > best.fe.edge_pp) best = { side, idx, fe };
  }
  if (!best) return null;

  const verdict = composite > 0 ? 'BULLISH' : 'BEARISH';
  const note = candidate.shape.kind === 'above'
    ? ` on > $${candidate.shape.strike}`
    : '';
  return {
    side: best.side,
    rationale: `${verdict} composite ${composite.toFixed(2)} (score ${score ?? '?'}) · +${best.fe.edge_pp.toFixed(1)}pp edge · lead ${best.fe.lead_min.toFixed(0)}min → ${best.side}${note}`,
    forwardEdge: best.fe,
  };
}

export async function fetchMarket(conditionId) {
  for (const closed of ['false', 'true']) {
    try {
      const r = await fetch(`${GAMMA}/markets?closed=${closed}&condition_ids=${conditionId}`);
      if (!r.ok) continue;
      const arr = await r.json();
      if (Array.isArray(arr) && arr[0]) return arr[0];
    } catch {}
  }
  return null;
}

export function computePnl(row, market) {
  const entryPrice = parseFloat(row.entry_price);
  const stake = parseFloat(row.recommended_stake);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stake) || entryPrice <= 0) return null;
  let outcomes; try { outcomes = JSON.parse(market.outcomes); } catch { return null; }
  let prices; try { prices = JSON.parse(market.outcomePrices); } catch { return null; }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== 2) return null;
  const y = parseFloat(prices[0]);
  const n = parseFloat(prices[1]);
  if (!((y > 0.999 && n < 0.001) || (n > 0.999 && y < 0.001))) return null;
  const winnerIdx = y > 0.5 ? 0 : 1;
  const winningOutcome = outcomes[winnerIdx];
  const sideIdx = outcomes.findIndex(o => o.toUpperCase() === (row.side || '').toUpperCase());
  if (sideIdx < 0) return null;
  const shares = stake / entryPrice;
  const payout = sideIdx === winnerIdx ? shares : 0;
  const pnl = payout - stake;
  return { winningOutcome, pnl };
}
