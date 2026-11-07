/**
 * Mirrors the local artifacts into Supabase Postgres via the Management API,
 * so a Lovable app can read them with supabase-js without the edge function.
 *
 * Tables (all public-read through RLS):
 *   fp_candidates · fp_videos · fp_stance
 *   fp_anatomy · fp_facts · fp_timelines · fp_behind   (JSON payloads, one row each)
 *   factpicker_behind                                   (flattened view for the strip)
 *
 * Run: npm run db:mirror
 */
import { createContext } from "../api/src/context.ts";
import { buildBehindTheNumbers, buildFact, buildFactTimeline } from "../api/src/derive.ts";
import { buildAnatomy, selectEntry } from "../api/src/anatomy.ts";
import { createEmbeddingClient, loadFromArtifacts } from "../api/src/sources.ts";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!ref) throw new Error("Set SUPABASE_PROJECT_REF before mirroring data.");
if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN is required (Management API, not the DB password).");
  process.exit(1);
}

const ENDPOINT = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function sql<T = any>(query: string): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${text.slice(0, 400)}\n---\n${query.slice(0, 200)}`);
  return (text ? JSON.parse(text) : []) as T;
}

const chunk = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
};

const dollar = (value: unknown) => `$fp$${JSON.stringify(value)}$fp$::jsonb`;

const dataset = loadFromArtifacts();
const ctx = createContext(dataset, createEmbeddingClient({}));

console.log("1/4  schema");
await sql(`
create table if not exists public.fp_candidates (
  id text primary key, name text not null, party text, party_short text, tier text,
  status text, communities text[]
);
create table if not exists public.fp_videos (
  id text primary key, platform text, url text, thumbnail_url text, posted_at timestamptz,
  views bigint, creator_handle text, creator_display_name text, creator_followers bigint,
  creator_verified boolean, format text, platform_format text, duration_seconds numeric,
  caption text, transcript text, on_screen_text text[], is_french boolean
);
create table if not exists public.fp_stance (
  video_id text, candidate_id text, label text, score numeric, quote text, basis text,
  evidence_mode text, primary key (video_id, candidate_id)
);
create table if not exists public.fp_anatomy (
  video_id text primary key, position int, quality numeric, payload jsonb not null
);
create table if not exists public.fp_facts (
  id text primary key, category text, statement text, videos int, payload jsonb not null
);
create table if not exists public.fp_timelines (
  fact_id text primary key, payload jsonb not null
);
create table if not exists public.fp_behind (
  position int primary key, payload jsonb not null
);
`);

console.log("2/4  payloads");
const entry = selectEntry(ctx.index, 6);
const anatomyRows = entry.map((item, position) => ({
  video_id: item.videoId,
  position,
  quality: item.quality,
  payload: item,
}));

const factRows = dataset.facts.map((fact) => {
  const built: any = buildFact(ctx.index, fact);
  // buildFact exposes the matching videos as `videos`; keep the count in the row
  // and the same number inside the payload so JSON consumers see an int.
  const count = Array.isArray(built.videos) ? built.videos.length : Number(built.videos ?? 0);
  return {
    id: fact.id,
    category: fact.category,
    statement: fact.statement,
    videoCount: count,
    payload: { ...built, videos: count },
  };
});

const timelineRows = dataset.facts.map((fact) => ({ fact_id: fact.id, payload: buildFactTimeline(ctx.index, fact, 3) }));
const behindRows = buildBehindTheNumbers(ctx.index, { limit: 6 }).map((item, position) => ({
  position,
  payload: { ...item, video: { id: item.video.id, url: item.video.url, thumbnailUrl: item.video.thumbnail_url, views: item.video.views, platform: item.video.platform, creator: { handle: item.video.creator_handle } } },
}));

const candidateRows = dataset.candidates.map((candidate: any) => ({
  id: candidate.id,
  name: candidate.name,
  party: candidate.party ?? null,
  party_short: candidate.partyShort ?? null,
  tier: candidate.tier ?? null,
  status: candidate.status ?? null,
  communities: candidate.communities ?? [],
}));

const videoRows = dataset.videos.map((video) => ({
  id: video.id,
  platform: video.platform,
  url: video.url,
  thumbnail_url: video.thumbnail_url,
  posted_at: video.posted_at,
  views: video.views,
  creator_handle: video.creator_handle,
  creator_display_name: video.creator_display_name,
  creator_followers: video.creator_followers,
  creator_verified: video.creator_verified,
  format: video.format,
  platform_format: video.platform_format,
  duration_seconds: video.duration_seconds,
  caption: video.caption,
  transcript: video.transcript,
  on_screen_text: video.on_screen_text ?? [],
  is_french: video.is_french,
}));

const stanceRows = dataset.stance.map((row) => ({
  video_id: row.video_id,
  candidate_id: row.candidate_id,
  label: row.label,
  score: row.score,
  quote: row.quote,
  basis: row.basis,
  evidence_mode: row.evidence_mode,
}));

console.log("3/4  load");
// Explicit record definitions: jsonb_populate_recordset matches by column name,
// and payload keys such as `videos` would collide with integer columns.
const load = async (
  table: string,
  columns: string,
  defs: string,
  rows: unknown[],
  size = 40,
  select = columns,
) => {
  await sql(`delete from public.${table};`);
  let written = 0;
  for (const part of chunk(rows, size)) {
    await sql(
      `insert into public.${table} (${columns}) select ${select} from jsonb_to_recordset(${dollar(part)}) as r(${defs});`,
    );
    written += part.length;
  }
  console.log(`     ${table.padEnd(14)} ${written}`);
};

await load("fp_candidates", "id,name,party,party_short,tier,status,communities",
  "id text, name text, party text, party_short text, tier text, status text, communities text[]", candidateRows, 40);
await load("fp_videos",
  "id,platform,url,thumbnail_url,posted_at,views,creator_handle,creator_display_name,creator_followers,creator_verified,format,platform_format,duration_seconds,caption,transcript,on_screen_text,is_french",
  "id text, platform text, url text, thumbnail_url text, posted_at timestamptz, views bigint, creator_handle text, creator_display_name text, creator_followers bigint, creator_verified boolean, format text, platform_format text, duration_seconds numeric, caption text, transcript text, on_screen_text text[], is_french boolean",
  videoRows, 25);
await load("fp_stance", "video_id,candidate_id,label,score,quote,basis,evidence_mode",
  "video_id text, candidate_id text, label text, score numeric, quote text, basis text, evidence_mode text", stanceRows, 120);
await load("fp_anatomy", "video_id,position,quality,payload",
  "video_id text, position int, quality numeric, payload jsonb", anatomyRows, 6);
await load("fp_facts", "id,category,statement,videos,payload",
  "id text, category text, statement text, videoCount int, payload jsonb", factRows, 6,
  "id,category,statement,videoCount,payload");
await load("fp_timelines", "fact_id,payload", "fact_id text, payload jsonb", timelineRows, 6);
await load("fp_behind", "position,payload", "position int, payload jsonb", behindRows, 6);

console.log("4/4  read access + view");
await sql(`
create or replace view public.factpicker_behind as
select
  position,
  payload->>'leaning'                                as leaning,
  payload#>>'{candidate,name}'                       as candidate,
  payload#>>'{fact,category}'                        as topic,
  payload#>>'{video,creator,handle}'                 as handle,
  payload#>>'{video,url}'                            as url,
  payload#>>'{video,thumbnailUrl}'                   as thumbnail_url,
  (payload#>>'{video,views}')::bigint                as views,
  payload                                            as payload
from public.fp_behind
order by position;

alter table public.fp_candidates enable row level security;
alter table public.fp_videos     enable row level security;
alter table public.fp_stance     enable row level security;
alter table public.fp_anatomy    enable row level security;
alter table public.fp_facts      enable row level security;
alter table public.fp_timelines  enable row level security;
alter table public.fp_behind     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fp_candidates','fp_videos','fp_stance','fp_anatomy','fp_facts','fp_timelines','fp_behind']
  loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
end $$;

grant select on public.fp_candidates, public.fp_videos, public.fp_stance, public.fp_anatomy,
  public.fp_facts, public.fp_timelines, public.fp_behind, public.factpicker_behind to anon, authenticated;
`);

const counts = await sql<{ table: string; rows: number }[]>(`
  select 'fp_candidates' as table, count(*)::int as rows from public.fp_candidates
  union all select 'fp_videos', count(*)::int from public.fp_videos
  union all select 'fp_stance', count(*)::int from public.fp_stance
  union all select 'fp_anatomy', count(*)::int from public.fp_anatomy
  union all select 'fp_facts', count(*)::int from public.fp_facts
  union all select 'fp_timelines', count(*)::int from public.fp_timelines
  union all select 'fp_behind', count(*)::int from public.fp_behind
`);
console.log(counts);
