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

export function pickSideForMarket(score, candidate) {
  const isBull = score > SIGNAL_BULL_THRESHOLD;
  const isBear = score < SIGNAL_BEAR_THRESHOLD;
  if (!isBull && !isBear) return null;
  let outcomes;
  try { outcomes = JSON.parse(candidate.market.outcomes); } catch { return null; }
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;
  const idx = isBull ? 0 : 1;
  const outcomeLabel = outcomes[idx];
  if (candidate.shape.kind === 'updown') {
    return { side: outcomeLabel, rationale: `Model ${isBull ? 'BULLISH' : 'BEARISH'} (score ${score}) → ${outcomeLabel}` };
  }
  if (candidate.shape.kind === 'above') {
    return { side: outcomeLabel, rationale: `Model ${isBull ? 'BULLISH' : 'BEARISH'} (score ${score}) → ${outcomeLabel} on > $${candidate.shape.strike}` };
  }
  return null;
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
