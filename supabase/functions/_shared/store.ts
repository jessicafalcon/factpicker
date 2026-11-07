/**
 * Minimal Supabase REST client. Pure fetch so the same code runs in a Deno edge
 * function and in the local Node CLI. The service role key must never reach the
 * browser.
 */
export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export interface StoreOptions {
  chunkSize?: number;
  fetchImpl?: typeof fetch;
}

export class SupabaseError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
    this.details = details;
  }
}

export function createSupabaseStore(config: SupabaseConfig, options: StoreOptions = {}) {
  const { url, serviceRoleKey } = config;
  const { chunkSize = 500, fetchImpl = fetch } = options;
  const base = url.replace(/\/$/, "");

  function headers(extra: Record<string, string> = {}) {
    return {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function request(path: string, init: RequestInit) {
    const response = await fetchImpl(`${base}${path}`, init);
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      throw new SupabaseError(
        `Supabase ${init.method ?? "GET"} ${path} failed: ${response.status}`,
        response.status,
        payload,
      );
    }
    return payload;
  }

  /** Merge-duplicates upsert, batched. Returns the number of rows sent. */
  async function upsert<T extends Record<string, unknown>>(
    table: string,
    rows: T[],
    onConflict: string,
  ): Promise<number> {
    let sent = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await request(`/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: "POST",
        headers: headers({
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(chunk),
      });
      sent += chunk.length;
    }
    return sent;
  }

  async function select<T>(table: string, query: string): Promise<T[]> {
    return (await request(`/rest/v1/${table}?${query}`, {
      method: "GET",
      headers: headers({ Prefer: "return=representation" }),
    })) as T[];
  }

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return (await request(`/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(args),
    })) as T;
  }

  return { upsert, select, rpc, request };
}

export type SupabaseStore = ReturnType<typeof createSupabaseStore>;

export function isSupabaseConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}
