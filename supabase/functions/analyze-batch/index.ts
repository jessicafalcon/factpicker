/**
 * Supabase edge function: run the LLM framing extraction over stored pairs.
 *
 * Deploy:  supabase functions deploy analyze-batch
 * Invoke:  curl -X POST "$SUPABASE_URL/functions/v1/analyze-batch" \
 *            -H "Authorization: Bearer $INGEST_TOKEN" \
 *            -H "Content-Type: application/json" \
 *            -d '{"limit":20}'
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_API_KEY,
 *          LLM_BASE_URL (optional), LLM_MODEL (optional).
 *
 * Called repeatedly with a small limit: edge functions have a wall clock, and
 * the demo never calls an LLM at request time. Each run picks up pairs that do
 * not have a verified analysis yet.
 */
import { CANDIDATES_BY_ID, TOPICS } from "../_shared/candidates.ts";
import { buildPrompt, callLlm, mapWithConcurrency, parseAnalysis, verifyAnalysis } from "../_shared/analyze.ts";
import { createSupabaseStore } from "../_shared/store.ts";
import type { VideoRow } from "../_shared/types.ts";

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
  const limit = Math.min(Number(body.limit ?? 20), 60);
  const concurrency = Math.min(Number(body.concurrency ?? 3), 8);
  const redrive = body.redrive === true;

  const store = createSupabaseStore({
    url: Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  });

  const startedAt = Date.now();

  try {
    // Strong mentions only: a surname-only hit is not enough to ask for a leaning.
    const mentions = await store.select<any>(
      "mentions",
      "select=video_id,candidate_id,source_field,source_key&strength=eq.strong&order=created_at.desc&limit=2000",
    );
    const analyzed = await store.select<any>("analyses", "select=video_id,candidate_id&limit=5000");
    const done = new Set(analyzed.map((row) => `${row.video_id}|${row.candidate_id}`));

    const pairs = mentions
      .filter((mention) => redrive || !done.has(`${mention.video_id}|${mention.candidate_id}`))
      .filter((mention, index, all) => {
        const key = `${mention.video_id}|${mention.candidate_id}`;
        return all.findIndex((other) => `${other.video_id}|${other.candidate_id}` === key) === index;
      })
      .slice(0, limit);

    if (pairs.length === 0) return json({ ok: true, pairs: 0, message: "nothing pending" });

    const ids = [...new Set(pairs.map((pair) => pair.video_id))];
    const videos = await store.select<VideoRow>(
      "videos",
      `select=*&id=in.(${ids.map((id) => `"${id}"`).join(",")})`,
    );
    const videosById = new Map(videos.map((video) => [video.id, video]));

    const config = {
      baseUrl: Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1",
      apiKey: Deno.env.get("LLM_API_KEY") ?? "",
      model: Deno.env.get("LLM_MODEL") ?? "gemini-2.5-flash",
    };

    const analyses: any[] = [];
    const claims: any[] = [];
    const failures: any[] = [];

    await mapWithConcurrency(pairs, concurrency, async (pair) => {
      const video = videosById.get(pair.video_id);
      const candidate = CANDIDATES_BY_ID[pair.candidate_id];
      if (!video || !candidate) {
        failures.push({ ...pair, error: "video or candidate missing" });
        return;
      }
      try {
        const raw = await callLlm(config, buildPrompt(video, candidate));
        const verified = verifyAnalysis(video, candidate, parseAnalysis(raw), config.model);
        analyses.push(verified.analysis);
        claims.push(...verified.claims);
      } catch (error) {
        failures.push({ ...pair, error: (error as Error).message });
      }
    });

    const written = {
      analyses: analyses.length ? await store.upsert("analyses", analyses, "video_id,candidate_id") : 0,
      claims: claims.length ? await store.upsert("claims", claims, "video_id,candidate_id,claim_text") : 0,
    };

    return json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      pairs: pairs.length,
      verified: analyses.filter((analysis) => analysis.evidence_verified).length,
      written,
      failures,
      issues: Object.keys(TOPICS).length,
    });
  } catch (error) {
    return json({ ok: false, error: (error as Error).message, elapsedMs: Date.now() - startedAt }, 500);
  }
});
