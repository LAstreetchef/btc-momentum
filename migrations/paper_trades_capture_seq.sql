-- Allow paper_trades to capture the SAME (condition_id, side) multiple
-- times as the model conviction shifts. capture_seq tracks which
-- repeat-capture this is (1 = first sighting, 2 = first add-on, etc.).
--
-- Combined with dropping the dedup in src/paper-trader.js, this gives
-- us Phase 2 data on what adding-on to existing positions would have
-- done. Once that data shows pyramiding is +EV (or not), the auto-fire
-- path in Phase 3 can apply per-market position-size caps.

alter table paper_trades add column if not exists capture_seq integer default 1;
create index if not exists paper_trades_seq_idx on paper_trades (condition_id, side, capture_seq);
