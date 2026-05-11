#!/usr/bin/env node
/**
 * Backtest harness for the btc-momentum model.
 *
 * Reads logs/snapshots.jsonl (one row per scored sample, written by
 * src/server.js's maybeLog), pairs each sample with the realized BTC
 * price N minutes later via Binance's klines endpoint, then computes
 * the model's calibration by score bucket.
 *
 * Output (for each horizon):
 *   N total samples, M paired with future price
 *   For each score bucket (0-29, 30-39, 40-49, 50-59, 60-69, 70-100):
 *     count, hit rate (fraction where direction matched verdict),
 *     mean realized return, sample size CI.
 *   Polymarket implication: if the BULLISH (≥70) bucket has hit-rate H,
 *   a "BTC up in N min" YES is +EV when market YES price < H.
 *
 * Usage:
 *   node backtest.js                # 15-min horizon (default)
 *   node backtest.js 5 15 30        # multiple horizons
 *   node backtest.js --since 2026-05-11T20:00:00Z
 *
 * Binance klines are 1-min granularity; horizons round to whole minutes.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, 'logs', 'snapshots.jsonl');
const BINANCE = 'https://api.binance.com/api/v3';

function readSnapshots(sinceIso) {
  if (!existsSync(LOG_PATH)) {
    console.error(`No log at ${LOG_PATH}`);
    process.exit(1);
  }
  const text = readFileSync(LOG_PATH, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (sinceIso && r.ts < sinceIso) continue;
    rows.push(r);
  }
  return rows;
}

// Fetch the 1-minute kline closing price as close to `targetMs` as
// possible. Klines are returned for the minute containing the start
// timestamp. Returns the close price or null on failure.
async function fetchPriceAt(targetMs) {
  const startTime = targetMs;
  const endTime = targetMs + 60_000;
  const url = `${BINANCE}/klines?symbol=BTCUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=2`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    // Klines schema: [openTime, open, high, low, close, volume, ...]
    return parseFloat(arr[0][4]);
  } catch { return null; }
}

// Batch-fetch klines for a range covering many samples in one call.
// 1000 klines = 1000 minutes ≈ 16.6 hours of coverage per request.
async function fetchKlineRange(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BINANCE}/klines?symbol=BTCUSDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) break;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    out.push(...arr.map((k) => ({ openTime: k[0], close: parseFloat(k[4]) })));
    const lastOpen = arr[arr.length - 1][0];
    cursor = lastOpen + 60_000;
    if (arr.length < 1000) break;
  }
  return out;
}

// Find the kline whose minute contains targetMs (or the next available).
function findKlineAt(klines, targetMs) {
  let best = null;
  for (const k of klines) {
    if (k.openTime <= targetMs && k.openTime + 60_000 > targetMs) return k;
    if (k.openTime >= targetMs && (!best || k.openTime < best.openTime)) best = k;
  }
  return best;
}

function bucketName(score) {
  if (score < 30) return '00-29 deep bear';
  if (score < 40) return '30-39 bearish';
  if (score < 50) return '40-49 mild bear';
  if (score < 60) return '50-59 neutral';
  if (score < 70) return '60-69 mild bull';
  return '70-100 bullish';
}

function reportHorizon(samples, horizonMin, klines) {
  const rows = [];
  for (const s of samples) {
    const sMs = new Date(s.ts).getTime();
    const targetMs = sMs + horizonMin * 60_000;
    const k = findKlineAt(klines, targetMs);
    if (!k || !Number.isFinite(k.close)) continue;
    const ret = k.close - s.price;
    const retPct = ret / s.price;
    const upDir = ret > 0;
    rows.push({ score: s.score, verdict: s.verdict, entryPrice: s.price, futurePrice: k.close, ret, retPct, upDir });
  }
  console.log(`\n═══ Horizon: ${horizonMin}min ═══`);
  console.log(`Paired samples: ${rows.length} / ${samples.length}`);
  if (!rows.length) return;
  const buckets = {};
  for (const r of rows) {
    const b = bucketName(r.score);
    (buckets[b] = buckets[b] || []).push(r);
  }
  const order = ['00-29 deep bear', '30-39 bearish', '40-49 mild bear', '50-59 neutral', '60-69 mild bull', '70-100 bullish'];
  console.log('BUCKET                  N      P(up)    mean ret      hit*');
  for (const name of order) {
    const xs = buckets[name];
    if (!xs) continue;
    const upRate = xs.filter((r) => r.upDir).length / xs.length;
    const meanRet = xs.reduce((s, r) => s + r.retPct, 0) / xs.length * 100;
    // "hit": did direction match the verdict's implied direction?
    // For mild bear/bearish, hit = down. For mild bull/bullish, hit = up.
    // Neutral has no directional hit; we report just P(up).
    let hitLabel = '—';
    if (name.includes('bull')) hitLabel = `${(upRate * 100).toFixed(1)}%`;
    else if (name.includes('bear')) hitLabel = `${((1 - upRate) * 100).toFixed(1)}%`;
    console.log(`  ${name.padEnd(22)}${String(xs.length).padStart(4)}    ${(upRate * 100).toFixed(1).padStart(5)}%   ${meanRet >= 0 ? '+' : ''}${meanRet.toFixed(3)}%     ${hitLabel}`);
  }
  console.log(`  (* hit = directional accuracy of bucket's verdict)`);
}

async function main() {
  const args = process.argv.slice(2);
  let sinceIso = null;
  const horizons = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') { sinceIso = args[++i]; continue; }
    const n = parseInt(args[i], 10);
    if (Number.isFinite(n) && n > 0) horizons.push(n);
  }
  if (!horizons.length) horizons.push(15);

  const samples = readSnapshots(sinceIso);
  console.log(`Loaded ${samples.length} samples${sinceIso ? ` since ${sinceIso}` : ''}`);
  if (!samples.length) { console.log('No samples to backtest.'); return; }

  const tsList = samples.map((s) => new Date(s.ts).getTime()).sort((a, b) => a - b);
  const earliestSample = tsList[0];
  const latestSample = tsList[tsList.length - 1];
  const maxHorizon = Math.max(...horizons) * 60_000;
  const startMs = earliestSample;
  const endMs = latestSample + maxHorizon + 60_000;
  console.log(`Fetching Binance klines ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);
  const klines = await fetchKlineRange(startMs, endMs);
  console.log(`Fetched ${klines.length} 1-min klines.`);
  if (!klines.length) { console.log('No kline data — can\'t pair samples.'); return; }

  for (const h of horizons) reportHorizon(samples, h, klines);
}

main().catch((e) => { console.error(e); process.exit(1); });
