-- Expand paper_trades to capture the full feature vector at prediction
-- time, so Phase 2 can re-fit weights (not just thresholds) against
-- realized outcomes. Run this in the Supabase SQL editor.

alter table paper_trades
  -- Raw orderbook/flow features (what feeds into the sig_* signals)
  add column if not exists model_imbalance    numeric,
  add column if not exists model_depth_ratio  numeric,
  add column if not exists model_buy_pct      numeric,
  add column if not exists model_tick_dir     integer,
  add column if not exists model_spread       numeric,
  add column if not exists model_spread_pct   numeric,
  -- Normalized weighted signals (the 6 components of composite)
  add column if not exists model_sig_ob       numeric,
  add column if not exists model_sig_flow     numeric,
  add column if not exists model_sig_spread   numeric,
  add column if not exists model_sig_depth    numeric,
  add column if not exists model_sig_tick     numeric,
  add column if not exists model_sig_poly     numeric,
  -- Chainlink-aligned reference price + divergence at capture time
  add column if not exists model_ref_px       numeric,
  add column if not exists model_ref_spread   numeric;
