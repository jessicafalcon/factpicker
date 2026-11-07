-- Creator × candidate stance, produced by pipeline/etl.ts.
-- Counts come first; the index is a summary, not a verdict on the person.

create table if not exists public.creator_stance (
  creator_handle       text not null,
  candidate_id         text not null references public.candidates (id) on delete cascade,
  creator_display_name text,
  creator_followers    bigint,
  videos               integer not null check (videos > 0),
  favorable            integer not null default 0,
  critical             integer not null default 0,
  neutral              integer not null default 0,
  unclear              integer not null default 0,
  stance_index         numeric(5,3) not null default 0,
  view_weighted_index  numeric(6,3) not null default 0,
  avg_score            numeric(5,3) not null default 0,
  label                text not null check (label in (
                         'favorable','leaning_favorable','mixed','leaning_critical',
                         'critical','no_signal','single_video','insufficient')),
  total_views          bigint not null default 0,
  evidence             jsonb not null default '[]'::jsonb,
  computed_at          timestamptz not null default now(),
  primary key (creator_handle, candidate_id)
);

comment on column public.creator_stance.label is
  'single_video/insufficient mean the sample cannot support a creator-level stance; show the per-video label instead.';
comment on column public.creator_stance.stance_index is
  '(favorable - critical) / videos. Descriptive only: it never claims the creator is biased.';

create index if not exists creator_stance_candidate_idx
  on public.creator_stance (candidate_id, stance_index desc);
create index if not exists creator_stance_handle_idx
  on public.creator_stance (creator_handle);

-- Per-video scores, so a handle with one video still has a visible stance.
create table if not exists public.video_stance (
  video_id     text not null references public.videos (id) on delete cascade,
  candidate_id text not null references public.candidates (id) on delete cascade,
  score        numeric(5,3) not null,
  label        text not null check (label in ('favorable','critical','neutral','unclear')),
  basis        text not null,
  markers      text[] not null default '{}',
  quote        text,
  computed_at  timestamptz not null default now(),
  primary key (video_id, candidate_id)
);

-- Read model: creator stance joined with candidate metadata and per-candidate
-- totals, which is what the "who pushes this frame" panel needs.
create or replace view public.creator_candidate_stance as
select
  cs.creator_handle,
  cs.creator_display_name,
  cs.creator_followers,
  cs.candidate_id,
  c.name  as candidate_name,
  c.party_short,
  cs.videos,
  cs.favorable,
  cs.critical,
  cs.neutral,
  cs.unclear,
  cs.stance_index,
  cs.view_weighted_index,
  cs.avg_score,
  cs.label,
  cs.total_views,
  cs.evidence,
  cs.computed_at,
  round(100.0 * cs.favorable / nullif(cs.videos, 0), 1) as favorable_pct,
  round(100.0 * cs.critical / nullif(cs.videos, 0), 1)  as critical_pct
from public.creator_stance cs
join public.candidates c on c.id = cs.candidate_id
where cs.videos >= 2;

-- Handles that mostly repeat themselves on one candidate, ranked by reach.
create or replace view public.creator_stance_overview as
select
  creator_handle,
  candidate_id,
  candidate_name,
  videos,
  favorable,
  critical,
  stance_index,
  label,
  total_views
from public.creator_candidate_stance
order by total_views desc, abs(stance_index) desc;

alter table public.creator_stance enable row level security;
alter table public.video_stance   enable row level security;

drop policy if exists "public read" on public.creator_stance;
create policy "public read" on public.creator_stance for select using (true);

drop policy if exists "public read" on public.video_stance;
create policy "public read" on public.video_stance for select using (true);

grant select on public.creator_candidate_stance to anon, authenticated;
grant select on public.creator_stance_overview to anon, authenticated;

-- Candidate-level summary of the per-video stance labels: how much favourable
-- versus critical coverage each candidate gets, independent of the LLM layer.
create or replace view public.candidate_stance_summary as
select
  vs.candidate_id,
  c.name as candidate_name,
  c.party_short,
  count(*)                                                        as videos,
  count(*) filter (where vs.label = 'favorable')                   as favorable,
  count(*) filter (where vs.label = 'critical')                    as critical,
  count(*) filter (where vs.label = 'neutral')                     as neutral,
  count(*) filter (where vs.label = 'unclear')                     as unclear,
  round(
    (count(*) filter (where vs.label = 'favorable') - count(*) filter (where vs.label = 'critical'))::numeric
    / nullif(count(*) filter (where vs.label <> 'unclear'), 0), 3)  as stance_index,
  count(distinct v.creator_handle)                                as creators
from public.video_stance vs
join public.candidates c on c.id = vs.candidate_id
join public.videos v on v.id = vs.video_id
group by vs.candidate_id, c.name, c.party_short;

grant select on public.candidate_stance_summary to anon, authenticated;

