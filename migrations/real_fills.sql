-- Per-fill slippage record. Each row is one real CLOB order fill,
-- captured side-by-side with the price the UI showed at click time.
-- After ~30 fills, you can characterize realistic slippage and adjust
-- the Phase-3 auto-fire gate thresholds to compensate.

create table if not exists real_fills (
  id                    uuid primary key default gen_random_uuid(),
  fired_at              timestamptz not null default now(),
  source                text not null,                  -- 'manual_click' | 'auto_cron' (future)
  condition_id          text not null,
  market                text,
  side                  text not null,
  captured_entry_price  numeric,                        -- what the UI showed at click time
  actual_fill_price     numeric,                        -- what CLOB filled at (snapped tick)
  slippage_cents        numeric,                        -- (actual - captured) * 100
  shares_filled         numeric,
  usd_spent             numeric,
  fill_status           text,                           -- 'matched' | 'live' | etc.
  order_id              text,
  tx_hash               text
);

create index if not exists real_fills_condition_idx on real_fills (condition_id, side);
create index if not exists real_fills_fired_at_idx on real_fills (fired_at);

alter table real_fills enable row level security;
drop policy if exists real_fills_all on real_fills;
create policy real_fills_all on real_fills for all using (true) with check (true);
