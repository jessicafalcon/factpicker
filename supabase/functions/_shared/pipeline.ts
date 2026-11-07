import { CANDIDATES } from "./candidates.ts";
import {
  classifyFormat,
  detectFrench,
  buildVideoUrl,
  scanCandidate,
  scanPartySignals,
} from "./normalize.ts";
import type { OrianeClient, OrianeContent, PullOptions, SearchParams } from "./oriane.ts";
import { buildCandidateQuery } from "./oriane.ts";
import type { CandidateDef, MentionRow, SourceField, VideoRow } from "./types.ts";

export function recordText(record: OrianeContent) {
  const media = record.media?.[0];
  const onScreenText = media?.onScreenText ?? [];
  return {
    transcript: media?.transcript ?? "",
    caption: record.caption ?? media?.caption ?? "",
    onScreenText,
    transcriptLanguage: media?.transcriptLanguage ?? null,
    captionLanguage: record.captionLanguage ?? null,
    duration: media?.duration ?? null,
    visualTags: [] as string[],
  };
}

export function toVideoRow(record: OrianeContent): VideoRow {
  const text = recordText(record);
  const french = detectFrench(
    [text.caption, text.transcript, text.onScreenText.join(" ")],
    [text.transcriptLanguage, text.captionLanguage],
  );
  const partySignals = new Set<string>();
  for (const candidate of CANDIDATES) {
    for (const signal of scanPartySignals(candidate, [text.caption, text.transcript, text.onScreenText.join(" ")])) {
      partySignals.add(signal);
    }
  }

  return {
    id: record.id,
    platform: record.platform,
    platform_id: record.platformId ?? null,
    url: buildVideoUrl(record.platform, record.platformId, record.profileHandle, record.platformType),
    creator_handle: record.profileHandle ?? null,
    creator_display_name: record.profileDisplayName ?? null,
    creator_followers: record.profileFollowersCount ?? null,
    creator_verified: record.profileVerified ?? null,
    posted_at: record.publishedAt ?? null,
    views: record.viewsCount ?? null,
    likes: record.likesCount ?? null,
    shares: record.sharesCount ?? null,
    comments: record.commentsCount ?? null,
    interactions: record.interactionsCount ?? null,
    title: record.title ?? null,
    caption: text.caption || null,
    caption_language: text.captionLanguage,
    transcript: text.transcript || null,
    transcript_language: text.transcriptLanguage,
    on_screen_text: text.onScreenText,
    visual_tags: text.visualTags,
    platform_format: record.format ?? null,
    format: classifyFormat(record.format, text.transcript),
    duration_seconds: text.duration === null ? null : Number(text.duration.toFixed(2)),
    thumbnail_url: record.thumbnailMediaUrl ?? null,
    is_french: french.isFrench,
    party_signals: [...partySignals],
    source: "oriane",
  };
}

/**
 * Mentions come from local deterministic matching over the FULL record, not
 * from the discovery query. A video found by searching "Marine Le Pen" may also
 * mock Édouard Philippe; only local scanning catches that, and it keeps the
 * matched terms (and their offsets) for the evidence highlight.
 */
export function buildMentions(
  record: OrianeContent,
  candidates: CandidateDef[] = CANDIDATES,
): MentionRow[] {
  const text = recordText(record);
  const rows: MentionRow[] = [];

  for (const candidate of candidates) {
    const perField: Array<{ field: SourceField; key: string; text: string }> = [
      { field: "transcript", key: "transcript", text: text.transcript },
      { field: "caption", key: "caption", text: text.caption },
    ];
    text.onScreenText.forEach((value, index) => {
      perField.push({ field: "on_screen_text", key: `on_screen_text[${index}]`, text: value ?? "" });
    });

    for (const { field, key, text: value } of perField) {
      if (!value) continue;
      const hits = scanCandidate(value, candidate);
      if (hits.length === 0) continue;

      const strength = hits.some((h) => h.strength === "strong") ? "strong" : "weak";
      rows.push({
        video_id: record.id,
        candidate_id: candidate.id,
        matched_terms: hits.map((h) => h.term),
        source_field: field,
        source_key: key,
        strength,
        occurrences: hits.flatMap((h) => h.occurrences),
      });
    }
  }

  return rows;
}

export interface IngestOptions extends PullOptions {
  /** How many videos to take per candidate before deduplication. */
  perCandidate?: number;
  sort?: string;
  projection?: SearchParams["projection"];
  onProgress?: (event: { candidate: string; total: number | null; fetched: number; elapsedMs: number }) => void;
}

export interface IngestResult {
  videos: VideoRow[];
  mentions: MentionRow[];
  stats: {
    requests: number;
    fetched: number;
    unique: number;
    french: number;
    withTranscript: number;
    imagePosts: number;
    perCandidate: Record<string, number>;
    duplicateHits: number;
    elapsedMs: number;
  };
}

/**
 * Balanced pull: one query per candidate so a low-volume candidate
 * (Cazeneuve, Ruffin) is not buried by the OR-query pagination of a
 * high-volume one (Le Pen, Mélenchon).
 */
/**
 * Full ingest used by the CLI and the edge function: balanced pull, then local
 * mention extraction over every record, so one video can mention N candidates.
 */
export async function ingestWithMentions(
  client: OrianeClient,
  candidates: CandidateDef[] = CANDIDATES,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const startedAt = Date.now();
  const perCandidate = options.perCandidate ?? 30;
  const records = new Map<string, OrianeContent>();
  const perCandidateCounts: Record<string, number> = {};
  let requests = 0;
  let fetched = 0;
  let duplicateHits = 0;

  for (const candidate of candidates) {
    const body = buildCandidateQuery([candidate], options);
    let taken = 0;
    const limit = Math.min(100, perCandidate);
    let offset = 0;
    while (taken < perCandidate) {
      const page = await client.searchContents(body, {
        limit,
        offset,
        projection: options.projection ?? "full",
        sort: options.sort ?? "viewsCount:desc",
      });
      requests++;
      if (!page.records.length) break;
      for (const record of page.records) {
        fetched++;
        if (records.has(record.id)) {
          duplicateHits++;
          continue;
        }
        records.set(record.id, record);
        taken++;
        if (taken >= perCandidate) break;
      }
      offset += page.records.length;
      if (page.totalCount !== null && offset >= page.totalCount) break;
      if (page.records.length < limit) break;
    }
    perCandidateCounts[candidate.id] = taken;
    options.onProgress?.({
      candidate: candidate.id,
      total: taken,
      fetched,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const videos: VideoRow[] = [];
  const mentions: MentionRow[] = [];
  const mentionKeys = new Set<string>();
  for (const record of records.values()) {
    videos.push(toVideoRow(record));
    for (const mention of buildMentions(record, candidates)) {
      const key = `${mention.video_id}|${mention.candidate_id}|${mention.source_key}`;
      if (mentionKeys.has(key)) continue;
      mentionKeys.add(key);
      mentions.push(mention);
    }
  }

  return {
    videos,
    mentions,
    stats: {
      requests,
      fetched,
      unique: videos.length,
      french: videos.filter((v) => v.is_french).length,
      withTranscript: videos.filter((v) => (v.transcript ?? "").length > 0).length,
      imagePosts: videos.filter((v) => v.format === "image_post").length,
      perCandidate: perCandidateCounts,
      duplicateHits,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

export function summarizeMentions(mentions: MentionRow[]) {
  const strong = new Map<string, number>();
  const weak = new Map<string, number>();
  for (const mention of mentions) {
    const bucket = mention.strength === "strong" ? strong : weak;
    bucket.set(mention.candidate_id, (bucket.get(mention.candidate_id) ?? 0) + 1);
  }
  return { strong: Object.fromEntries(strong), weak: Object.fromEntries(weak) };
}



