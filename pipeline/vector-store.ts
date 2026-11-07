/**
 * A small persistent vector store for the backend trace.
 *
 * SQLite (node:sqlite) is the primary backend: one row per video, a BLOB for
 * the float32 vector, and a text hash so a re-run reuses vectors whose source
 * text has not changed. A JSON file is the fallback when the runtime has no
 * SQLite. Both expose the same brute-force cosine search; at 209 videos that is
 * faster than any approximate index and makes every score auditable.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type VectorBackend = "auto" | "sqlite" | "json";

export interface VectorStoreOptions {
  path: string;
  model: string;
  backend?: VectorBackend;
}

export interface VectorInput {
  videoId: string;
  text: string;
  vector: number[];
}

export interface VectorHit {
  videoId: string;
  score: number;
}

export interface VectorStoreStats {
  backend: "sqlite" | "json";
  path: string;
  model: string;
  dims: number;
  vectors: number;
  builtAt: string;
  bytes: number;
  cachedShas: number;
}

interface Entry {
  sha: string;
  vector: Float32Array;
}

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): any;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function textSha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function decodeVector(blob: Uint8Array): Float32Array {
  const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(copy);
}

function encodeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export class VectorStore {
  private readonly path: string;
  private readonly model: string;
  private readonly backend: "sqlite" | "json";
  private readonly db: SqliteDatabase | null;
  private readonly entries = new Map<string, Entry>();
  private readonly shas = new Set<string>();
  private dims = 0;
  private builtAt = "";

  private constructor(options: VectorStoreOptions, backend: "sqlite" | "json", db: SqliteDatabase | null) {
    this.path = options.path;
    this.model = options.model;
    this.backend = backend;
    this.db = db;
  }

  static async open(options: VectorStoreOptions): Promise<VectorStore> {
    const requested = options.backend ?? "auto";
    const sqlite = requested !== "json" ? await loadSqlite() : null;
    if (sqlite && requested === "auto") {
      // The requested path is the SQLite file; the JSON fallback lives beside it.
      const store = new VectorStore(options, "sqlite", new sqlite.DatabaseSync(options.path));
      store.initSqlite();
      store.loadSqlite();
      return store;
    }
    if (sqlite && requested === "sqlite") {
      const store = new VectorStore(options, "sqlite", new sqlite.DatabaseSync(options.path));
      store.initSqlite();
      store.loadSqlite();
      return store;
    }
    const jsonPath = options.path.replace(/\.(db|sqlite)$/i, "") + ".json";
    const store = new VectorStore({ ...options, path: jsonPath }, "json", null);
    store.loadJson();
    return store;
  }

  private initSqlite(): void {
    const db = this.db!;
    mkdirSync(dirname(this.path), { recursive: true });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vectors (
        video_id TEXT PRIMARY KEY,
        text_sha TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vectors_sha ON vectors(text_sha);
    `);
    const model = db.prepare("SELECT value FROM meta WHERE key = ?").get("model") as { value?: string } | undefined;
    if (model?.value && model.value !== this.model) {
      // Switching between hashed and Vertex vectors must not mix spaces.
      db.exec("DELETE FROM vectors");
      db.prepare("DELETE FROM meta WHERE key IN ('dims','built_at')").run();
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.model);
    const metaDims = db.prepare("SELECT value FROM meta WHERE key = ?").get("dims") as { value?: string } | undefined;
    this.dims = Number(metaDims?.value ?? 0) || 0;
    const metaBuilt = db.prepare("SELECT value FROM meta WHERE key = ?").get("built_at") as { value?: string } | undefined;
    this.builtAt = metaBuilt?.value ?? new Date().toISOString();
  }

  private loadSqlite(): void {
    const rows = this.db!.prepare("SELECT video_id, text_sha, dims, vector FROM vectors").all() as Array<{
      video_id: string;
      text_sha: string;
      dims: number;
      vector: Uint8Array;
    }>;
    for (const row of rows) {
      this.entries.set(row.video_id, { sha: row.text_sha, vector: decodeVector(row.vector) });
      this.shas.add(row.text_sha);
      if (!this.dims) this.dims = row.dims;
    }
  }

  private loadJson(): void {
    if (!existsSync(this.path)) return;
    try {
      const payload = JSON.parse(readFileSync(this.path, "utf8")) as {
        model?: string;
        dims?: number;
        builtAt?: string;
        entries?: Record<string, { sha: string; vector: number[] }>;
      };
      if (payload.model && payload.model !== this.model) return;
      this.dims = payload.dims ?? 0;
      this.builtAt = payload.builtAt ?? new Date().toISOString();
      for (const [videoId, entry] of Object.entries(payload.entries ?? {})) {
        this.entries.set(videoId, { sha: entry.sha, vector: Float32Array.from(entry.vector) });
        this.shas.add(entry.sha);
      }
    } catch {
      this.entries.clear();
      this.shas.clear();
    }
  }

  private flushJson(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const entries: Record<string, { sha: string; vector: number[] }> = {};
    for (const [videoId, entry] of this.entries) {
      entries[videoId] = { sha: entry.sha, vector: Array.from(entry.vector) };
    }
    writeFileSync(this.path, JSON.stringify({ model: this.model, dims: this.dims, builtAt: this.builtAt, entries }));
  }

  has(sha: string): boolean {
    return this.shas.has(sha);
  }

  vector(videoId: string): Float32Array | undefined {
    return this.entries.get(videoId)?.vector;
  }

  /** Insert or replace a batch and persist once. */
  upsert(records: VectorInput[]): number {
    if (records.length === 0) return 0;
    this.dims = records[0].vector.length;
    this.builtAt = new Date().toISOString();
    const prepared = [] as Array<{ videoId: string; sha: string; vector: Float32Array }>;
    for (const record of records) {
      if (record.vector.length !== this.dims) {
        throw new Error(`vector for ${record.videoId} has ${record.vector.length} dims, expected ${this.dims}`);
      }
      prepared.push({ videoId: record.videoId, sha: textSha(record.text), vector: Float32Array.from(record.vector) });
    }

    if (this.backend === "sqlite") {
      const db = this.db!;
      const statement = db.prepare(
        "INSERT INTO vectors (video_id, text_sha, dims, vector) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(video_id) DO UPDATE SET text_sha = excluded.text_sha, dims = excluded.dims, vector = excluded.vector",
      );
      db.exec("BEGIN");
      try {
        for (const record of prepared) {
          statement.run(record.videoId, record.sha, this.dims, encodeVector(record.vector));
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('dims', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.dims));
        db.prepare("INSERT INTO meta (key, value) VALUES ('built_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.builtAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    for (const record of prepared) {
      this.entries.set(record.videoId, { sha: record.sha, vector: record.vector });
      this.shas.add(record.sha);
    }
    if (this.backend === "json") this.flushJson();
    return prepared.length;
  }

  search(query: number[], limit = 5): VectorHit[] {
    const needle = Float32Array.from(query);
    const hits: VectorHit[] = [];
    for (const [videoId, entry] of this.entries) {
      hits.push({ videoId, score: cosine(needle, entry.vector) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  nearest(videoId: string, limit = 5): VectorHit[] {
    const source = this.entries.get(videoId);
    if (!source) return [];
    const hits: VectorHit[] = [];
    for (const [otherId, entry] of this.entries) {
      if (otherId === videoId) continue;
      hits.push({ videoId: otherId, score: cosine(source.vector, entry.vector) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  stats(): VectorStoreStats {
    let bytes = 0;
    try {
      bytes = statSync(this.path).size;
      if (existsSync(`${this.path}-wal`)) bytes += statSync(`${this.path}-wal`).size;
    } catch {
      bytes = 0;
    }
    return {
      backend: this.backend,
      path: this.path,
      model: this.model,
      dims: this.dims,
      vectors: this.entries.size,
      builtAt: this.builtAt,
      bytes,
      cachedShas: this.shas.size,
    };
  }

  close(): void {
    if (this.backend === "json") this.flushJson();
    this.db?.close();
  }
}

async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => SqliteDatabase } | null> {
  try {
    const module = await import("node:sqlite");
    return { DatabaseSync: module.DatabaseSync as unknown as new (path: string) => SqliteDatabase };
  } catch {
    return null;
  }
}
