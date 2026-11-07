/**
 * Real telemetry for the backend trace.
 *
 * The first stage of the demo is not a slide: it is the production footprint
 * this pipeline already left. Every probe is read-only, timed and cached, so a
 * recorded run can replay the same evidence without pretending it is fresh.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname } from "node:path";
import type { Ui } from "../scripts/ui.ts";
import { formatInt, formatMs, sliceVisible } from "../scripts/ui.ts";

export type TelemetryStatus = "LIVE" | "RECORDED" | "DERIVED" | "CACHED" | "MISSING" | "DEGRADED" | "FAIL";

export type TelemetryService =
  | "bigquery"
  | "vertex-ai"
  | "supabase"
  | "vector-db"
  | "cloud-run"
  | "cloud-logging"
  | "oriane"
  | "etl"
  | "graphql";

export interface TelemetryEvent {
  at: string;
  service: TelemetryService;
  operation: string;
  status: TelemetryStatus;
  durationMs?: number | null;
  detail: string;
  meta?: Record<string, unknown>;
}

export interface TelemetryCounts {
  LIVE: number;
  RECORDED: number;
  DERIVED: number;
  CACHED: number;
  MISSING: number;
  DEGRADED: number;
  FAIL: number;
}

export interface HttpResult<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
  durationMs: number;
}

export class TelemetryBook {
  readonly events: TelemetryEvent[] = [];

  add(input: Omit<TelemetryEvent, "at"> & { at?: string }): TelemetryEvent {
    const event: TelemetryEvent = {
      at: input.at ?? new Date().toISOString(),
      ...input,
    };
    this.events.push(event);
    return event;
  }

  count(): TelemetryCounts {
    const counts: TelemetryCounts = { LIVE: 0, RECORDED: 0, DERIVED: 0, CACHED: 0, MISSING: 0, DEGRADED: 0, FAIL: 0 };
    for (const event of this.events) counts[event.status] += 1;
    return counts;
  }

  render(ui: Ui, options: { title?: string; indent?: number } = {}): string {
    return renderTelemetry(ui, this.events, options);
  }
}

const STATUS_TONE: Record<TelemetryStatus, "good" | "favorable" | "accent" | "neutral" | "faint" | "warn" | "bad"> = {
  LIVE: "good",
  RECORDED: "favorable",
  DERIVED: "accent",
  CACHED: "neutral",
  MISSING: "faint",
  DEGRADED: "warn",
  FAIL: "bad",
};

export function renderTelemetry(
  ui: Ui,
  events: TelemetryEvent[],
  options: { title?: string; indent?: number } = {},
): string {
  const indent = options.indent ?? 2;
  const pad = " ".repeat(indent);
  const header =
    `${pad}${ui.paint("time (UTC)", "faint")}      ` +
    `${ui.paint("service", "faint")}       ` +
    `${ui.paint("operation", "faint")}                          ` +
    `${ui.paint("status", "faint")}    ${ui.paint("latency", "faint")}`;
  const rows = events.map((event) => {
    const time = event.at ? event.at.slice(11, 23) : "--:--:--.---";
    const service = event.service.padEnd(12);
    const operation = sliceVisible(event.operation, 34).padEnd(34);
    const status = event.status.padEnd(9);
    const latency = event.durationMs === null || event.durationMs === undefined ? "—" : formatMs(event.durationMs);
    const head =
      `${pad}${ui.paint(time, "faint")}  ` +
      `${ui.paint(service, "dim")}  ` +
      `${ui.paint(operation, "ink")}  ` +
      `${ui.paint(status, STATUS_TONE[event.status], { bold: event.status === "LIVE" || event.status === "FAIL" })}  ` +
      `${ui.paint(latency.padStart(7), "dim")}`;
    const cached = event.meta?.cached ? ` · cached ${String(event.meta.capturedAt ?? "").slice(11, 19)}` : "";
    const detail = ui
      .wrap(`${event.detail}${cached}`, ui.width - indent - 18)
      .map((line) => `${pad}${" ".repeat(16)}${ui.paint(line, "dim")}`)
      .join("\n");
    return `${head}\n${detail}`;
  });
  const title = options.title ? `${pad}${ui.paint(options.title, "accent", { bold: true })}\n` : "";
  return `${title}${header}\n${ui.paint(`${pad}${"─".repeat(ui.width - indent)}`, "faint")}\n${rows.join("\n")}`;
}

export function countLine(ui: Ui, counts: TelemetryCounts): string {
  const parts: string[] = [];
  for (const key of ["LIVE", "RECORDED", "DERIVED", "CACHED", "MISSING", "DEGRADED", "FAIL"] as TelemetryStatus[]) {
    if (!counts[key]) continue;
    parts.push(ui.paint(`${key} ${counts[key]}`, STATUS_TONE[key]));
  }
  return `  ${parts.join(ui.paint("  ·  ", "faint"))}`;
}

// ── Credentials ────────────────────────────────────────────────────────────

export function gcloudAccessToken(): string | null {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  try {
    return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gcloudProject(): string | null {
  const fromEnv = process.env.GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (fromEnv) return fromEnv;
  try {
    const project = execFileSync("gcloud", ["config", "get-value", "project"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return project && project !== "(unset)" ? project : null;
  } catch {
    return null;
  }
}

export function supabaseRef(url: string | undefined): string | null {
  if (!url) return null;
  const match = /https?:\/\/([^.]+)\.supabase\.co/.exec(url);
  return match ? match[1] : null;
}

// ── HTTP (IPv4 pinned; Google APIs were picking an unreachable address) ────

export function httpJson<T = any>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<HttpResult<T>> {
  const started = performance.now();
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const req = request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        family: 4,
        timeout: options.timeoutMs ?? 15_000,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
          ...options.headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            text,
            durationMs: performance.now() - started,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${options.timeoutMs ?? 15_000}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Cloud probes ──────────────────────────────────────────────────────────

export interface CloudFacts {
  bigquery?: {
    rows: number;
    fields: number;
    loadRows?: number;
    loadInputBytes?: number;
    loadOutputBytes?: number;
    loadMs?: number;
    loadJobId?: string;
    jobs7d?: number;
    queryBytes7d?: number;
  };
  cloudRun?: { found: boolean; jobs: number; regions: string[] };
  logging?: { entries: number; bigquery: number; cloudRun: number };
  supabase?: {
    videos?: number;
    stance?: number;
    facts?: number;
    timelines?: number;
    anatomy?: number;
    behind?: number;
    candidates?: number;
    apiVersion?: string;
    graphqlMs?: number;
  };
}

export interface CloudProbeResult {
  events: TelemetryEvent[];
  facts: CloudFacts;
  capturedAt: string;
  fromCache: boolean;
}

interface CacheFile {
  capturedAt: string;
  project: string;
  events: TelemetryEvent[];
  facts: CloudFacts;
}

export async function probeCloud(options: {
  project: string;
  token: string | null;
  cachePath: string;
  refresh?: boolean;
  timeoutMs?: number;
}): Promise<CloudProbeResult> {
  const { project, token, cachePath, refresh = false } = options;
  if (!refresh && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
      if (cached.events?.length) {
        return {
          events: cached.events.map((event) => ({
            ...event,
            meta: { ...event.meta, cached: true, capturedAt: cached.capturedAt },
          })),
          facts: cached.facts ?? {},
          capturedAt: cached.capturedAt,
          fromCache: true,
        };
      }
    } catch {
      // A corrupt cache must not stop a live probe.
    }
  }

  if (!token) {
    return {
      events: [
        {
          at: new Date().toISOString(),
          service: "cloud-logging",
          operation: "credentials",
          status: "MISSING",
          durationMs: null,
          detail: "No GOOGLE_ACCESS_TOKEN and no Application Default Credentials. Run gcloud auth application-default login, or pass --offline to replay the cache.",
        },
      ],
      facts: {},
      capturedAt: new Date().toISOString(),
      fromCache: false,
    };
  }

  const events: TelemetryEvent[] = [];
  const facts: CloudFacts = {};
  const headers = { Authorization: `Bearer ${token}` };
  const timeoutMs = options.timeoutMs ?? 15_000;

  // 1. BigQuery table and the real LOAD job.
  try {
    const table = await httpJson<any>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/cadrage2027/tables/creator_stance`,
      { headers, timeoutMs },
    );
    if (table.status !== 200) throw new Error(`HTTP ${table.status}: ${String(table.body?.error?.message ?? table.text).slice(0, 160)}`);
    const rows = Number(table.body.numRows ?? 0);
    const fields = table.body.schema?.fields?.length ?? 0;
    facts.bigquery = { rows, fields };
    events.push({
      at: new Date().toISOString(),
      service: "bigquery",
      operation: "tables.get creator_stance",
      status: "LIVE",
      durationMs: table.durationMs,
      detail: `${formatInt(rows)} rows · ${fields} fields · ${project}.cadrage2027.creator_stance`,
    });
  } catch (error) {
    events.push({
      at: new Date().toISOString(),
      service: "bigquery",
      operation: "tables.get creator_stance",
      status: "FAIL",
      durationMs: null,
      detail: (error as Error).message,
    });
  }

  try {
    const query = {
      query:
        "SELECT job_id, job_type, creation_time, start_time, end_time, total_bytes_processed, " +
        "destination_table.table_id AS destination, state " +
        `FROM \`${project}.region-EU.INFORMATION_SCHEMA.JOBS_BY_PROJECT\` ` +
        "WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) " +
        "ORDER BY creation_time DESC LIMIT 40",
      useLegacySql: false,
      maxResults: 40,
    };
    const jobs = await httpJson<any>(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, {
      method: "POST",
      headers,
      body: query,
      timeoutMs,
    });
    if (jobs.status !== 200) throw new Error(`HTTP ${jobs.status}: ${String(jobs.body?.error?.message ?? jobs.text).slice(0, 160)}`);
    const schema: Array<{ name: string }> = jobs.body.schema?.fields ?? [];
    const rows: Array<Record<string, string | null>> = (jobs.body.rows ?? []).map((row: any) =>
      Object.fromEntries(schema.map((field, index) => [field.name, row.f[index]?.v ?? null])),
    );
    const load = rows.find((row) => row.job_type === "LOAD");
    const queryBytes = rows.reduce((sum, row) => sum + Number(row.total_bytes_processed ?? 0), 0);
    facts.bigquery = { ...(facts.bigquery ?? { rows: 0, fields: 0 }), jobs7d: rows.length, queryBytes7d: queryBytes };
    events.push({
      at: new Date().toISOString(),
      service: "bigquery",
      operation: "INFORMATION_SCHEMA.JOBS_BY_PROJECT",
      status: "LIVE",
      durationMs: jobs.durationMs,
      detail: `${rows.length} jobs in 7 days · ${formatInt(queryBytes)} bytes processed · ${load ? "1 LOAD job" : "no LOAD job"}`,
    });

    if (load?.job_id) {
      const detail = await httpJson<any>(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs/${encodeURIComponent(load.job_id)}?location=EU`,
        { headers, timeoutMs },
      );
      if (detail.status === 200) {
        const loadStats = detail.body.statistics?.load ?? {};
        const started = Number(detail.body.statistics?.startTime ?? 0);
        const ended = Number(detail.body.statistics?.endTime ?? 0);
        const loadMs = started && ended ? ended - started : 0;
        facts.bigquery = {
          ...(facts.bigquery ?? { rows: 0, fields: 0 }),
          loadRows: Number(loadStats.outputRows ?? 0),
          loadInputBytes: Number(loadStats.inputFileBytes ?? 0),
          loadOutputBytes: Number(loadStats.outputBytes ?? 0),
          loadMs,
          loadJobId: load.job_id,
        };
        events.push({
          at: new Date(Number(load.creation_time ?? 0) * 1000 || Date.now()).toISOString(),
          service: "bigquery",
          operation: "jobs.get LOAD",
          status: "RECORDED",
          durationMs: loadMs,
          detail:
            `${formatInt(Number(loadStats.outputRows ?? 0))} rows → ${load.destination ?? "creator_stance"} · ` +
            `${formatInt(Number(loadStats.inputFileBytes ?? 0))} B in · ${formatInt(Number(loadStats.outputBytes ?? 0))} B out · ` +
            `${loadStats.inputFiles ?? "?"} input file(s)`,
          meta: { jobId: load.job_id, state: load.state },
        });
      }
    }
  } catch (error) {
    events.push({
      at: new Date().toISOString(),
      service: "bigquery",
      operation: "INFORMATION_SCHEMA.JOBS_BY_PROJECT",
      status: "FAIL",
      durationMs: null,
      detail: (error as Error).message,
    });
  }

  // 2. Cloud Run footprint. The docs claim a job; this reports what exists.
  const runRegions = ["europe-west1", "us-central1"];
  const runFound: string[] = [];
  let runJobs = 0;
  let runError: string | null = null;
  for (const region of runRegions) {
    try {
      const response = await httpJson<any>(
        `https://${region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${project}/jobs`,
        { headers, timeoutMs },
      );
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const items: any[] = response.body.items ?? [];
      runJobs += items.length;
      if (items.some((job) => job.metadata?.name === "cadrage2027-stance")) runFound.push(region);
    } catch (error) {
      runError = (error as Error).message;
    }
  }
  facts.cloudRun = { found: runFound.length > 0, jobs: runJobs, regions: runFound };
  events.push({
    at: new Date().toISOString(),
    service: "cloud-run",
    operation: "jobs.list cadrage2027-stance",
    status: runFound.length > 0 ? "LIVE" : "MISSING",
    durationMs: null,
    detail:
      runFound.length > 0
        ? `found in ${runFound.join(", ")} · ${runJobs} job(s) scanned`
        : `no cadrage2027-stance job in ${runRegions.join(" or ")} · ${runJobs} unrelated job(s)${runError ? ` · ${runError}` : ""}`,
  });

  // 3. Cloud Logging: one query, bounded, to respect the read quota.
  try {
    const logs = await httpJson<any>("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers,
      timeoutMs,
      body: {
        resourceNames: [`projects/${project}`],
        filter: 'resource.type="bigquery_project" OR resource.type="cloud_run_job"',
        pageSize: 10,
        orderBy: "timestamp desc",
      },
    });
    if (logs.status === 429) throw new Error("quota exceeded on logging.googleapis.com (read requests per minute)");
    if (logs.status !== 200) throw new Error(`HTTP ${logs.status}: ${String(logs.body?.error?.message ?? logs.text).slice(0, 160)}`);
    const entries: any[] = logs.body.entries ?? [];
    const bigqueryEntries = entries.filter((entry) => entry.resource?.type === "bigquery_project").length;
    const runEntries = entries.filter((entry) => entry.resource?.type === "cloud_run_job").length;
    facts.logging = { entries: entries.length, bigquery: bigqueryEntries, cloudRun: runEntries };
    events.push({
      at: new Date().toISOString(),
      service: "cloud-logging",
      operation: "entries.list audit",
      status: "LIVE",
      durationMs: logs.durationMs,
      detail: `${entries.length} recent entries · ${bigqueryEntries} BigQuery · ${runEntries} Cloud Run`,
    });
    if (bigqueryEntries > 0) {
      const first = entries.find((entry) => entry.resource?.type === "bigquery_project");
      events.push({
        at: first.timestamp ?? new Date().toISOString(),
        service: "bigquery",
        operation: String(first.protoPayload?.methodName ?? "audit").split(".").pop() ?? "InsertJob",
        status: "RECORDED",
        durationMs: null,
        detail: `audit log · ${String(first.protoPayload?.methodName ?? "BigQuery").slice(0, 80)}`,
      });
    }
  } catch (error) {
    events.push({
      at: new Date().toISOString(),
      service: "cloud-logging",
      operation: "entries.list audit",
      status: "DEGRADED",
      durationMs: null,
      detail: (error as Error).message,
    });
  }

  // 4. Supabase: the live read model and its table counts.
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl) {
    const headersSupabase: Record<string, string> = {};
    if (anonKey) {
      headersSupabase.apikey = anonKey;
      headersSupabase.Authorization = `Bearer ${anonKey}`;
    }
    try {
      const graphql = await httpJson<any>(`${supabaseUrl}/functions/v1/graphql`, {
        method: "POST",
        headers: headersSupabase,
        timeoutMs,
        body: {
          query: "{ apiVersion dataset { videos stanceRows events window { first last } } }",
        },
      });
      const data = graphql.body?.data;
      if (graphql.status !== 200 || !data) {
        throw new Error(`HTTP ${graphql.status}: ${String(graphql.body?.errors?.[0]?.message ?? graphql.text).slice(0, 160)}`);
      }
      facts.supabase = {
        ...(facts.supabase ?? {}),
        videos: data.dataset?.videos,
        stance: data.dataset?.stanceRows,
        apiVersion: data.apiVersion,
        graphqlMs: graphql.durationMs,
      };
      events.push({
        at: new Date().toISOString(),
        service: "supabase",
        operation: "POST /functions/v1/graphql",
        status: "LIVE",
        durationMs: graphql.durationMs,
        detail:
          `v${data.apiVersion} · ${formatInt(data.dataset?.videos)} videos · ` +
          `${formatInt(data.dataset?.stanceRows)} stance rows · ${formatInt(data.dataset?.events)} events · ` +
          `${graphql.text.length} B · edge`,
      });
    } catch (error) {
      events.push({
        at: new Date().toISOString(),
        service: "supabase",
        operation: "POST /functions/v1/graphql",
        status: "FAIL",
        durationMs: null,
        detail: (error as Error).message,
      });
    }

    const tables = ["fp_videos", "fp_stance", "fp_facts", "fp_timelines", "fp_anatomy", "fp_behind", "fp_candidates"];
    try {
      const started = performance.now();
      const counts = await Promise.all(
        tables.map(async (table) => {
          const response = await httpJson<any>(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
            headers: { ...headersSupabase, Prefer: "count=exact", Range: "0-0" },
            timeoutMs,
          });
          const range = String(response.headers["content-range"] ?? "");
          const total = Number(range.split("/")[1] ?? NaN);
          return { table, status: response.status, total: Number.isFinite(total) ? total : null };
        }),
      );
      const byTable = Object.fromEntries(counts.map((entry) => [entry.table, entry.total]));
      const failed = counts.filter((entry) => entry.status >= 400 || entry.total === null);
      facts.supabase = {
        ...(facts.supabase ?? {}),
        videos: byTable.fp_videos ?? facts.supabase?.videos,
        stance: byTable.fp_stance ?? facts.supabase?.stance,
        facts: byTable.fp_facts,
        timelines: byTable.fp_timelines,
        anatomy: byTable.fp_anatomy,
        behind: byTable.fp_behind,
        candidates: byTable.fp_candidates,
      };
      events.push({
        at: new Date().toISOString(),
        service: "supabase",
        operation: "REST count fp_*",
        status: failed.length === 0 ? "LIVE" : "DEGRADED",
        durationMs: performance.now() - started,
        detail:
          `videos ${formatInt(byTable.fp_videos)} · stance ${formatInt(byTable.fp_stance)} · ` +
          `facts ${formatInt(byTable.fp_facts)} · timelines ${formatInt(byTable.fp_timelines)} · ` +
          `anatomy ${formatInt(byTable.fp_anatomy)} · behind ${formatInt(byTable.fp_behind)} · ` +
          `candidates ${formatInt(byTable.fp_candidates)}${failed.length ? ` · ${failed.length} table(s) unavailable` : ""}`,
      });
    } catch (error) {
      events.push({
        at: new Date().toISOString(),
        service: "supabase",
        operation: "REST count fp_*",
        status: "FAIL",
        durationMs: null,
        detail: (error as Error).message,
      });
    }
  } else {
    events.push({
      at: new Date().toISOString(),
      service: "supabase",
      operation: "read model",
      status: "MISSING",
      durationMs: null,
      detail: "SUPABASE_URL is not set; the local GraphQL executor will be used.",
    });
  }

  const result: CloudProbeResult = {
    events,
    facts,
    capturedAt: new Date().toISOString(),
    fromCache: false,
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CacheFile = { capturedAt: result.capturedAt, project, events, facts };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  } catch {
    // Caching is a convenience; never fail the trace for it.
  }
  return result;
}
