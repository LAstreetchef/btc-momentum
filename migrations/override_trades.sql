-- Track real CLOB trades the user manually fires that the system
-- would have flagged or skipped. After ~5-10 overrides we can audit:
-- are you systematically right where the system is wrong? Which skip
-- flag is the false-positive (LOW_VOLUME / CATALYST_DAY / etc.)?
-- Adjust the corresponding threshold.
--
-- Populated by polymarket-trader server.js /place-selected handler
-- alongside the existing real_fills write.

create table if not exists override_trades (
  id              uuid primary key default gen_random_uuid(),
  fired_at        timestamptz not null default now(),
  condition_id    text not null,
  market          text,
  side            text not null,
  entry_price     numeric,
  stake_usd       numeric,
  cluster         text,                  -- 'btc-momentum' | 'mirror-swissmiss' | 'expiry-decay' | ...
  system_status   text not null,         -- 'fire' (system agreed) | 'skip_flagged' (system rejected)
  skip_reasons    text[],                -- e.g. ['LOW_VOLUME', 'CATALYST_DAY'] or ['skip · forward edge +2.1pp ...']
  order_id        text,
  tx_hash         text,
  fill_price      numeric
);

create index if not exists override_trades_status_idx on override_trades (system_status);
create index if not exists override_trades_cluster_idx on override_trades (cluster);

alter table override_trades enable row level security;
drop policy if exists override_trades_all on override_trades;
create policy override_trades_all on override_trades for all using (true) with check (true);
