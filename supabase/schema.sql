-- Poker Ledger: "share for payment" schema.
-- Run this once in the Supabase project's SQL Editor (Project → SQL Editor → New query).
--
-- Design: no auth/login. Anyone with a game's share link can view it and mark
-- any transaction paid/unpaid. That's a deliberate tradeoff for zero-friction
-- use among a small trusted group, not a general-purpose payments system.

create table if not exists games (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  date date,
  host text,
  ledger jsonb not null
);

create table if not exists payments (
  game_id text not null references games (id) on delete cascade,
  txn_key text not null,
  paid boolean not null default false,
  paid_at timestamptz,
  primary key (game_id, txn_key)
);

alter table games enable row level security;
alter table payments enable row level security;

-- The app's publishable key is meant to be public; these policies are what
-- actually scope its access. Anyone loading the page can create a game,
-- read any game by id, and refresh its ledger snapshot when host recalculates.
create policy "games_insert_anon" on games for insert to anon with check (true);
create policy "games_select_anon" on games for select to anon using (true);
create policy "games_update_anon" on games for update to anon using (true) with check (true);

-- Payment status is readable/writable by anyone with the game's link.
create policy "payments_select_anon" on payments for select to anon using (true);
create policy "payments_insert_anon" on payments for insert to anon with check (true);
create policy "payments_update_anon" on payments for update to anon using (true) with check (true);

-- Live updates so the host's own tab and everyone's phone stay in sync
-- without a manual refresh.
alter publication supabase_realtime add table payments;
