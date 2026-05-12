-- paper_trades: Supabase table backing the btc-momentum paper trader.
-- Run this once in the Supabase SQL editor before the Render cron
-- ships, otherwise insert/update will 404.

create table if not exists paper_trades (
  surfaced_at              timestamptz not null,
  condition_id             text        not null,
  market                   text,
  side                     text        not null,
  entry_price              numeric,
  recommended_stake        numeric,
  model_score              integer,
  model_verdict            text,
  model_composite          numeric,
  model_price              numeric,
  horizon_min_at_surface   numeric,
  end_date                 timestamptz,
  rationale                text,
  resolved                 boolean     not null default false,
  winning_outcome          text,
  realized_pnl_usd         numeric,
  resolved_at              timestamptz,
  primary key (surfaced_at, condition_id, side)
);

create index if not exists paper_trades_resolved_idx on paper_trades (resolved);
create index if not exists paper_trades_end_date_idx on paper_trades (end_date);

-- Allow the anon key to read + write. Matches the btc_momentum table's
-- existing permissive policy. Tighten later if multi-tenant.
alter table paper_trades enable row level security;
drop policy if exists paper_trades_all on paper_trades;
create policy paper_trades_all on paper_trades for all using (true) with check (true);
