/**
 * Supabase edge function: pull Oriane contents into the database.
 *
 * Deploy:  supabase functions deploy ingest-oriane
 * Invoke:  curl -X POST "$SUPABASE_URL/functions/v1/ingest-oriane" \
 *            -H "Authorization: Bearer $INGEST_TOKEN" \
 *            -H "Content-Type: application/json" \
 *            -d '{"perCandidate":30,"since":"2026-06-01"}'
 *
 * Secrets required: ORIANE_API, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Optional: INGEST_TOKEN (if set, callers must present it).
 *
 * Oriane's key never leaves this function: the browser only reads the tables.
 */
import { CANDIDATES, CANDIDATES_BY_ID } from "../_shared/candidates.ts";
import { createOrianeClient } from "../_shared/oriane.ts";
import { ingestWithMentions } from "../_shared/pipeline.ts";
import { createSupabaseStore } from "../_shared/store.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-ingest-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const token = Deno.env.get("INGEST_TOKEN");
  if (token && request.headers.get("x-ingest-token") !== token) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const perCandidate = Math.min(Number(body.perCandidate ?? 30), 100);
  const since = body.since ?? "2026-06-01";
  const sort = body.sort ?? "interactionsCount:desc,viewsCount:desc";
  const frenchOnly = body.frenchOnly !== false;

  const candidates = body.candidateIds?.length
    ? body.candidateIds.map((id: string) => CANDIDATES_BY_ID[id]).filter(Boolean)
    : CANDIDATES;
  if (candidates.length === 0) return json({ error: "no known candidate ids" }, 400);

  const client = createOrianeClient({ apiKey: Deno.env.get("ORIANE_API") ?? "" });
  const startedAt = Date.now();

  try {
    const result = await ingestWithMentions(client, candidates, {
      perCandidate,
      since,
      sort,
      projection: "full",
    });

    const videoIds = new Set(
      (frenchOnly ? result.videos.filter((video) => video.is_french) : result.videos).map((video) => video.id),
    );
    const videos = result.videos.filter((video) => videoIds.has(video.id));
    const mentions = result.mentions.filter((mention) => videoIds.has(mention.video_id));

    const store = createSupabaseStore({
      url: Deno.env.get("SUPABASE_URL") ?? "",
      serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    });

    const candidateRows = candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      party: candidate.party,
      party_short: candidate.partyShort ?? null,
      status: candidate.status,
      tier: candidate.tier,
      status_note: candidate.statusNote ?? null,
      slogan: candidate.slogan ?? null,
      aliases: candidate.aliases,
      weak_aliases: candidate.weakAliases,
      party_signals: candidate.partySignals,
      communities: candidate.communities,
      status_checked_at: new Date().toISOString(),
    }));

    const written = {
      candidates: await store.upsert("candidates", candidateRows, "id"),
      videos: await store.upsert("videos", videos, "id"),
      mentions: await store.upsert("mentions", mentions, "video_id,candidate_id,source_key"),
    };

    return json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      query: { perCandidate, since, sort, frenchOnly },
      stats: result.stats,
      written,
    });
  } catch (error) {
    return json({ ok: false, error: (error as Error).message, elapsedMs: Date.now() - startedAt }, 500);
  }
});
