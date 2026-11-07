-- Cadrage 2027 — schema
-- Deterministic tagging is done before insert; the UI only reads.
-- Every table is read-only for anon; writes go through the service role in the
-- ingestion edge function.

create extension if not exists "pgcrypto";

-- ── Candidates ────────────────────────────────────────────────────────────
create table if not exists public.candidates (
  id                text primary key,
  name              text not null,
  party             text not null,
  party_short       text,
  status            text not null check (status in ('declared', 'presumed', 'not_declared', 'not_declared_discussed')),
  tier              text not null check (tier in ('frontrunner', 'major', 'minor')),
  status_note       text,
  slogan            text,
  aliases           text[] not null default '{}',
  weak_aliases      text[] not null default '{}',
  party_signals     text[] not null default '{}',
  communities       text[] not null default '{}',
  status_checked_at timestamptz,
  created_at        timestamptz not null default now()
);

comment on column public.candidates.weak_aliases is
  'Surname-only forms. A hit is a weak mention, never counted as a strong one.';

-- ── Communities ───────────────────────────────────────────────────────────
create table if not exists public.communities (
  id         text primary key,
  name       text not null,
  type       text not null check (type in ('party', 'party_youth', 'union', 'student_union', 'ngo', 'think_tank', 'media', 'militant_collective', 'employer')),
  alignment  text not null,
  aliases    text[] not null default '{}',
  backs      text[] not null default '{}',
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists public.community_mentions (
  id           uuid primary key default gen_random_uuid(),
  video_id     text not null,
  community_id text not null references public.communities (id) on delete cascade,
  matched_terms text[] not null default '{}',
  source_key   text not null,
  occurrences  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  unique (video_id, community_id, source_key)
);

-- ── Videos ────────────────────────────────────────────────────────────────
create table if not exists public.videos (
  id                 text primary key,                 -- Oriane content id (cnt_…)
  platform           text not null check (platform in ('instagram', 'tiktok', 'youtube')),
  platform_id        text,
  url                text not null,
  creator_handle     text,
  creator_display_name text,
  creator_followers  bigint,
  creator_verified   boolean,
  posted_at          timestamptz,
  views              bigint,
  likes              bigint,
  shares             bigint,
  comments           bigint,
  interactions       bigint,
  title              text,
  caption            text,
  caption_language   text,
  transcript         text,
  transcript_language text,
  on_screen_text     text[] not null default '{}',
  visual_tags        text[] not null default '{}',
  platform_format    text check (platform_format in ('image', 'video', 'carousel')),
  format             text not null check (format in ('talking', 'image_post')),
  duration_seconds   numeric(10,2),
  thumbnail_url      text,
  is_french          boolean not null default false,
  party_signals      text[] not null default '{}',
  source             text not null default 'oriane',
  fetched_at         timestamptz default now()
);

comment on column public.videos.format is
  'idea.md rule: image/carousel, or a video with fewer than 40 transcripted words, is an image_post.';

create index if not exists videos_posted_at_idx on public.videos (posted_at desc);
create index if not exists videos_platform_idx on public.videos (platform);
create index if not exists videos_format_idx on public.videos (format);
create index if not exists videos_views_idx on public.videos (views desc nulls last);

-- ── Mentions (deterministic candidate matching) ───────────────────────────
create table if not exists public.mentions (
  id           uuid primary key default gen_random_uuid(),
  video_id     text not null references public.videos (id) on delete cascade,
  candidate_id text not null references public.candidates (id) on delete cascade,
  matched_terms text[] not null default '{}',
  source_field text not null check (source_field in ('caption', 'transcript', 'on_screen_text')),
  source_key   text not null,
  strength     text not null check (strength in ('strong', 'weak')),
  occurrences  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  unique (video_id, candidate_id, source_key)
);

create index if not exists mentions_candidate_idx on public.mentions (candidate_id, strength);
create index if not exists mentions_video_idx on public.mentions (video_id);

-- ── Analyses (offline LLM batch, verified) ────────────────────────────────
create table if not exists public.analyses (
  id               uuid primary key default gen_random_uuid(),
  video_id         text not null references public.videos (id) on delete cascade,
  candidate_id     text not null references public.candidates (id) on delete cascade,
  leaning          text not null check (leaning in ('favorable', 'critical', 'neutral', 'unclear')),
  evidence_quote   text,
  evidence_source  text check (evidence_source in ('caption', 'transcript', 'on_screen_text')),
  evidence_verified boolean not null default false,
  tone             text not null check (tone in ('informative', 'critical', 'mocking', 'alarmed', 'enthusiastic', 'personal')),
  confidence       text not null check (confidence in ('low', 'medium', 'high')),
  model            text,
  prompt_version   text not null default 'v1',
  created_at       timestamptz not null default now(),
  unique (video_id, candidate_id)
);

comment on column public.analyses.evidence_verified is
  'Exact substring match of evidence_quote inside evidence_source. Unverified labels must be hidden by the UI.';

create index if not exists analyses_candidate_idx on public.analyses (candidate_id, leaning);

create table if not exists public.claims (
  id           uuid primary key default gen_random_uuid(),
  video_id     text not null references public.videos (id) on delete cascade,
  candidate_id text not null references public.candidates (id) on delete cascade,
  claim_text   text not null,
  issue        text,
  evidence_quote text,
  evidence_verified boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists claims_candidate_idx on public.claims (candidate_id, issue);

-- ── Read models ───────────────────────────────────────────────────────────
-- Only verified labels and strong mentions feed the overview, so a card can
-- never outrun its evidence.

create or replace view public.candidate_overview as
select
  c.id,
  c.name,
  c.party_short,
  c.party,
  c.status,
  c.tier,
  c.slogan,
  count(distinct v.id)                                           as video_count,
  count(distinct v.id) filter (where a.leaning = 'favorable')     as favorable_count,
  count(distinct v.id) filter (where a.leaning = 'critical')      as critical_count,
  count(distinct v.id) filter (where a.leaning = 'neutral')       as neutral_count,
  count(distinct v.id) filter (where a.leaning = 'unclear')       as unclear_count,
  coalesce(sum(v.views), 0)                                      as total_views,
  coalesce(sum(v.interactions), 0)                               as total_interactions
from public.candidates c
left join public.mentions m
  on m.candidate_id = c.id and m.strength = 'strong'
left join public.videos v on v.id = m.video_id
left join public.analyses a
  on a.video_id = v.id and a.candidate_id = c.id and a.evidence_verified
group by c.id, c.name, c.party_short, c.party, c.status, c.tier, c.slogan;

-- The candidate page: one row per (video × candidate) with its verified label.
create or replace view public.candidate_column as
select
  m.candidate_id,
  v.id                as video_id,
  v.platform,
  v.url,
  v.format,
  v.platform_format,
  v.posted_at,
  v.views,
  v.interactions,
  v.creator_handle,
  v.creator_followers,
  v.caption,
  v.transcript,
  v.on_screen_text,
  m.source_field,
  m.source_key,
  m.occurrences,
  m.matched_terms,
  m.strength,
  coalesce(a.leaning, 'unclear')      as leaning,
  a.evidence_quote,
  a.evidence_source,
  coalesce(a.evidence_verified, false) as evidence_verified,
  coalesce(a.tone, 'informative')      as tone,
  coalesce(a.confidence, 'low')        as confidence
from public.mentions m
join public.videos v on v.id = m.video_id
left join public.analyses a on a.video_id = v.id and a.candidate_id = m.candidate_id
where v.is_french;

-- "Facts each side uses": claims grouped by candidate and leaning.
create or replace view public.facts_by_side as
select
  cl.candidate_id,
  coalesce(a.leaning, 'unclear') as leaning,
  cl.issue,
  cl.claim_text,
  count(*)                       as video_count,
  min(cl.video_id)               as example_video_id
from public.claims cl
left join public.analyses a on a.video_id = cl.video_id and a.candidate_id = cl.candidate_id
where cl.evidence_verified
group by cl.candidate_id, coalesce(a.leaning, 'unclear'), cl.issue, cl.claim_text
order by video_count desc;

-- ── Access ────────────────────────────────────────────────────────────────
alter table public.candidates     enable row level security;
alter table public.communities    enable row level security;
alter table public.community_mentions enable row level security;
alter table public.videos         enable row level security;
alter table public.mentions       enable row level security;
alter table public.analyses       enable row level security;
alter table public.claims         enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['candidates','communities','community_mentions','videos','mentions','analyses','claims']
  loop
    execute format('drop policy if exists "public read" on public.%I', tbl);
    execute format('create policy "public read" on public.%I for select using (true)', tbl);
  end loop;
end $$;

grant select on public.candidate_overview to anon, authenticated;
grant select on public.candidate_column to anon, authenticated;
grant select on public.facts_by_side to anon, authenticated;
