-- Live shared game: lets a second phone open and edit the same in-progress game.
-- Run once in the Supabase SQL Editor (Project -> SQL Editor -> New query). Safe to re-run.
--
-- Same trust model as the pay links: no login, anyone with a game's link can read
-- and edit it. There is no delete policy, so nothing here can be destroyed.

create table if not exists drafts (
  id text primary key,
  -- The whole in-progress game (settings + player rows); see src/draft.js.
  state jsonb not null,
  -- Bumped on every save. A phone only saves if the version it started from is
  -- still current; otherwise it merges the newer copy first (no silent overwrite).
  version integer not null default 1,
  -- The games.id this draft was published as, so every phone on the draft
  -- updates the same game and pay link instead of creating a second one.
  game_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table drafts enable row level security;

drop policy if exists "drafts_select_anon" on drafts;
drop policy if exists "drafts_insert_anon" on drafts;
drop policy if exists "drafts_update_anon" on drafts;
create policy "drafts_select_anon" on drafts for select to anon using (true);
create policy "drafts_insert_anon" on drafts for insert to anon with check (true);
create policy "drafts_update_anon" on drafts for update to anon using (true) with check (true);

-- Supabase no longer auto-grants Data API access to new public tables (2026-10-30).
grant select, insert, update on public.drafts to anon;

-- Live updates, so the other phone sees edits without refreshing.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'drafts'
  ) then
    alter publication supabase_realtime add table drafts;
  end if;
end $$;
