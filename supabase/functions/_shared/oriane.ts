import type { CandidateDef, Platform, SourceField } from "./types.ts";

export const ORIANE_BASE_URL = "https://connect.oriane.xyz";

/** Fields that carry speaking/on-screen text on an Oriane content record. */
export const TEXT_FIELDS: SourceField[] = ["transcript", "caption", "on_screen_text"];

/** Oriane filter object key for each logical source field. */
export const ORIANE_FIELD: Record<SourceField, string> = {
  transcript: "transcript",
  caption: "caption",
  on_screen_text: "onScreenText",
};

export type Projection = "basic" | "default" | "full";
export type SortField =
  | "publishedAt"
  | "viewsCount"
  | "likesCount"
  | "sharesCount"
  | "commentsCount"
  | "interactionsCount"
  | "engagementRatePerViews"
  | "engagementRatePerFollowers"
  | "viewsRatePerFollowers"
  | "profileFollowersCount";

export interface ValueOperand {
  values: string[];
  operator?: "and" | "or";
}

/** Text filter operand. One operand per field per filter object. */
export interface TextOperandFilter {
  exactMatch?: ValueOperand;
  includesExactly?: ValueOperand;
  includesFuzzy?: ValueOperand;
  excludesExactly?: ValueOperand;
  excludesFuzzy?: ValueOperand;
  operator?: "and" | "or";
}

/** Set/enum filter operand. */
export interface SetOperandFilter<T> {
  includes?: T[];
  excludes?: T[];
  operator?: "and" | "or";
}

/** Numeric range filter operand. */
export interface RangeFilter {
  min?: number;
  max?: number;
}

export interface ContentFilters {
  id?: SetOperandFilter<string>;
  platform?: SetOperandFilter<Platform>;
  platformId?: SetOperandFilter<string>;
  format?: SetOperandFilter<"image" | "video" | "carousel">;
  platformType?: SetOperandFilter<{ platform: Platform; type: string }>;
  profileId?: SetOperandFilter<string>;
  profilePlatformId?: SetOperandFilter<string>;
  profileHandle?: TextOperandFilter;
  profileBio?: TextOperandFilter;
  title?: TextOperandFilter;
  caption?: TextOperandFilter;
  captionLanguage?: SetOperandFilter<string>;
  transcript?: TextOperandFilter;
  transcriptLanguage?: SetOperandFilter<string>;
  onScreenText?: TextOperandFilter;
  hashtags?: TextOperandFilter;
  viewsCount?: RangeFilter;
  likesCount?: RangeFilter;
  sharesCount?: RangeFilter;
  commentsCount?: RangeFilter;
  interactionsCount?: RangeFilter;
  engagementRatePerViews?: RangeFilter;
  engagementRatePerFollowers?: RangeFilter;
  viewsRatePerFollowers?: RangeFilter;
  profileFollowersCount?: RangeFilter;
  profileFollowingCount?: RangeFilter;
  profilePostsCount?: RangeFilter;
  publishedAt?: { after?: string; before?: string };
  audioPlatformId?: SetOperandFilter<string>;
  audioTitle?: TextOperandFilter;
  audioAuthor?: TextOperandFilter;
  audioType?: SetOperandFilter<string>;
  audioCopyrighted?: boolean;
  coAuthorIds?: SetOperandFilter<string>;
  coAuthorPlatformIds?: SetOperandFilter<string>;
  coAuthorHandles?: SetOperandFilter<string>;
  hasCoAuthors?: boolean;
  mentionIds?: SetOperandFilter<string>;
  mentionPlatformIds?: SetOperandFilter<string>;
  mentionHandles?: SetOperandFilter<string>;
  hasMentions?: boolean;
  locationPlatformId?: SetOperandFilter<string>;
  locationCompleteAddress?: TextOperandFilter;
  locationCoordinates?: { latitude?: number; longitude?: number; radius?: number };
  profileLocationPlatformId?: SetOperandFilter<string>;
  profileLocationCompleteAddress?: TextOperandFilter;
  profileLocationCoordinates?: { latitude?: number; longitude?: number; radius?: number };
  visualSimilarity?: {
    includes?: { values: Array<{ assetId: string; minScore?: number; maxScore?: number }>; operator?: "and" | "or" };
    excludes?: { values: Array<{ assetId: string; minScore?: number; maxScore?: number }>; operator?: "and" | "or" };
    operator?: "and" | "or";
  };
}

export interface ContentQuery {
  name?: string;
  operator: "and" | "or";
  filters?: ContentFilters;
  queries?: ContentQuery[];
}

export interface SearchParams {
  limit?: number;
  offset?: number;
  projection?: Projection;
  sort?: string;
  aiSearchAnchor?: string;
}

export interface OrianeContent {
  id: string;
  matchedQueries?: string[];
  platform: Platform;
  platformId: string;
  platformType: string;
  format: "image" | "video" | "carousel";
  profileHandle: string | null;
  profileDisplayName: string | null;
  profileId: string | null;
  profileFollowersCount: number | null;
  profileVerified?: boolean;
  profileBio?: string | null;
  title: string | null;
  caption: string | null;
  captionLanguage?: string | null;
  publishedAt: string | null;
  viewsCount: number | null;
  likesCount: number | null;
  sharesCount: number | null;
  commentsCount: number | null;
  interactionsCount: number | null;
  hashtags: string[] | null;
  mentions?: Array<{ id: string; platformId: string; profileHandle: string }>;
  media?: Array<{
    type: string;
    duration: number | null;
    caption: string | null;
    onScreenText?: string[];
    transcript?: string;
    transcriptLanguage?: string;
    transcriptChunks?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
    tags?: Array<{ id: string; platformId: string; profileHandle: string }>;
    frames?: Array<{ id: string; position: number; timestampSeconds: number; url: string; visualSimilarityScore: number; onScreenTextRegions?: Array<{ text: string; polygon: Array<{ x: number; y: number }> }> }>;
  }>;
  engagementRatePerViews?: number | null;
  popularComments?: Array<{ text: string; likesCount?: number }>;
  thumbnailMediaUrl: string | null;
}

export interface SearchResponse {
  status: number;
  requestId: string | null;
  executionTime: number | null;
  totalCount: number | null;
  records: OrianeContent[];
  aggregations?: Record<string, number>;
}

export interface OrianeClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OrianeError extends Error {
  status: number;
  code: string | null;
  requestId: string | null;
  context: unknown;
  constructor(message: string, status: number, code: string | null, requestId: string | null, context: unknown) {
    super(message);
    this.name = "OrianeError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.context = context;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createOrianeClient(options: OrianeClientOptions) {
  const {
    apiKey,
    baseUrl = ORIANE_BASE_URL,
    maxRetries = 4,
    timeoutMs = 90_000,
    fetchImpl = fetch,
  } = options;

  async function searchContents(
    body: ContentQuery,
    params: SearchParams = {},
  ): Promise<SearchResponse> {
    // Fail loudly instead of silently truncating a caller's page size: a
    // silent clamp hides pagination bugs.
    if (params.limit !== undefined && (params.limit < 1 || params.limit > 100)) {
      throw new RangeError(`limit must be between 1 and 100, received ${params.limit}`);
    }
    if (params.offset !== undefined && params.offset < 0) {
      throw new RangeError(`offset must be >= 0, received ${params.offset}`);
    }

    const query = new URLSearchParams();
    query.set("limit", String(params.limit ?? 20));
    query.set("offset", String(params.offset ?? 0));
    query.set("projection", params.projection ?? "default");
    query.set("sort", params.sort ?? "publishedAt:desc");
    if (params.aiSearchAnchor) query.set("aiSearchAnchor", params.aiSearchAnchor);

    const url = `${baseUrl}/rest/contents/search?${query.toString()}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }

        // Oriane returns 206 for any paginated result with more rows available.
        if (response.status === 200 || response.status === 206) {
          const data = payload?.data ?? {};
          return {
            status: response.status,
            requestId: payload?.metadata?.requestId ?? null,
            executionTime: payload?.metadata?.executionTime ?? null,
            totalCount: payload?.metadata?.pagination?.totalCount ?? null,
            records: (data.results ?? []) as OrianeContent[],
            aggregations: data.aggregations,
          };
        }

        const retryable = response.status === 429 || response.status >= 500;
        const err = new OrianeError(
          payload?.error?.message ?? `Oriane responded ${response.status}`,
          response.status,
          payload?.error?.code ?? null,
          payload?.metadata?.requestId ?? null,
          payload?.error?.context ?? null,
        );
        if (!retryable || attempt === maxRetries) throw err;
        lastError = err;
      } catch (error) {
        if (error instanceof OrianeError) throw error;
        lastError = error;
        if (attempt === maxRetries) {
          throw new OrianeError(
            `Oriane request failed: ${(error as Error).message}`,
            0,
            "NETWORK",
            null,
            null,
          );
        }
      } finally {
        clearTimeout(timer);
      }
      await sleep(Math.min(500 * 2 ** attempt, 8_000));
    }
    throw lastError;
  }

  /**
   * Walks pages until `maxItems` or the end of the result set. Records are
   * deduplicated by content id: a video that mentions three candidates appears
   * in several result sets during a multi-query pull.
   */
  async function* paginate(
    body: ContentQuery,
    params: SearchParams & { maxItems?: number },
  ): AsyncGenerator<OrianeContent> {
    const limit = Math.min(params.limit ?? 100, 100);
    const maxItems = params.maxItems ?? 1_000;
    const seen = new Set<string>();
    let offset = params.offset ?? 0;
    let yielded = 0;
    let total: number | null = null;

    while (yielded < maxItems) {
      const page = await searchContents(body, { ...params, limit, offset });
      total = page.totalCount ?? total;
      if (page.records.length === 0) break;
      for (const record of page.records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        yield record;
        yielded++;
        if (yielded >= maxItems) break;
      }
      offset += page.records.length;
      if (total !== null && offset >= total) break;
      if (page.records.length < limit) break;
    }
  }

  return { searchContents, paginate };
}

export type OrianeClient = ReturnType<typeof createOrianeClient>;

/** One `includesExactly` operand for one field. */
export function textFilter(field: SourceField, values: string[], operator: "and" | "or" = "or"): ContentFilters {
  return { [ORIANE_FIELD[field]]: { includesExactly: { values, operator } } } as ContentFilters;
}

/** One named sub-query that matches a candidate in one text field. */
export function candidateFieldQuery(
  candidate: CandidateDef,
  field: SourceField,
  values: string[] = candidate.aliases,
): ContentQuery {
  return {
    name: `${candidate.id}|${field}`,
    operator: "and",
    filters: textFilter(field, values),
  };
}

export interface PullOptions {
  since?: string;
  until?: string;
  platforms?: Platform[];
  fields?: SourceField[];
  includeWeakAliases?: boolean;
}

function globalFilters(options: PullOptions): ContentFilters {
  const filters: ContentFilters = {};
  if (options.since || options.until) {
    filters.publishedAt = {};
    if (options.since) filters.publishedAt.after = options.since;
    if (options.until) filters.publishedAt.before = options.until;
  }
  if (options.platforms?.length) {
    filters.platform = { includes: options.platforms, operator: "and" };
  }
  return filters;
}

/**
 * THE CANONICAL SHAPE.
 *
 *   root { operator: "and", filters: <global>, queries: [ { operator: "or",
 *     queries: [ per-candidate-per-field sub-queries ] } ] }
 *
 * Two traps this shape avoids, both verified against the live API:
 *  - Putting global filters as siblings of the OR sub-queries with operator
 *    "and" collapses the OR group into an AND (an all-three-fields match).
 *  - Using operator "or" at the root ORs the global filters with the sub-queries,
 *    so a language filter alone starts matching everything.
 * The nested wrapper is one level of nesting, within Oriane's two-level limit.
 */
export function buildCandidateQuery(
  candidates: CandidateDef[],
  options: PullOptions = {},
): ContentQuery {
  const fields = options.fields ?? TEXT_FIELDS;
  const subQueries: ContentQuery[] = [];

  for (const candidate of candidates) {
    const variants = options.includeWeakAliases
      ? [...candidate.aliases, ...candidate.weakAliases]
      : candidate.aliases;
    for (const field of fields) {
      subQueries.push(candidateFieldQuery(candidate, field, variants));
    }
  }

  const filters = globalFilters(options);
  const body: ContentQuery = { operator: "and", queries: [{ operator: "or", queries: subQueries }] };
  if (Object.keys(filters).length > 0) body.filters = filters;
  return body;
}

/** Topic discovery query (no candidate names): the election lexicon only. */
export function buildTopicQuery(
  terms: string[],
  options: PullOptions = {},
): ContentQuery {
  const fields = options.fields ?? TEXT_FIELDS;
  const subQueries = fields.map((field) => ({
    name: `topic|${field}`,
    operator: "and" as const,
    filters: textFilter(field, terms),
  }));
  const filters = globalFilters(options);
  const body: ContentQuery = { operator: "and", queries: [{ operator: "or", queries: subQueries }] };
  if (Object.keys(filters).length > 0) body.filters = filters;
  return body;
}

/** Image / carousel posts only — the caption and the overlay carry the message. */
export function buildImagePostQuery(
  candidates: CandidateDef[],
  options: PullOptions = {},
): ContentQuery {
  const body = buildCandidateQuery(candidates, options);
  body.filters = { ...(body.filters ?? {}), format: { includes: ["image", "carousel"] } };
  return body;
}
