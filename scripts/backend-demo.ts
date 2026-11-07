#!/usr/bin/env node
/**
 * Factpicker backend trace — one command, real artifacts, no invented numbers.
 *
 *   npm run demo:backend                  # replay + live read-only probes
 *   npm run demo:backend -- --live        # + one real Vertex classification
 *   npm run demo:backend -- --offline     # no network at all
 *   npm run demo:backend -- --refresh     # force fresh cloud telemetry
 *
 * The order is the argument of the demo:
 *   cloud telemetry → extract → transform (tag / embed / LLM / aggregate)
 *   → derive (anatomy / facts / timeline) → load → GraphQL → frontend handoff.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { buildTextBundle, findMarkers, LEXICON, scoreVideoForCandidate } from "../supabase/functions/_shared/sentiment.ts";
import { classifyFormat, normalizeText, scanCandidate } from "../supabase/functions/_shared/normalize.ts";
import { matchEvidence } from "../supabase/functions/_shared/stance-quality.ts";
import { buildBatchPrompt, classifyStance, shouldEscalate } from "../supabase/functions/_shared/vertex.ts";
import { videoText } from "../supabase/functions/_shared/embeddings.ts";
import { createEmbeddingClient, loadFromArtifacts, repoPath } from "../api/src/sources.ts";
import { createContext } from "../api/src/context.ts";
import { buildAnatomy, LEGEND, selectEntry } from "../api/src/anatomy.ts";
import { buildFact, buildFactTimeline } from "../api/src/derive.ts";
import { execute } from "../api/src/app.ts";
import { runEtl } from "../pipeline/etl.ts";
import { embedCorpus, HASH_MODEL, VERTEX_MODEL, type EmbeddingRun } from "../pipeline/embeddings.ts";
import { VectorStore, textSha } from "../pipeline/vector-store.ts";
import {
  countLine,
  gcloudAccessToken,
  gcloudProject,
  httpJson,
  probeCloud,
  renderTelemetry,
  TelemetryBook,
  type CloudProbeResult,
  type TelemetryEvent,
} from "../pipeline/telemetry.ts";
import { clean, formatCompact, formatInt, formatMs, formatSigned, sliceVisible, Ui, type Tone } from "./ui.ts";

// ── CLI ────────────────────────────────────────────────────────────────────

interface Options {
  live: boolean;
  liveEmbeddings: boolean;
  offline: boolean;
  refresh: boolean;
  skipEtl: boolean;
  maxCalls: number;
  embedLimit: number;
  video?: string;
  fact?: string;
  query: string;
  limit: number;
  report: string;
  telemetry: string;
  vectorPath: string;
  backend: "auto" | "sqlite" | "json";
  color?: boolean;
  width?: number;
}

function usage(): string {
  return [
    "factpicker backend trace",
    "",
    "  npm run demo:backend                 replay the pipeline, probe the cloud plane",
    "  npm run demo:backend -- --live       one real Vertex classification",
    "  npm run demo:backend -- --offline    no network; cached/local evidence only",
    "  npm run demo:backend -- --refresh    force fresh BigQuery / Supabase telemetry",
    "",
    "  --live-embeddings       use gemini-embedding-001 for a bounded sample",
    "  --embed-limit N         sample size for live embeddings (default 24)",
    "  --max-calls N           live Vertex calls (default 1)",
    "  --skip-etl              do not re-run the local deterministic ETL",
    "  --video ID              anatomy video (default: first entry card)",
    "  --fact ID               fact for readings and timeline",
    "  --query TEXT            vector search query",
    "  --limit N               rows per table / timeline moments (default 6)",
    "  --report PATH           JSON report path",
    "  --telemetry PATH        telemetry cache path",
    "  --backend sqlite|json   vector store backend",
    "  --width N               force the terminal measure",
    "  --no-color / --color    force colour off or on",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index++;
    } else {
      flags.add(key);
    }
  }
  return {
    live: flags.has("live"),
    liveEmbeddings: flags.has("live-embeddings"),
    offline: flags.has("offline"),
    refresh: flags.has("refresh"),
    skipEtl: flags.has("skip-etl"),
    maxCalls: Number(values.get("max-calls") ?? 1),
    embedLimit: Number(values.get("embed-limit") ?? 24),
    video: values.get("video"),
    fact: values.get("fact"),
    query: values.get("query") ?? "pouvoir d'achat et inflation",
    limit: Number(values.get("limit") ?? 6),
    report: values.get("report") ?? repoPath("data/analyses/backend-trace.json"),
    telemetry: values.get("telemetry") ?? repoPath("data/analyses/telemetry-cache.json"),
    vectorPath: values.get("vector-path") ?? repoPath("data/analyses/vector-index.db"),
    backend: (values.get("backend") as Options["backend"]) ?? "auto",
    color: flags.has("no-color") ? false : flags.has("color") ? true : undefined,
    width: values.has("width") ? Number(values.get("width")) : undefined,
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const fileTime = (path: string): string | null => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
};

const dateOnly = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "—");
const timeOnly = (iso: string | null | undefined): string => (iso ? iso.slice(11, 19) : "—");

const bytes = (value: number | undefined): string => {
  if (!value || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${Math.round(value)} B`;
};

const toneOfLabel = (label: string): Tone => {
  if (label === "favorable" || label === "leaning_favorable") return "favorable";
  if (label === "critical" || label === "leaning_critical") return "critical";
  if (label === "neutral" || label === "mixed") return "neutral";
  return "unclear";
};

const toneOfLeaning = (leaning: string): Tone => {
  const value = leaning?.toLowerCase();
  if (value === "favorable" || value === "for") return "favorable";
  if (value === "critical" || value === "against") return "critical";
  if (value === "neutral") return "neutral";
  return "unclear";
};

interface StageRecord {
  index: number;
  title: string;
  ms: number;
  status: "OK" | "FAIL";
}

interface SnapshotStats {
  files: number;
  rawRows: number;
  videos: Map<string, any>;
  unique: number;
  french: number;
  dropped: number;
  mentionRows: number;
  mentions: number;
  strong: number;
  weak: number;
  candidateMentions: Map<string, number>;
  candidateVideos: Map<string, Set<string>>;
  sample: any | null;
  sampleHits: Array<{ candidate: any; term: string; strength: string; start: number; end: number }>;
  sourcePath: string;
  mtime: string | null;
}

let snapshotCache: SnapshotStats | null = null;

function loadSnapshot(): SnapshotStats {
  if (snapshotCache) return snapshotCache;
  const dir = repoPath("data/oriane");
  const files = readdirSync(dir).filter(
    (file) => file.endsWith(".json") && !file.startsWith("_") && file !== "top10-all.json",
  );
  const videos = new Map<string, any>();
  const mentionKeys = new Set<string>();
  let rawRows = 0;
  let mentionRows = 0;
  let strong = 0;
  let weak = 0;
  const candidateMentions = new Map<string, number>();
  const candidateVideos = new Map<string, Set<string>>();
  const strongVideoIds = new Set<string>();

  for (const file of files) {
    const payload = readJson<any>(`${dir}/${file}`, null);
    if (!payload) continue;
    for (const video of payload.videos ?? []) {
      rawRows++;
      videos.set(video.id, video);
    }
    for (const mention of payload.mentions ?? []) {
      mentionRows++;
      const key = `${mention.video_id}|${mention.candidate_id}|${mention.source_key ?? mention.source_field}`;
      if (mentionKeys.has(key)) continue;
      mentionKeys.add(key);
      if (mention.strength === "strong") {
        strong++;
        strongVideoIds.add(mention.video_id);
      } else {
        weak++;
      }
      candidateMentions.set(mention.candidate_id, (candidateMentions.get(mention.candidate_id) ?? 0) + 1);
      const set = candidateVideos.get(mention.candidate_id) ?? new Set<string>();
      set.add(mention.video_id);
      candidateVideos.set(mention.candidate_id, set);
    }
  }

  const all = [...videos.values()];
  const french = all.filter((video) => video.is_french);
  const sample =
    french.find(
      (video) =>
        strongVideoIds.has(video.id) &&
        /[ÉÈÀÇÊÎÔÛ]/i.test(video.caption ?? "") &&
        (video.caption ?? "").length > 30,
    ) ??
    french.find((video) => strongVideoIds.has(video.id) && (video.caption ?? "").length > 30) ??
    french.find((video) => (video.caption ?? "").length > 30) ??
    french[0] ??
    null;

  let sampleHits: SnapshotStats["sampleHits"] = [];
  if (sample) {
    const text = [sample.caption ?? "", ...(sample.on_screen_text ?? []), sample.transcript ?? ""].join("\n");
    for (const candidate of CANDIDATES) {
      for (const hit of scanCandidate(text, candidate)) {
        for (const occurrence of hit.occurrences.slice(0, 1)) {
          sampleHits.push({ candidate, term: hit.term, strength: hit.strength, start: occurrence.start, end: occurrence.end });
        }
      }
    }
    sampleHits = sampleHits.sort((a, b) => a.start - b.start).slice(0, 3);
  }

  snapshotCache = {
    files: files.length,
    rawRows,
    videos,
    unique: all.length,
    french: french.length,
    dropped: all.length - french.length,
    mentionRows,
    mentions: mentionKeys.size,
    strong,
    weak,
    candidateMentions,
    candidateVideos,
    sample,
    sampleHits,
    sourcePath: "data/oriane/*.json",
    mtime: fileTime(`${dir}/top10-all.json`),
  };
  return snapshotCache;
}
interface StanceDoc {
  generatedAt?: string;
  method?: Record<string, any>;
  candidates: any[];
  videos: any[];
  creators: any[];
}

function loadStanceDoc(): StanceDoc {
  const preferred = repoPath("data/analyses/runs/v2-fuzzy/candidate-stance.json");
  const fallback = repoPath("data/analyses/candidate-stance.json");
  const doc = readJson<StanceDoc>(existsSync(preferred) ? preferred : fallback, {
    candidates: [],
    videos: [],
    creators: [],
  });
  return doc;
}

function loadVertexCache(): Record<string, any> {
  return readJson<Record<string, any>>(repoPath("data/analyses/.vertex-cache.json"), {});
}

function pickExample(stance: StanceDoc, videosById: Map<string, any>) {
  const candidates = [...stance.videos]
    .filter((row) => row.label !== "unclear" && row.quote && Math.abs(row.score ?? 0) > 0.1)
    .sort((a, b) => Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0));
  for (const row of candidates) {
    const video = videosById.get(row.video_id);
    const candidate = CANDIDATES_BY_ID[row.candidate_id];
    if (video && candidate) return { row, video, candidate };
  }
  return null;
}

/**
 * The live probe should land on a post a human can judge in one read: the
 * candidate is named and the caption carries an explicit stance marker. Satire
 * is penalised because a single call is not the place to explain irony.
 */
function pickLiveExample(stance: StanceDoc, videosById: Map<string, any>) {
  const attack = /\b(menteu|menteuse|honte|dangereu|corrompu|incompétent|incompetent|scandale|catastroph|trahi|complot|antivax|nul|incapable|escroc|arnaque)\b/i;
  const support = /\b(soutien|soutiens|vote pour|courage|bravo|respect|meilleur|capable|fierté|fierte)\b/i;
  const satire = /\b(gorafi|parodie|humour|sarcasme|ironie|second degré)\b/i;
  let best: { row: any; video: any; candidate: any } | null = null;
  let bestScore = -Infinity;
  for (const row of stance.videos) {
    if (row.label === "unclear" || !row.quote) continue;
    const video = videosById.get(row.video_id);
    const candidate = CANDIDATES_BY_ID[row.candidate_id];
    if (!video || !candidate) continue;
    const text = `${video.caption ?? ""} ${(video.on_screen_text ?? []).join(" ")}`;
    const normalized = normalizeText(text);
    const lastName = normalizeText(candidate.name).split(" ").pop() ?? "";
    const score =
      Math.abs(row.score ?? 0) * 2 +
      (attack.test(text) ? 4 : 0) +
      (support.test(text) ? 2 : 0) +
      (lastName && normalized.includes(lastName) ? 2 : 0) -
      (satire.test(text) ? 4 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { row, video, candidate };
    }
  }
  return best;
}

function progressLine(ui: Ui, label: string, done: number, total: number, lastLength: number): number {
  if (!process.stdout.isTTY) return 0;
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round((done / Math.max(1, total)) * width)));
  const line = `\r  ${ui.paint(label, "dim")} ${ui.paint("█".repeat(filled) + "░".repeat(width - filled), "accent")} ${done}/${total}`;
  process.stdout.write(line + " ".repeat(Math.max(0, lastLength - line.length)));
  return line.length;
}

function clearProgress(lastLength: number): void {
  if (process.stdout.isTTY && lastLength > 0) process.stdout.write(`\r${" ".repeat(lastLength + 2)}\r`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  try {
    if (!process.env.SUPABASE_URL) process.loadEnvFile(repoPath(".env"));
  } catch {
    // Env is optional; the trace is offline-safe.
  }

  const ui = new Ui({ color: options.color, width: options.width });
  const stages: StageRecord[] = [];
  const runEvents = new TelemetryBook();
  const report: Record<string, any> = {
    generatedAt: new Date().toISOString(),
    version: "backend-trace/1.0",
    command: process.argv.slice(2),
    modes: {
      probes: options.offline ? "offline" : options.refresh ? "live-refresh" : "live-or-cache",
      llm: options.live ? "live-vertex" : "replay-cache",
      embeddings: options.liveEmbeddings ? "vertex" : "hashed-offline",
      cloudRun: "read-only footprint",
    },
  };

  const project = options.offline ? null : gcloudProject();
  if (!options.offline && !project) {
    throw new Error("No GCP project configured. Set GCP_PROJECT or run with --offline.");
  }
  const token = options.offline ? null : gcloudAccessToken();
  const dataset = loadFromArtifacts();
  const stanceDoc = loadStanceDoc();
  const vertexCache = loadVertexCache();
  const videosById = new Map(dataset.videos.map((video) => [video.id, video]));
  const frenchVideos = dataset.videos.filter((video) => video.is_french);
  let context: ReturnType<typeof createContext> | null = null;

  // ── Boot ────────────────────────────────────────────────────────────────
  console.log(`\n${ui.paint("FACTPICKER", "accent", { bold: true })}  ${ui.paint("/", "faint")}  ${ui.paint("BACKEND TRACE", "ink", { bold: true })}`);
  console.log(ui.paint("How the GraphQL read model is made — from cloud log to frontend contract.", "dim"));
  console.log("");
  console.log(
    ui.kv([
      ["run", `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · node ${process.version.replace("v", "")}`],
      ["project", project ?? "not configured"],
      ["dataset", `${formatInt(dataset.videos.length)} videos · ${formatInt(frenchVideos.length)} French · ${formatInt(dataset.stance.length)} stance rows · ${formatInt(dataset.events.events.length)} events · ${formatInt(dataset.facts.length)} anchor facts`],
      ["window", `${dataset.events.window.first} → ${dataset.events.window.last}`],
      ["mode", `${options.offline ? "offline" : token ? "live probes available" : "cached / local only"} · ${options.live ? "live Vertex call" : "LLM replay"} · ${options.liveEmbeddings ? "Vertex embeddings" : "hashed vectors"}`],
    ]),
  );
  console.log(ui.note("Every number in this trace comes from an artifact or a live read-only API. The Cloud Run job is reported as missing, not invented."));

  const runStage = async <T>(title: string, subtitle: string | undefined, fn: () => Promise<T> | T): Promise<T> => {
    const index = stages.length + 1;
    console.log(ui.stage(index, title, subtitle));
    const started = performance.now();
    try {
      const result = await fn();
      stages.push({ index, title, ms: performance.now() - started, status: "OK" });
      return result;
    } catch (error) {
      stages.push({ index, title, ms: performance.now() - started, status: "FAIL" });
      console.log(ui.error((error as Error).message));
      throw error;
    }
  };

  // ── 01 · Cloud telemetry ────────────────────────────────────────────────
  const cloud: CloudProbeResult = await runStage("CLOUD TELEMETRY", "real logs, read-only", async () => {
    const probe = await probeCloud({
      project: project ?? "unconfigured",
      token,
      cachePath: options.telemetry,
      refresh: options.refresh && !options.offline,
    });

    const artifacts = new TelemetryBook();
    const cacheKeys = Object.keys(vertexCache);
    const cacheVideos = new Set(cacheKeys.map((key) => key.split("|")[0]));
    const verified = cacheKeys.filter((key) => vertexCache[key]?.evidence_verified).length;
    artifacts.add({
      at: stanceDoc.generatedAt ?? new Date().toISOString(),
      service: "vertex-ai",
      operation: "batch classify (artifact)",
      status: "RECORDED",
      durationMs: null,
      detail: `${cacheKeys.length} verdicts · ${cacheVideos.size} videos · ${stanceDoc.method?.model ?? "gemini-2.5-flash"} · ${verified} exact quotes`,
    });
    const lastLive = readJson<any>(repoPath("data/analyses/vertex-telemetry.json"), null);
    if (!options.live && lastLive?.at) {
      report.liveVertex = lastLive;
      artifacts.add({
        at: lastLive.at,
        service: "vertex-ai",
        operation: "generateContent (last live)",
        status: "RECORDED",
        durationMs: lastLive.latencyMs ?? null,
        detail: `${lastLive.candidate ?? "sample"} · ${lastLive.stance} ${formatSigned(Number(lastLive.score ?? 0))} · ${formatInt(lastLive.usage?.totalTokens)} tokens · quote ${lastLive.evidenceVerified ? "verified" : "rejected"}`,
      });
    }
    artifacts.add({
      at: stanceDoc.generatedAt ?? new Date().toISOString(),
      service: "etl",
      operation: "stance artifact",
      status: "RECORDED",
      durationMs: null,
      detail: `${stanceDoc.videos.length} video×candidate rows · ${stanceDoc.creators.length} creator rows · ${stanceDoc.candidates.length} candidates`,
    });
    const storePath = options.liveEmbeddings ? options.vectorPath.replace(/\.db$/, "-vertex.db") : options.vectorPath;
    if (existsSync(storePath)) {
      const store = await VectorStore.open({ path: storePath, model: options.liveEmbeddings ? VERTEX_MODEL : HASH_MODEL, backend: options.backend });
      const stats = store.stats();
      store.close();
      artifacts.add({
        at: stats.builtAt || new Date().toISOString(),
        service: "vector-db",
        operation: "index status",
        status: stats.vectors > 0 ? "RECORDED" : "MISSING",
        durationMs: null,
        detail: `${stats.vectors} vectors · ${stats.dims} dims · ${stats.backend} · ${bytes(stats.bytes)}`,
      });
    } else {
      artifacts.add({
        at: new Date().toISOString(),
        service: "vector-db",
        operation: "index status",
        status: "MISSING",
        durationMs: null,
        detail: "not built yet · stage 04 builds it",
      });
    }
    artifacts.add({
      at: loadSnapshot().mtime ?? new Date().toISOString(),
      service: "oriane",
      operation: "snapshot on disk",
      status: "RECORDED",
      durationMs: null,
      detail: `${loadSnapshot().files} candidate files · ${loadSnapshot().unique} videos · ${loadSnapshot().mentions} unique mention pairs`,
    });

    console.log(ui.note("Production footprint. These are read-only probes; cached captures replay with the original evidence."));
    console.log(renderTelemetry(ui, probe.events, { title: "cloud services" }));
    console.log(renderTelemetry(ui, artifacts.events, { title: "recorded artifacts" }));

    if (options.live && token && project) {
      const example = pickLiveExample(stanceDoc, videosById);
      if (example) {
        console.log(ui.note("One bounded live Vertex call. This is the only model spend in the trace."));
        try {
          const result = await classifyStance({
            candidateName: example.candidate.name,
            handle: example.video.creator_handle ?? "unknown",
            video: example.video,
            deterministicScore: example.row.score,
            config: { project, location: "us-central1", model: "gemini-2.5-flash", accessToken: token, timeoutMs: 45_000 },
          });
          const liveEvent: TelemetryEvent = {
            at: new Date().toISOString(),
            service: "vertex-ai",
            operation: "generateContent (live)",
            status: "LIVE",
            durationMs: result.latencyMs ?? null,
            detail:
              `${example.candidate.name} · ${result.stance} ${formatSigned(result.score)} · ` +
              `${result.usage?.totalTokens ?? "?"} tokens · quote ${result.evidence_verified ? "verified" : "rejected"}`,
          };
          runEvents.add(liveEvent);
          console.log(renderTelemetry(ui, [liveEvent]));
          report.liveVertex = {
            candidate: example.candidate.id,
            video: example.video.id,
            stance: result.stance,
            score: result.score,
            evidenceVerified: result.evidence_verified,
            usage: result.usage,
            latencyMs: result.latencyMs,
            requestId: result.requestId,
          };
          writeFileSync(
            repoPath("data/analyses/vertex-telemetry.json"),
            JSON.stringify({ at: liveEvent.at, ...report.liveVertex }, null, 2),
          );
        } catch (error) {
          console.log(ui.warn(`Live Vertex call failed: ${(error as Error).message.slice(0, 220)}`));
        }
      }
    }

    const supabase = probe.facts.supabase;
    const bigquery = probe.facts.bigquery;
    console.log("");
    console.log(
      ui.kv([
        [probe.fromCache ? "REAL · cached" : "REAL", `BigQuery ${formatInt(bigquery?.rows)} rows · LOAD ${bigquery?.loadMs ? formatMs(bigquery.loadMs) : "—"} · Supabase GraphQL ${supabase?.apiVersion ? `v${supabase.apiVersion}` : "unverified"}`],
        ["RECORDED", `Vertex ${cacheKeys.length} verdicts · stance ${stanceDoc.videos.length} rows · Oriane ${loadSnapshot().files} files`],
        ["DERIVED", `vector index ${options.liveEmbeddings ? "vertex sample" : "hashed"} · ${formatInt(frenchVideos.length)} source videos`],
        [probe.facts.cloudRun?.found ? "DEPLOYED" : "MISSING", probe.facts.cloudRun?.found ? `Cloud Run cadrage2027-stance · ${probe.facts.cloudRun.regions.join(", ")}` : "Cloud Run cadrage2027-stance · no execution in this project"],
      ]),
    );

    report.telemetry = {
      cloud: probe.events,
      artifacts: artifacts.events,
      capturedAt: probe.capturedAt,
      fromCache: probe.fromCache,
      facts: probe.facts,
    };
    return probe;
  });

  // ── 02 · Extract ────────────────────────────────────────────────────────
  const snapshot = await runStage("EXTRACT", "oriane snapshot · no API calls", () => {
    const stats = loadSnapshot();
    const started = performance.now();
    console.log(
      ui.kv([
        ["source", `${stats.sourcePath} · ${stats.files} candidate files`],
        ["raw rows", `${formatInt(stats.rawRows)} video rows`],
        ["unique", `${formatInt(stats.unique)} by video id · ${formatInt(stats.rawRows - stats.unique)} duplicates across files`],
        ["language", `${formatInt(stats.french)} French kept · ${formatInt(stats.dropped)} dropped`],
        ["mentions", `${formatInt(stats.mentions)} unique pairs · ${formatInt(stats.strong)} strong · ${formatInt(stats.weak)} weak`],
        ["candidates", `${formatInt(stats.candidateMentions.size)} with coverage`],
      ]),
    );

    const coverage = [...stats.candidateVideos.entries()]
      .map(([id, videos]) => ({ id, videos: videos.size, mentions: stats.candidateMentions.get(id) ?? 0 }))
      .sort((a, b) => b.videos - a.videos || b.mentions - a.mentions)
      .slice(0, 8);
    const max = coverage[0]?.videos ?? 1;
    console.log(ui.step("coverage by candidate"));
    console.log(
      ui.table(
        [
          { label: "candidate", max: 14 },
          { label: "videos", align: "right" },
          { label: "mentions", align: "right" },
          { label: "share", max: 16 },
        ],
        coverage.map((row) => [
          row.id,
          formatInt(row.videos),
          formatInt(row.mentions),
          `${ui.bar(row.videos, max, 10, "accent")} ${Math.round((row.videos / Math.max(1, stats.french)) * 100)}%`,
        ]),
      ),
    );

    if (stats.sample) {
      const sample = stats.sample;
      const ruleFormat = classifyFormat(sample.platform_format, sample.transcript);
      const hit = stats.sampleHits[0];
      console.log(ui.step("one record, before and after normalization"));
      console.log(
        ui.kv([
          ["raw caption", sliceVisible(clean(sample.caption ?? "(none)"), 84)],
          ["normalized", sliceVisible(normalizeText(sample.caption), 84)],
          ["format", `stored ${sample.format} · rule ${ruleFormat}${sample.format === ruleFormat ? "" : " · differs"}`],
          ["mention", hit ? `${hit.candidate.id} ← "${hit.term}" (${hit.strength}, offset ${hit.start})` : "none"],
        ]),
      );
    }

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "oriane",
      operation: "extract snapshot",
      status: "DERIVED",
      durationMs: ms,
      detail: `${stats.files} files → ${stats.rawRows} rows → ${stats.unique} unique → ${stats.french} French · ${stats.mentions} mention pairs`,
    });
    report.extract = {
      files: stats.files,
      rawRows: stats.rawRows,
      unique: stats.unique,
      french: stats.french,
      dropped: stats.dropped,
      mentions: stats.mentions,
      strong: stats.strong,
      weak: stats.weak,
      candidates: stats.candidateMentions.size,
    };
    return stats;
  });

  // ── 03 · Transform: tags ────────────────────────────────────────────────
  const tagStats = await runStage("TRANSFORM · TAG", "deterministic first", () => {
    const started = performance.now();
    const example = pickExample(stanceDoc, videosById);
    if (!example) throw new Error("No decisive stance example in the artifact");

    const deterministic = scoreVideoForCandidate(example.video, example.candidate, CANDIDATES);
    const markers = deterministic.markers.slice(0, 5);
    console.log(
      ui.kv([
        ["video", `@${example.video.creator_handle} · ${example.video.platform} · ${formatCompact(example.video.views)} views`],
        ["text", sliceVisible(clean(example.video.caption || example.video.transcript || "(no text)"), 82)],
        ["markers", markers.length ? markers.map((marker) => `${marker.term} ${marker.polarity === "positive" ? "+" : "−"}${marker.weight}${marker.negated ? " (negated)" : ""}`).join(" · ") : "none"],
        ["score", `${formatSigned(deterministic.score)} → ${deterministic.unclear ? "UNCLEAR" : deterministic.score >= 0.15 ? "FAVORABLE" : deterministic.score <= -0.15 ? "CRITICAL" : "NEUTRAL"}`],
        ["basis", `${deterministic.basis} · ${deterministic.confidence} confidence`],
      ]),
    );
    if (deterministic.quote) console.log(ui.quote(deterministic.quote, "lexicon evidence"));

    const sampleRows = stanceDoc.videos.filter((_, index) => index % Math.max(1, Math.floor(stanceDoc.videos.length / 40)) === 0).slice(0, 40);
    const policy = { no_lexicon_signal: 0, conflicting_markers: 0, deterministic_confident: 0 };
    for (const row of sampleRows) {
      const video = videosById.get(row.video_id);
      const candidate = CANDIDATES_BY_ID[row.candidate_id];
      if (!video || !candidate) continue;
      const score = scoreVideoForCandidate(video, candidate, CANDIDATES);
      const decision = shouldEscalate({ unclear: score.unclear, positive: score.positive, negative: score.negative });
      policy[decision.reason as keyof typeof policy] += 1;
    }
    console.log(ui.step("escalation policy · 40-row sample"));
    console.log(
      ui.table(
        [
          { label: "reason", max: 28 },
          { label: "action", max: 10 },
          { label: "rows", align: "right" },
        ],
        [
          ["no lexicon signal", "escalate", formatInt(policy.no_lexicon_signal)],
          ["conflicting markers", "escalate", formatInt(policy.conflicting_markers)],
          ["deterministic confident", "skip", formatInt(policy.deterministic_confident)],
        ],
      ),
    );

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "etl",
      operation: "deterministic tag",
      status: "DERIVED",
      durationMs: ms,
      detail: `${LEXICON.length} weighted markers · sentence anchoring · ${policy.no_lexicon_signal + policy.conflicting_markers}/${sampleRows.length} sampled rows escalate`,
    });
    report.tag = { lexicon: LEXICON.length, sampleRows: sampleRows.length, policy };
    return { example, deterministic, policy };
  });

  // ── 04 · Transform: embeddings + vector store ───────────────────────────
  const vector = await runStage("TRANSFORM · EMBED", "embedding generation → vector db", async () => {
    const started = performance.now();
    const useVertex = options.liveEmbeddings && !options.offline;
    const liveToken = useVertex ? gcloudAccessToken() : null;
    const chosen = (useVertex ? [...frenchVideos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, options.embedLimit) : frenchVideos).filter(
      (video) => videoText(video).trim().length > 0,
    );
    const texts = chosen.map((video) => videoText(video));
    let run: EmbeddingRun;
    try {
      if (useVertex && (!liveToken || !project)) throw new Error("Vertex embeddings need ADC and a GCP project");
      run = await embedCorpus(texts, {
        mode: useVertex ? "vertex" : "hash",
        model: useVertex ? VERTEX_MODEL : HASH_MODEL,
        project: project ?? undefined,
        accessToken: liveToken ?? undefined,
        cachePath: repoPath("api/.cache/embeddings.json"),
        concurrency: 4,
      });
    } catch (error) {
      console.log(ui.warn(`Vertex embeddings failed, using the hashed fallback: ${(error as Error).message.slice(0, 180)}`));
      run = await embedCorpus(texts, {
        mode: "hash",
        model: HASH_MODEL,
        cachePath: repoPath("api/.cache/embeddings.json"),
      });
    }

    const storePath = run.mode === "vertex" ? options.vectorPath.replace(/\.db$/, "-vertex.db") : options.vectorPath;
    const store = await VectorStore.open({ path: storePath, model: run.model, backend: options.backend });
    const reused = chosen.filter((video) => store.has(textSha(videoText(video)))).length;
    const upsertStarted = performance.now();
    store.upsert(chosen.map((video, index) => ({ videoId: video.id, text: videoText(video), vector: run.vectors[index] })));
    const upsertMs = performance.now() - upsertStarted;
    const stats = store.stats();

    console.log(
      ui.kv([
        ["backend", `${stats.backend} · ${stats.path.replace(repoPath() + "/", "")}`],
        ["model", run.mode === "vertex" ? `${run.model} · vertex` : `${run.model} · offline lexical fallback`],
        ["vectors", `${formatInt(stats.vectors)} · ${formatInt(stats.dims)} dims · ${bytes(stats.bytes)}`],
        ["rebuild", `${formatInt(chosen.length - reused)} embedded · ${formatInt(reused)} reused · ${formatMs(run.latencyMs)}`],
        ["api", run.mode === "vertex" ? `${run.apiCalls} batch call(s) · ${run.cacheHits} cache hit(s)` : "0 calls · deterministic"],
        ["schema", "vectors(video_id PK, text_sha, dims, vector BLOB)"],
      ]),
    );

    const queryVector = (await embedCorpus([options.query], {
      mode: run.mode,
      model: run.model,
      project: project ?? undefined,
      accessToken: useVertex ? liveToken ?? undefined : undefined,
      cachePath: repoPath("api/.cache/embeddings.json"),
    })).vectors[0];
    const hits = store.search(queryVector, 5);
    console.log(ui.step(`nearest to "${sliceVisible(options.query, 56)}"`));
    console.log(
      ui.table(
        [
          { label: "#", align: "right", max: 2 },
          { label: "score", align: "right", max: 6 },
          { label: "creator", max: 18 },
          { label: "caption", max: 48 },
          { label: "views", align: "right", max: 7 },
        ],
        hits.map((hit, index) => {
          const video = videosById.get(hit.videoId);
          return [
            String(index + 1),
            hit.score.toFixed(3),
            video?.creator_handle ?? "—",
            sliceVisible(clean(video?.caption || video?.transcript || ""), 48),
            formatCompact(video?.views),
          ];
        }),
      ),
    );

    let closest: { a: any; b: any; score: number } | null = null;
    for (const video of chosen) {
      const [nearest] = store.nearest(video.id, 1);
      if (nearest && (!closest || nearest.score > closest.score)) {
        closest = { a: video, b: videosById.get(nearest.videoId), score: nearest.score };
      }
    }
    if (closest) {
      console.log(
        ui.note(
          `closest pair ${closest.score.toFixed(3)} · @${closest.a.creator_handle} ↔ @${closest.b?.creator_handle ?? "?"} · ` +
            sliceVisible(clean(closest.a.caption || closest.a.transcript || ""), 62),
        ),
      );
    }
    if (run.mode === "hash") {
      console.log(ui.note("Hashed vectors are lexical. --live-embeddings swaps in gemini-embedding-001 for a bounded sample; the store interface is identical."));
    }

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: run.mode === "vertex" ? "vertex-ai" : "vector-db",
      operation: "embed corpus",
      status: run.mode === "vertex" ? "LIVE" : "DERIVED",
      durationMs: run.latencyMs,
      detail: `${formatInt(texts.length)} texts · ${run.apiCalls} call(s) · ${run.cacheHits} cache hit(s) · ${formatInt(run.dims)} dims`,
    });
    runEvents.add({
      at: new Date().toISOString(),
      service: "vector-db",
      operation: run.mode === "vertex" ? "vertex upsert" : "hash upsert",
      status: "DERIVED",
      durationMs: upsertMs,
      detail: `${formatInt(stats.vectors)} vectors · ${formatInt(stats.dims)} dims · ${stats.backend} · ${bytes(stats.bytes)}`,
    });
    runEvents.add({
      at: new Date().toISOString(),
      service: "vector-db",
      operation: "search top_k=5",
      status: "DERIVED",
      durationMs: ms,
      detail: `${hits.length} hits · best ${hits[0]?.score.toFixed(3) ?? "—"}${closest ? ` · closest pair ${closest.score.toFixed(3)}` : ""}`,
    });
    store.close();

    report.embeddings = {
      mode: run.mode,
      model: run.model,
      dims: stats.dims,
      vectors: stats.vectors,
      bytes: stats.bytes,
      backend: stats.backend,
      embedded: chosen.length - reused,
      reused,
      apiCalls: run.apiCalls,
      latencyMs: run.latencyMs,
      query: options.query,
      hits: hits.map((hit) => ({ videoId: hit.videoId, score: Number(hit.score.toFixed(4)) })),
      closestPair: closest ? { a: closest.a.id, b: closest.b?.id, score: Number(closest.score.toFixed(4)) } : null,
    };
    return { run, stats, hits, closest };
  });

  // ── 05 · Transform: LLM batch ───────────────────────────────────────────
  const llm = await runStage("TRANSFORM · LLM", "batched Gemini · evidence check", () => {
    const started = performance.now();
    const entries = Object.entries(vertexCache);
    const keys = entries.map(([key]) => key);
    const uniqueVideos = new Set(keys.map((key) => key.split("|")[0]));
    let exact = 0;
    let fuzzy = 0;
    let rejected = 0;
    let verifiedExample: any = null;
    let rejectedExample: any = null;

    for (const [key, entry] of entries) {
      const [videoId, candidateId] = key.split("|");
      const video = videosById.get(videoId);
      if (!video) continue;
      const match = matchEvidence(entry.evidence_quote, video);
      if (entry.evidence_verified) exact++;
      else if (match.verified) fuzzy++;
      else rejected++;
      if (!verifiedExample && entry.evidence_verified && entry.stance !== "unclear" && entry.evidence_quote) {
        verifiedExample = { key, entry, video, candidate: CANDIDATES_BY_ID[candidateId], match };
      }
      if (!rejectedExample && !match.verified && entry.evidence_quote) {
        rejectedExample = { key, entry, video, candidate: CANDIDATES_BY_ID[candidateId], match };
      }
    }

    console.log(
      ui.kv([
        ["cache", `${formatInt(entries.length)} verdicts · ${formatInt(uniqueVideos.size)} unique videos · ${formatInt(entries.length - uniqueVideos.size)} pair verdicts saved by batching`],
        ["model", `${stanceDoc.method?.model ?? "gemini-2.5-flash"} · temperature 0 · thinkingBudget 0`],
        ["quotes", `${formatInt(exact)} exact · ${formatInt(fuzzy)} fuzzy-recoverable · ${formatInt(rejected)} rejected`],
        ["contract", "a label without a verbatim quote never reaches the table"],
      ]),
    );

    const example = verifiedExample ?? rejectedExample;
    if (example) {
      const targets = [...new Set(stanceDoc.videos.filter((row) => row.video_id === example.video.id).map((row) => row.candidate_id))]
        .map((id) => CANDIDATES_BY_ID[id])
        .filter(Boolean)
        .slice(0, 4);
      const prompt = buildBatchPrompt(example.video, targets);
      console.log(ui.step(`prompt · one call, ${targets.length} candidate target(s)`));
      console.log(ui.box(null, prompt.split("\n").slice(0, 12), { tone: "faint" }));
      console.log(ui.note(`… ${prompt.split("\n").length} prompt lines · output is validated quote by quote`));
      console.log(ui.step("cached response"));
      console.log(
        ui.box(null, JSON.stringify({ candidate_id: example.key.split("|")[1], stance: example.entry.stance, score: example.entry.score, evidence_quote: example.entry.evidence_quote, evidence_verified: example.entry.evidence_verified }, null, 2).split("\n"), { tone: "faint", raw: true }),
      );
      if (example.entry.evidence_verified) {
        console.log(`  ${ui.badge("quote verified", "good")}  ${ui.quote(example.entry.evidence_quote)}`);
      }
    }
    if (rejectedExample) {
      console.log(ui.step("rejected example · the model quote is not in the source"));
      console.log(ui.quote(rejectedExample.entry.evidence_quote, `best match ${rejectedExample.match.similarity.toFixed(2)} · ${rejectedExample.match.mode}`));
    }

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "vertex-ai",
      operation: options.live ? "batch classify (cache + live probe)" : "batch classify (replay)",
      status: "RECORDED",
      durationMs: ms,
      detail: `${formatInt(entries.length)} verdicts · ${formatInt(exact)} exact · ${formatInt(rejected)} rejected · ${options.live ? "1 live probe" : "0 live calls"}`,
    });
    report.llm = {
      cacheEntries: entries.length,
      uniqueVideos: uniqueVideos.size,
      pairVerdictsSaved: entries.length - uniqueVideos.size,
      exact,
      fuzzy,
      rejected,
      model: stanceDoc.method?.model ?? "gemini-2.5-flash",
      live: report.liveVertex ?? null,
    };
    return { entries, exact, fuzzy, rejected, verifiedExample, rejectedExample };
  });

  // ── 06 · Transform: stance ──────────────────────────────────────────────
  const stance = await runStage("TRANSFORM · STANCE", "posts, not people", () => {
    const started = performance.now();
    const labels: Record<string, number> = {};
    const bases: Record<string, number> = {};
    for (const row of stanceDoc.videos) {
      labels[row.label] = (labels[row.label] ?? 0) + 1;
      const basis = String(row.basis ?? "none").startsWith("gemini") ? "gemini" : String(row.basis ?? "none").startsWith("relevance") ? "relevance" : "deterministic";
      bases[basis] = (bases[basis] ?? 0) + 1;
    }
    const decisive = stanceDoc.videos.length - (labels.unclear ?? 0);
    console.log(
      ui.kv([
        ["rows", `${formatInt(stanceDoc.videos.length)} video×candidate · ${formatInt(decisive)} decisive · ${formatInt(labels.unclear ?? 0)} unclear`],
        ["creators", `${formatInt(stanceDoc.creators.length)} creator×candidate rows · ${formatInt(stanceDoc.creators.filter((row) => row.label !== "single_video" && row.label !== "insufficient" && row.label !== "no_signal").length)} carry a creator label`],
        ["basis", `${formatInt(bases.gemini ?? 0)} model-backed · ${formatInt(bases.relevance ?? 0)} relevance rules · ${formatInt(bases.deterministic ?? 0)} deterministic`],
        ["labels", Object.entries(labels).map(([key, value]) => `${key} ${value}`).join(" · ")],
      ]),
    );

    const candidates = [...stanceDoc.candidates].sort((a, b) => b.videos - a.videos).slice(0, 8);
    console.log(ui.step("candidate coverage"));
    console.log(
      ui.table(
        [
          { label: "candidate", max: 14 },
          { label: "videos", align: "right" },
          { label: "fav", align: "right" },
          { label: "crit", align: "right" },
          { label: "neu", align: "right" },
          { label: "unc", align: "right" },
          { label: "index", align: "right", max: 7 },
          { label: "cov", align: "right", max: 6 },
        ],
        candidates.map((row) => [
          row.candidate_id,
          formatInt(row.videos),
          formatInt(row.favorable),
          formatInt(row.critical),
          formatInt(row.neutral),
          formatInt(row.unclear),
          formatSigned(row.stance_index),
          row.coverage?.toFixed(2) ?? "—",
        ]),
      ),
    );

    const examples = stanceDoc.videos
      .filter((row) => row.label !== "unclear" && row.quote)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 4);
    console.log(ui.step("receipts"));
    console.log(
      ui.table(
        [
          { label: "candidate", max: 12 },
          { label: "creator", max: 18 },
          { label: "label", max: 12 },
          { label: "score", align: "right", max: 6 },
          { label: "quote", max: 44 },
        ],
        examples.map((row) => [
          row.candidate_id,
          row.creator_handle,
          ui.paint(row.label, toneOfLabel(row.label), { bold: true }),
          formatSigned(row.score),
          sliceVisible(clean(row.quote), 44),
        ]),
      ),
    );

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "etl",
      operation: "stance aggregate",
      status: "DERIVED",
      durationMs: ms,
      detail: `${formatInt(stanceDoc.videos.length)} rows · ${formatInt(decisive)} decisive · ${formatInt(stanceDoc.creators.length)} creator rows`,
    });
    report.stance = { rows: stanceDoc.videos.length, decisive, labels, bases, creators: stanceDoc.creators.length };
    return stanceDoc;
  });

  // ── 07 · Derive: anatomy ────────────────────────────────────────────────
  const anatomyStage = await runStage("DERIVE · ANATOMY", "one video → fact → meaning → verdict", () => {
    const started = performance.now();
    const ctx = createContext(dataset, createEmbeddingClient(process.env));
    const entry = selectEntry(ctx.index, 6);
    const anatomy = options.video ? buildAnatomy(ctx.index, options.video) : entry[0]?.anatomy;
    if (!anatomy) throw new Error(`No anatomy for ${options.video ?? "the entry page"}`);

    console.log(
      ui.kv([
        ["video", `@${anatomy.attribution.handle} · ${anatomy.attribution.platform} · ${formatCompact(anatomy.attribution.views)} views · ${dateOnly(anatomy.attribution.postedAt)}`],
        ["coverage", `${anatomy.coverage} · quality ${anatomy.quality.toFixed(2)} · ${anatomy.segments.length} segments`],
        ["fact", anatomy.fact ? `${anatomy.fact.id} · ${sliceVisible(clean(anatomy.fact.statement), 62)}` : "no anchor fact"],
        ["verdict", anatomy.verdict ? `${CANDIDATES_BY_ID[anatomy.verdict.candidateId]?.name ?? anatomy.verdict.candidateId} · ${anatomy.verdict.leaning} · ${anatomy.verdict.verified ? "verified" : "held out"}` : "no verdict"],
      ]),
    );
    for (const segment of anatomy.segments) {
      const style = LEGEND[segment.role];
      const tone: Tone = segment.role === "FACT" ? "ink" : segment.role === "MEANING" ? "accent" : segment.role === "VERDICT" ? "accent" : "dim";
      console.log(ui.step(style.legend, tone));
      console.log(ui.quote(segment.text, `${segment.source} · ${segment.start}–${segment.end}${segment.truncated ? " · truncated" : ""}`));
    }
    if (anatomy.qualityNotes.length) {
      console.log(ui.note(`quality notes: ${anatomy.qualityNotes.join(" · ")}`));
    }

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "graphql",
      operation: "anatomy derive",
      status: "DERIVED",
      durationMs: ms,
      detail: `${anatomy.videoId} · ${anatomy.coverage} · quality ${anatomy.quality.toFixed(2)} · ${anatomy.segments.length} segments`,
    });
    report.anatomy = {
      videoId: anatomy.videoId,
      coverage: anatomy.coverage,
      quality: anatomy.quality,
      segments: anatomy.segments.map((segment) => segment.role),
      fact: anatomy.fact?.id ?? null,
      verdict: anatomy.verdict?.leaning ?? null,
    };
    return { ctx, anatomy };
  });

  context = anatomyStage.ctx;
  const index = context.index;

  // ── 08 · Derive: facts & readings ───────────────────────────────────────
  const facts = await runStage("DERIVE · FACTS", "one fact, many readings", () => {
    const started = performance.now();
    const built = dataset.facts.map((fact) => ({ def: fact, value: buildFact(index, fact) }));
    const chosen = options.fact
      ? built.find((entry) => entry.def.id === options.fact) ?? built[0]
      : [...built].sort((a, b) => b.value.videos.length - a.value.videos.length)[0];
    if (!chosen) throw new Error("No facts in the catalog");

    console.log(
      ui.kv([
        ["fact", `${chosen.def.id} · ${chosen.def.category}`],
        ["statement", sliceVisible(clean(chosen.def.statement), 84)],
        ["coverage", `${formatInt(chosen.value.videos.length)} videos · ${formatInt(chosen.value.creators)} creators · ${formatInt(chosen.value.stories.length)} readings`],
        ["review", `${chosen.def.verified ? "verified" : "UNVERIFIED"} · ${chosen.def.reviewStatus}`],
      ]),
    );
    if (!chosen.def.verified) {
      console.log(ui.warn("Anchor from the brief. The API exposes verified: false; the UI must render reviewStatus, never a green check."));
    }

    console.log(ui.step("stories"));
    console.log(
      ui.table(
        [
          { label: "story", max: 30 },
          { label: "videos", align: "right" },
          { label: "fav", align: "right" },
          { label: "crit", align: "right" },
          { label: "neu", align: "right" },
          { label: "unc", align: "right" },
        ],
        chosen.value.stories.map((story: any) => [
          story.label,
          formatInt(story.videos),
          formatInt(story.favorable),
          formatInt(story.critical),
          formatInt(story.neutral),
          formatInt(story.unclear),
        ]),
      ),
    );

    const sankey = chosen.value.sankey;
    const readings = sankey.nodes.filter((node: any) => node.column === 1).sort((a: any, b: any) => b.videos - a.videos);
    const max = readings[0]?.videos ?? 1;
    console.log(ui.step("fact → reading → verdict"));
    console.log(
      ui.table(
        [
          { label: "reading", max: 32 },
          { label: "videos", align: "right" },
          { label: "share", max: 14 },
          { label: "verdict split", max: 30 },
        ],
        readings.map((node: any) => {
          const links = sankey.links.filter((link: any) => link.source === node.id);
          const count = (target: string) => links.find((link: any) => link.target === `verdict:${target}`)?.videos ?? 0;
          return [
            node.label,
            formatInt(node.videos),
            `${ui.bar(node.videos, max, 10, "accent")} ${Math.round((node.videos / Math.max(1, sankey.summary.videos)) * 100)}%`,
            `${count("AGAINST")} against · ${count("FOR")} for · ${count("NONE")} none`,
          ];
        }),
      ),
    );
    console.log(
      ui.note(
        `summary · ${sankey.summary.forPct}% for · ${sankey.summary.againstPct}% against · ${sankey.summary.nonePct}% no side · top reading "${sankey.summary.topReading}"`,
      ),
    );
    const aimedAt = chosen.value.aimedAt.slice(0, 3);
    if (aimedAt.length) {
      console.log(ui.step("aimed at"));
      console.log(
        ui.table(
          [
            { label: "candidate", max: 20 },
            { label: "leaning", max: 12 },
            { label: "videos", align: "right" },
          ],
          aimedAt.map((row: any) => [row.candidate?.name ?? row.candidateId, row.leaning, formatInt(row.videos)]),
        ),
      );
    }

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "etl",
      operation: "fact + sankey",
      status: "DERIVED",
      durationMs: ms,
      detail: `${chosen.def.id} · ${formatInt(chosen.value.videos.length)} videos · ${readings.length} readings · top "${sankey.summary.topReading}"`,
    });
    report.facts = {
      factId: chosen.def.id,
      videos: chosen.value.videos.length,
      creators: chosen.value.creators,
      verified: chosen.def.verified,
      reviewStatus: chosen.def.reviewStatus,
      readings: readings.length,
      sankey: sankey.summary,
    };
    return chosen;
  });

  // ── 09 · Derive: timeline ───────────────────────────────────────────────
  await runStage("DERIVE · TIMELINE", "when each fact came up", () => {
    const started = performance.now();
    const timeline = buildFactTimeline(index, facts.def, 3);
    if (!timeline) throw new Error("No timeline for this fact");
    console.log(
      ui.kv([
        ["fact", `${timeline.fact.id} · ${timeline.fact.category}`],
        ["window", `±${timeline.windowDays} days per moment · ${timeline.months.join(" · ")}`],
        ["bursts", `${formatInt(timeline.videosInBursts)} citing videos · ${formatInt(timeline.totalVideosInBursts)} videos in those windows`],
        ["moments", `${formatInt(timeline.moments.length)} moments`],
      ]),
    );

    const moments = timeline.moments.slice(0, options.limit);
    for (const moment of moments) {
      const verdicts = moment.verdicts;
      console.log(
        `\n  ${ui.paint("●", "accent")} ${ui.paint(`${moment.date.slice(0, 10)}  ${moment.label}`, "ink", { bold: true })}  ${ui.paint(moment.title, "dim")}`,
      );
      console.log(
        `    ${ui.paint(`${formatInt(moment.videos)} citing`, "ink")} ${ui.paint(`· ${formatInt(moment.totalVideos)} in window`, "dim")} ` +
          `${ui.paint(`· ${verdicts.forCandidate} for / ${verdicts.againstCandidate} against / ${verdicts.noSide} none`, "dim")}`,
      );
      if (moment.facts?.length) {
        console.log(
          `    ${ui.paint(moment.facts.map((fact: any) => `${fact.highlighted ? "◆" : "·"} ${fact.label} ${fact.videos}`).join("   "), "faint")}`,
        );
      }
    }
    if (timeline.moments.length > moments.length) {
      console.log(ui.note(`showing ${moments.length} of ${timeline.moments.length} moments`));
    }

    console.log(ui.step("all facts"));
    console.log(
      ui.table(
        [
          { label: "fact", max: 26 },
          { label: "moments", align: "right" },
          { label: "months", max: 18 },
          { label: "citing", align: "right" },
        ],
        dataset.facts.map((fact) => {
          const value = buildFactTimeline(index, fact, 3);
          return [fact.category, formatInt(value?.moments.length ?? 0), value?.months.join(", ") ?? "—", formatInt(value?.videosInBursts ?? 0)];
        }),
      ),
    );

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "etl",
      operation: "fact timeline",
      status: "DERIVED",
      durationMs: ms,
      detail: `${timeline.fact.id} · ${timeline.moments.length} moments · ${timeline.months.length} months · ${timeline.videosInBursts} citing videos`,
    });
    report.timeline = {
      factId: timeline.fact.id,
      moments: timeline.moments.length,
      months: timeline.months,
      videosInBursts: timeline.videosInBursts,
      totalVideosInBursts: timeline.totalVideosInBursts,
    };
    return timeline;
  });

  // ── 10 · Load ───────────────────────────────────────────────────────────
  const load = await runStage("LOAD", "artifact → supabase → bigquery", async () => {
    const out = repoPath("data/analyses/runs/backend-trace/creator-stance.json");
    let result: any = null;
    let etlMs = 0;
    if (options.skipEtl) {
      console.log(ui.note("ETL re-run skipped; the existing artifact is the evidence."));
    } else {
      console.log(ui.note("Deterministic ETL over 865 mention pairs · 0 model calls · writes a versioned local artifact."));
      let last = 0;
      const etlStarted = performance.now();
      try {
        result = await runEtl({
          input: repoPath("data/oriane/top10-all.json"),
          out,
          maxVertexCalls: 0,
          minVideos: 2,
          neutralBand: 0.15,
          writeSupabase: false,
          writeBigQuery: false,
          project: project ?? undefined,
          location: "us-central1",
          model: "gemini-2.5-flash",
          verbose: false,
          onProgress: (done, total) => {
            last = progressLine(ui, "aggregating", done, total, last);
          },
        });
        etlMs = performance.now() - etlStarted;
      } catch (error) {
        console.log(ui.warn(`ETL run failed: ${(error as Error).message.slice(0, 200)}`));
      } finally {
        clearProgress(last);
      }
      if (result) {
        console.log(
          ui.kv([
            ["rows", `${formatInt(result.stats.creatorCandidatePairs)} creator×candidate · ${formatInt(result.stats.scoredPairs)} scored pairs · ${formatInt(result.creatorTotals.length)} creators`],
            ["decisive", `${formatInt(result.stats.favorable + result.stats.critical + result.stats.neutral)} decisive · ${formatInt(result.stats.unclear)} unclear`],
            ["labels", Object.entries(result.stats.labels).map(([key, value]) => `${key} ${value}`).join(" · ")],
            ["artifact", out.replace(repoPath() + "/", "")],
            ["elapsed", `${formatMs(etlMs)} · ${result.stats.modelCalls} model calls`],
          ]),
        );
      }
    }

    const supabase = cloud.facts.supabase;
    const bigquery = cloud.facts.bigquery;
    const probeStatus = cloud.fromCache ? "CACHED" : "LIVE";
    console.log(ui.step("targets"));
    console.log(
      ui.table(
        [
          { label: "target", max: 26 },
          { label: "rows", align: "right", max: 10 },
          { label: "status", max: 10 },
          { label: "evidence", max: 38 },
        ],
        [
          ["local artifact", formatInt(result?.stats.creatorCandidatePairs ?? stanceDoc.videos.length), "OK", out.replace(repoPath() + "/", "")],
          ["supabase fp_videos", formatInt(supabase?.videos), supabase?.videos ? probeStatus : "UNVERIFIED", "PostgREST count"],
          ["supabase fp_stance", formatInt(supabase?.stance), supabase?.stance ? probeStatus : "UNVERIFIED", "PostgREST count"],
          ["supabase fp_facts", formatInt(supabase?.facts), supabase?.facts ? probeStatus : "UNVERIFIED", "PostgREST count"],
          ["supabase fp_timelines", formatInt(supabase?.timelines), supabase?.timelines ? probeStatus : "UNVERIFIED", "PostgREST count"],
          ["bigquery creator_stance", formatInt(bigquery?.rows), bigquery?.rows ? "RECORDED" : "UNVERIFIED", bigquery?.loadRows ? `${formatInt(bigquery.loadRows)} rows via LOAD · ${formatMs(bigquery.loadMs ?? 0)}` : "table metadata"],
          ["graphql edge", "—", supabase?.apiVersion ? probeStatus : "UNVERIFIED", supabase?.apiVersion ? `v${supabase.apiVersion} · ${formatMs(supabase.graphqlMs ?? 0)}` : "health probe"],
        ],
      ),
    );
    console.log(
      ui.note("The read model has 273 video×candidate verdicts; the warehouse table has 331 creator×candidate rows. Different grains, same corpus."),
    );
    console.log(
      ui.note("This trace does not rewrite shared state. The counts prove the previous load; `npm run db:mirror` is the explicit Supabase refresh."),
    );

    runEvents.add({
      at: new Date().toISOString(),
      service: "etl",
      operation: "load artifact",
      status: result ? "DERIVED" : "CACHED",
      durationMs: etlMs,
      detail: result ? `${formatInt(result.stats.creatorCandidatePairs)} rows → ${out.replace(repoPath() + "/", "")}` : "existing artifact reused",
    });
    if (bigquery?.loadRows) {
      runEvents.add({
        at: new Date().toISOString(),
        service: "bigquery",
        operation: "load verified",
        status: "RECORDED",
        durationMs: bigquery.loadMs ?? null,
        detail: `${formatInt(bigquery.loadRows)} rows · ${bytes(bigquery.loadInputBytes)} in · ${bytes(bigquery.loadOutputBytes)} out`,
      });
    }
    if (supabase?.videos) {
      runEvents.add({
        at: new Date().toISOString(),
        service: "supabase",
        operation: "mirror verified",
        status: cloud.fromCache ? "CACHED" : "LIVE",
        durationMs: supabase.graphqlMs ?? null,
        detail: `videos ${formatInt(supabase.videos)} · stance ${formatInt(supabase.stance)} · facts ${formatInt(supabase.facts)} · timelines ${formatInt(supabase.timelines)}`,
      });
    }
    report.load = {
      etl: result
        ? {
            rows: result.stats.creatorCandidatePairs,
            creators: result.creatorTotals.length,
            decisive: result.stats.favorable + result.stats.critical + result.stats.neutral,
            unclear: result.stats.unclear,
            labels: result.stats.labels,
            elapsedMs: etlMs,
            artifact: out,
          }
        : { skipped: true },
      supabase,
      bigquery,
    };
    return { result, out };
  });

  // ── 11 · GraphQL read model ─────────────────────────────────────────────
  const graphql = await runStage("READ · GRAPHQL", "live edge + local parity", async () => {
    const started = performance.now();
    const query = `
      query BackendTrace($factId: ID!, $videoId: ID!, $search: String!) {
        apiVersion
        dataset { videos stanceRows events window { first last } }
        facts { id category videos }
        fact(id: $factId) {
          id category statement videos creators verified reviewStatus
          sankey { summary { videos forPct againstPct nonePct topReading } }
        }
        factTimeline(factId: $factId, windowDays: 3) {
          factId months videosInBursts
          moments { date label videos totalVideos hasSelectedFact
            verdicts { forCandidate againstCandidate noSide } }
        }
        anatomy(videoId: $videoId) {
          videoId coverage quality
          fact { id statement }
          verdict { leaning verified }
          segments { role text }
        }
        search(query: $search, limit: 3) { score method video { id creator { handle } } }
      }
    `;
    const variables = {
      factId: facts.def.id,
      videoId: (report.anatomy?.videoId as string) ?? "",
      search: options.query,
    };

    let live: any = null;
    let liveStatus = "UNVERIFIED";
    let liveMs = 0;
    let liveBytes = 0;
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    if (!options.offline && supabaseUrl) {
      const headers: Record<string, string> = {};
      if (process.env.SUPABASE_ANON_KEY) {
        headers.apikey = process.env.SUPABASE_ANON_KEY;
        headers.Authorization = `Bearer ${process.env.SUPABASE_ANON_KEY}`;
      }
      try {
        const response = await httpJson(`${supabaseUrl}/functions/v1/graphql`, {
          method: "POST",
          headers,
          body: { query, variables },
          timeoutMs: 20_000,
        });
        live = response.body?.data ?? null;
        liveMs = response.durationMs;
        liveBytes = response.text.length;
        liveStatus = response.status === 200 && live ? "LIVE" : "FAIL";
      } catch (error) {
        liveStatus = "FAIL";
        console.log(ui.warn(`Live GraphQL unavailable: ${(error as Error).message.slice(0, 160)}`));
      }
    }

    const localStarted = performance.now();
    const local = await execute({ source: query, variableValues: variables, context: context! });
    const localData: any = local.data ?? null;
    const localMs = performance.now() - localStarted;
    const pick = (data: any) => ({
      videos: data?.dataset?.videos,
      stanceRows: data?.dataset?.stanceRows,
      events: data?.dataset?.events,
      factVideos: data?.fact?.videos,
      timelineMoments: data?.factTimeline?.moments?.length,
      anatomyCoverage: data?.anatomy?.coverage,
      searchMethod: data?.search?.[0]?.method,
    });
    const livePick = pick(live);
    const localPick = pick(localData);
    const parity = live ? Object.keys(localPick).every((key) => livePick[key] === undefined || String(livePick[key]) === String(localPick[key])) : false;

    console.log(
      ui.kv([
        ["edge", `${liveStatus}${liveMs ? ` · ${formatMs(liveMs)} · ${formatInt(liveBytes)} B` : ""}${supabaseUrl ? ` · ${supabaseUrl.replace("https://", "")}` : " · SUPABASE_URL not set"}`],
        ["local", `${local.errors?.length ? "ERRORS" : "OK"} · ${formatMs(localMs)} · same dataset`],
        ["parity", parity ? "identical on every compared field" : "live and local differ"],
        ["dataset", `${formatInt(localPick.videos)} videos · ${formatInt(localPick.stanceRows)} stance rows · ${formatInt(localPick.events)} events`],
        ["fact", `${facts.def.id} · ${formatInt(localPick.factVideos)} videos · ${localData?.fact?.sankey?.summary?.forPct}% for / ${localData?.fact?.sankey?.summary?.againstPct}% against`],
        ["timeline", `${formatInt(localPick.timelineMoments)} moments · ${localData?.factTimeline?.months?.join(" · ")}`],
        ["anatomy", `${localPick.anatomyCoverage} · verdict ${localData?.anatomy?.verdict?.leaning ?? "—"}`],
        ["search", `${localData?.search?.length ?? 0} hits · method ${localPick.searchMethod ?? "—"}`],
      ]),
    );
    if (local.errors?.length) console.log(ui.error(local.errors[0].message));

    console.log(ui.step("query"));
    console.log(ui.box(null, query.trim().split("\n").slice(0, 10), { tone: "faint", raw: true }));
    console.log(ui.note(`… ${query.trim().split("\n").length} lines · one round trip · no LLM at read time`));

    const ms = performance.now() - started;
    runEvents.add({
      at: new Date().toISOString(),
      service: "graphql",
      operation: "edge + local query",
      status: liveStatus === "LIVE" ? "LIVE" : "DERIVED",
      durationMs: liveMs || ms,
      detail: `${liveStatus}${liveMs ? ` · ${formatMs(liveMs)}` : ""} · parity ${parity ? "yes" : "no"} · ${formatInt(liveBytes)} B`,
    });
    report.graphql = {
      liveStatus,
      liveMs,
      liveBytes,
      localMs,
      parity,
      live: livePick,
      local: localPick,
      errors: local.errors?.map((error) => error.message) ?? [],
    };
    return { live: livePick, local: localPick, parity, liveStatus };
  });

  // ── 12 · Handoff + manifest ─────────────────────────────────────────────
  await runStage("HANDOFF", "graphql → frontend contract", () => {
    const payload = {
      videoId: report.anatomy?.videoId,
      coverage: report.anatomy?.coverage,
      quality: report.anatomy?.quality,
      fact: { id: report.facts?.factId },
      verdict: { leaning: report.anatomy?.verdict },
      segments: report.anatomy?.segments,
      sankey: report.facts?.sankey,
      timeline: { moments: report.timeline?.moments, months: report.timeline?.months },
    };
    console.log(
      ui.table(
        [
          { label: "page", max: 16 },
          { label: "query", max: 26 },
          { label: "renders", max: 42 },
        ],
        [
          ["Story", "entryPage / anatomy", "hero counters, annotated quote card"],
          ["Facts", "facts / fact", "sankey, stories, aimed-at candidates"],
          ["Timeline", "factTimeline", "moments, verdict split, fact chips"],
          ["Events", "events / eventImpact", "before/after, scandal cards"],
          ["Video drawer", "video / verdicts", "caption, transcript, evidence quote"],
          ["Creator", "creator / stanceByCandidate", "posts, not people; index + label"],
        ],
      ),
    );
    console.log(ui.step("payload the frontend receives"));
    console.log(ui.box(null, JSON.stringify(payload, null, 2).split("\n").slice(0, 14), { tone: "faint", raw: true }));
    console.log(ui.note("The backend ends here. The frontend reads this contract; no LLM, no database join, no secret in the browser."));
    console.log(ui.note("Contract: docs/data-access.md · schema: docs/api-v0.1.md"));

    report.handoff = payload;
    report.telemetry.run = runEvents.events;
    report.counts = {
      videos: dataset.videos.length,
      french: frenchVideos.length,
      stanceRows: stanceDoc.videos.length,
      creatorRows: stanceDoc.creators.length,
      verdicts: llm.entries.length,
      facts: dataset.facts.length,
      events: dataset.events.events.length,
    };
    return payload;
  });

  report.stages = stages;
  report.telemetry.run = runEvents.events;
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, JSON.stringify(report, null, 2));

  // ── Manifest ────────────────────────────────────────────────────────────
  const maxMs = Math.max(...stages.map((stage) => stage.ms), 1);
  console.log(ui.stage(stages.length + 1, "RUN MANIFEST", "one command · every stage"));
  console.log(renderTelemetry(ui, runEvents.events, { title: "this run" }));
  console.log(countLine(ui, runEvents.count()));
  console.log(ui.step("stage timings"));
  console.log(
    ui.table(
      [
        { label: "stage", max: 30 },
        { label: "time", align: "right", max: 8 },
        { label: "share", max: 18 },
        { label: "status", max: 6 },
      ],
      stages.map((stage) => [
        `${String(stage.index).padStart(2, "0")} ${stage.title}`,
        formatMs(stage.ms),
        ui.bar(stage.ms, maxMs, 12, stage.status === "FAIL" ? "bad" : "accent"),
        stage.status,
      ]),
    ),
  );
  console.log(ui.step("artifacts"));
  console.log(
    ui.kv([
      ["report", options.report.replace(repoPath() + "/", "")],
      ["telemetry", options.telemetry.replace(repoPath() + "/", "")],
      ["vector", (options.liveEmbeddings ? options.vectorPath.replace(/\.db$/, "-vertex.db") : options.vectorPath).replace(repoPath() + "/", "")],
      ["etl", "data/analyses/runs/backend-trace/creator-stance.json"],
      ["llm cache", "data/analyses/.vertex-cache.json (read-only in this trace)"],
    ]),
  );
  console.log(ui.step("replay"));
  console.log(
    ui.kv([
      ["full trace", "npm run demo:backend"],
      ["live model", "npm run demo:backend -- --live"],
      ["fresh logs", "npm run demo:backend -- --refresh"],
      ["offline", "npm run demo:backend -- --offline"],
      ["frontend", "cd web-demo && npm run dev"],
    ]),
  );
  console.log(`\n${ui.paint("factpicker", "accent", { bold: true })} ${ui.paint("·", "faint")} backend trace complete ${ui.paint("·", "faint")} ${new Date().toISOString().slice(0, 10)}\n`);
}

main().catch((error) => {
  console.error(`\n✕ ${(error as Error).message}\n`);
  process.exitCode = 1;
});
