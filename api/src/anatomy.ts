/**
 * "Anatomy of an opinion": one video, cut into the three annotated steps the
 * entry page shows.
 *
 *   1. THE FACT      — the sentence where the creator states the fact
 *   2. WHAT THEY SAY IT MEANS — the interpretation that follows it
 *   3. THE VERDICT   — the quote behind the stance label, and who it targets
 *
 * Every segment is a verbatim slice of a single cleaned source text, with
 * `start`/`end` offsets into it and `composedStart`/`composedEnd` into the
 * joined quote. The styles are the legend from the brief: fact = solid ink
 * underline, meaning = dotted ochre underline, verdict = filled ochre.
 */
import { aliasPattern } from "../../supabase/functions/_shared/normalize.ts";
import type { Index } from "./derive.ts";
import type { FactDef } from "./sources.ts";
import type { VideoRow } from "../../supabase/functions/_shared/types.ts";

export type AnatomyRole = "OPENING" | "FACT" | "MEANING" | "VERDICT";

export const LEGEND: Record<AnatomyRole, { underline: string; tone: string; fill: boolean; className: string; legend: string; description: string }> = {
  OPENING: {
    underline: "none",
    tone: "ink",
    fill: false,
    className: "anatomy-segment--opening",
    legend: "Opening",
    description: "The creator's opening words, shortened.",
  },
  FACT: {
    underline: "solid",
    tone: "ink",
    fill: false,
    className: "anatomy-segment--fact",
    legend: "1 · THE FACT",
    description: "Matched to our fact list and checked against the source.",
  },
  MEANING: {
    underline: "dotted",
    tone: "ochre",
    fill: false,
    className: "anatomy-segment--meaning",
    legend: "2 · WHAT THEY SAY IT MEANS",
    description: "The creator's interpretation. We record it; we don't judge it.",
  },
  VERDICT: {
    underline: "none",
    tone: "ochre",
    fill: true,
    className: "anatomy-segment--verdict",
    legend: "3 · THE VERDICT",
    description: "Who it is aimed at, and whether it is for or against them.",
  },
};

export interface AnatomySegment {
  role: AnatomyRole;
  text: string;
  source: "transcript" | "caption" | "on_screen_text";
  start: number;
  end: number;
  composedStart: number;
  composedEnd: number;
  truncated: boolean;
  style: (typeof LEGEND)[AnatomyRole];
}

export interface Anatomy {
  videoId: string;
  composed: string;
  segments: AnatomySegment[];
  fact: { id: string; statement: string; sourceName: string | null; verified: boolean } | null;
  verdict: { candidateId: string; leaning: string; quote: string | null; verified: boolean; confidence: string } | null;
  attribution: {
    handle: string;
    platform: string;
    views: number | null;
    postedAt: string | null;
    thumbnailUrl: string | null;
    url: string;
    format: string;
  };
  coverage: "full" | "no_fact" | "no_meaning" | "no_verdict" | "no_text";
  /** 0..1 — how usable this video is as a three-step entry card. */
  quality: number;
  qualityNotes: string[];
}

// ── Cleaning: one source text, offsets computed after cleaning ────────────
export function cleanText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\p{L}\p{N}_]+/gu, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/[\uFE0F\u200D\u20E3]/g, "")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Sentence {
  start: number;
  end: number;
  text: string;
}

export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!".!?…".includes(text[index])) continue;
    const end = index + 1;
    const slice = text.slice(start, end).trim();
    if (slice) out.push({ start, end, text: slice });
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ start, end: text.length, text: tail });
  return out;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Accent- and case-tolerant span lookup that still returns raw offsets. */
export function findSpan(text: string, needle: string): { start: number; end: number } | null {
  const clean = needle.trim();
  if (clean.length < 3) return null;
  const direct = text.toLowerCase().indexOf(clean.toLowerCase());
  if (direct >= 0) return { start: direct, end: direct + clean.length };
  const match = aliasPattern(clean).exec(text);
  if (match && match.index !== undefined) return { start: match.index, end: match.index + match[0].length };
  // Last resort: first 6 words, which survives small ellipses in the quote.
  const head = clean.split(/\s+/).slice(0, 6).join(" ");
  if (head.length >= 12) {
    const partial = aliasPattern(head).exec(text);
    if (partial && partial.index !== undefined) return { start: partial.index, end: partial.index + partial[0].length };
  }
  return null;
}

const sentenceAt = (list: Sentence[], offset: number): Sentence | null =>
  list.find((sentence) => offset >= sentence.start && offset < sentence.end) ?? null;

const capAround = (text: string, start: number, end: number, max = 220, _focus?: { start: number; end: number }) => {
  if (end - start <= max) return { start, end, truncated: false };
  // Always start at the segment's beginning and cut the tail on a word
  // boundary. Sliding the window to chase a quote produces fragments like
  // "dis qu'un ..." and broken hyphenated words like "petit-".
  let slice = text.slice(start, start + max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 40) slice = slice.slice(0, lastSpace);
  slice = slice.replace(/[\s\-–—,;:]+$/u, "");
  return { start, end: start + slice.length, truncated: true };
};

const prefixWords = (sentence: Sentence, words = 12) => {
  let seen = 0;
  let index = sentence.start;
  for (; index < sentence.end; index++) {
    if (sentence.text[index - sentence.start] === " ") seen++;
    if (seen >= words) break;
  }
  const end = Math.min(sentence.end, index);
  return { start: sentence.start, end, truncated: end < sentence.end };
};

const PUNCT = /[,;:]\s+/;

/** The exact text the offsets refer to. Exported so tests and the artifact
 *  builder cannot disagree with the extractor. */
export function sourceTextOf(video: VideoRow): { source: AnatomySegment["source"]; text: string } {
  const transcript = cleanText(video.transcript ?? "");
  const caption = cleanText(video.caption ?? "");
  const onScreen = cleanText((video.on_screen_text ?? []).join(" \n "));
  const source: AnatomySegment["source"] = transcript.length >= 80 ? "transcript" : caption.length ? "caption" : "on_screen_text";
  return { source, text: source === "transcript" ? transcript : source === "caption" ? caption : onScreen };
}

function buildAnatomyUncached(index: Index, videoId: string, facts?: FactDef[]): Anatomy | null {
  const video = index.videoById.get(videoId);
  if (!video) return null;
  const factCatalog = facts ?? index.dataset.facts;
  const { source, text } = sourceTextOf(video);

  const platformId = (video as any).platform_id ?? null;
  const embedUrl = platformId
    ? video.platform === "tiktok"
      ? `https://www.tiktok.com/embed/v2/${platformId}`
      : video.platform === "instagram"
        ? `https://www.instagram.com/p/${platformId}/embed`
        : video.platform === "youtube"
          ? `https://www.youtube.com/embed/${platformId}`
          : null
    : null;
  const attribution = {
    handle: video.creator_handle ?? "unknown",
    platform: video.platform,
    platformId,
    embedUrl,
    views: video.views ?? null,
    postedAt: video.posted_at ?? null,
    thumbnailUrl: video.thumbnail_url ?? null,
    url: video.url,
    format: video.format,
  };

  if (text.length < 40) {
    return { videoId, composed: text, segments: [], fact: null, verdict: null, attribution, coverage: "no_text", quality: 0, qualityNotes: ["no usable text"] };
  }

  const list = sentences(text);

  // ── 1. THE FACT ─────────────────────────────────────────────────────────
  let matchedFact: FactDef | null = null;
  let factSpan: { start: number; end: number } | null = null;
  for (const fact of factCatalog) {
    for (const term of [...fact.anchorTerms].sort((a, b) => b.length - a.length)) {
      const span = findSpan(text, term);
      if (span) {
        matchedFact = fact;
        factSpan = span;
        break;
      }
    }
    if (matchedFact) break;
  }

  // ── 3. THE VERDICT (resolved first: the meaning must not duplicate it) ──
  const rows = [...(index.stanceByVideo.get(videoId) ?? [])]
    .filter((row) => row.label !== "unclear" && (row.evidence_mode === "exact" || row.evidence_mode === "fuzzy"))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const best = rows[0];
  let verdictSpan: { start: number; end: number } | null = null;
  if (best?.quote) verdictSpan = findSpan(text, best.quote);
  if (!verdictSpan && best) {
    const candidate = index.candidateById.get(best.candidate_id);
    if (candidate) {
      for (const alias of [candidate.name, ...(candidate.weakAliases ?? [])]) {
        const span = findSpan(text, alias);
        if (span) {
          const sentence = sentenceAt(list, span.start);
          if (sentence) verdictSpan = { start: sentence.start, end: sentence.end };
          break;
        }
      }
    }
  }

  // ── Segments ────────────────────────────────────────────────────────────
  const segments: Array<Omit<AnatomySegment, "composedStart" | "composedEnd">> = [];
  const firstSentence = list[0] ?? null;
  const factSentence = factSpan ? sentenceAt(list, factSpan.start) : null;

  // A fact needs enough text to read as a statement. A one-word sentence
  // ("OQTF.") is a keyword hit, not an explanation, so it is not promoted.
  const factUsable = Boolean(
    matchedFact && factSpan && factSentence && factSentence.end - factSentence.start >= 24,
  );
  const factStart = factUsable && factSentence && factSpan
    ? (factSentence.end - factSentence.start <= 220
      ? factSentence.start
      : Math.max(factSentence.start, (() => {
        let from = Math.max(factSentence.start, factSpan.start - 60);
        while (from > factSentence.start && text[from - 1] !== " ") from--;
        return from;
      })()))
    : null;

  // Opening: the words before the fact, never overlapping it.
  if (firstSentence) {
    const limit = factStart !== null ? Math.min(firstSentence.end, factStart) : firstSentence.end;
    const head = prefixWords({ ...firstSentence, end: limit }, 12);
    const openingText = text.slice(0, head.end).trim();
    if (openingText.length >= 8) {
      segments.push({ role: "OPENING", text: openingText, source, start: 0, end: head.end, truncated: head.end < (factSentence?.end ?? firstSentence.end), style: LEGEND.OPENING });
    }
  }

  if (factUsable && factSentence && factStart !== null) {
    const factEnd = capAround(text, factStart, factSentence.end, 150, factSpan ?? undefined).end;
    segments.push({
      role: "FACT",
      text: text.slice(factStart, factEnd).trim(),
      source,
      start: factStart,
      end: factEnd,
      truncated: factEnd < factSentence.end,
      style: LEGEND.FACT,
    });
  }

  // Meaning: the next sentence, unless that sentence is the verdict.
  let meaningAdded = false;
  if (factSentence) {
    const position = list.indexOf(factSentence);
    const next = list[position + 1];
    const overlapsVerdict = next && verdictSpan && verdictSpan.start < next.end && verdictSpan.end > next.start;
    if (next && !overlapsVerdict) {
      const capped = capAround(text, next.start, next.end, 160);
      segments.push({ role: "MEANING", text: text.slice(capped.start, capped.end).trim(), source, start: capped.start, end: capped.end, truncated: capped.truncated, style: LEGEND.MEANING });
      meaningAdded = true;
    }
  }

  // Verdict: only when it is not the same text as the fact or the meaning.
  let verdictAdded = false;
  if (best && verdictSpan) {
    const overlapsFact = factSpan && verdictSpan.start < factSpan.end && verdictSpan.end > factSpan.start;
    const meaningSegment = segments.find((segment) => segment.role === "MEANING");
    const overlapsMeaning = meaningSegment && verdictSpan.start < meaningSegment.end && verdictSpan.end > meaningSegment.start;
    if (!overlapsFact && !overlapsMeaning) {
      const sentence = sentenceAt(list, verdictSpan.start);
      // The verdict is the highlighted block: keep it to one short clause so the
      // card stays balanced and the quote remains readable.
      const capped = sentence ? capAround(text, sentence.start, sentence.end, 100, verdictSpan) : { ...verdictSpan, truncated: false };
      segments.push({ role: "VERDICT", text: text.slice(capped.start, capped.end).trim(), source, start: capped.start, end: capped.end, truncated: capped.truncated, style: LEGEND.VERDICT });
      verdictAdded = true;
    }
  }

  // ── Accept in text order, dropping overlaps and duplicates ──────────────
  const accepted: typeof segments = [];
  for (const segment of segments.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = accepted[accepted.length - 1];
    if (previous && segment.start < previous.end) continue;
    if (accepted.some((item) => item.text === segment.text)) continue;
    accepted.push(segment);
  }
  const roles = new Set(accepted.map((segment) => segment.role));
  const coverage = !factUsable || !roles.has("FACT")
    ? "no_fact"
    : !roles.has("MEANING")
      ? "no_meaning"
      : !roles.has("VERDICT")
        ? "no_verdict"
        : "full";

  // ── Compose in the design's step order ─────────────────────────────────
  // Each segment keeps its own verbatim source span; the composed quote is a
  // curated sequence (opening → fact → meaning → verdict), as in the brief.
  const ROLE_ORDER: Record<AnatomyRole, number> = { OPENING: 0, FACT: 1, MEANING: 2, VERDICT: 3 };
  const parts: AnatomySegment[] = [];
  let cursor = 0;
  accepted.slice().sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]).forEach((segment, position) => {
    if (position > 0) cursor += 1; // the joining space
    const composedStart = cursor;
    cursor += segment.text.length;
    parts.push({ ...segment, composedStart, composedEnd: cursor });
  });

  return {
    videoId,
    composed: parts.map((segment) => segment.text).join(" "),
    segments: parts,
    fact: matchedFact
      ? { id: matchedFact.id, statement: matchedFact.statement, sourceName: matchedFact.sourceName, verified: matchedFact.verified }
      : null,
    verdict: best
      ? {
        candidateId: best.candidate_id,
        leaning: best.label,
        quote: best.quote ?? null,
        verified: best.evidence_mode === "exact" || best.evidence_mode === "fuzzy",
        confidence: best.evidence_mode === "exact" ? "high" : "medium",
      }
      : null,
    attribution,
    coverage,
    ...scoreQuality(accepted, coverage),
  };
}

/**
 * Entry cards need readable segments: a 20-character opening, a statement for
 * the fact, an interpretation longer than an interjection, and a verdict that
 * is not a fragment. ASR transcripts without punctuation fail this, which is
 * correct — they are not good entry material.
 */
function scoreQuality(
  segments: Array<{ role: AnatomyRole; text: string; truncated?: boolean }>,
  coverage: string,
): { quality: number; qualityNotes: string[] } {
  const notes: string[] = [];
  const byRole = new Map(segments.map((segment) => [segment.role, segment]));
  const length = (role: AnatomyRole) => (byRole.get(role)?.text.trim().length ?? 0);
  let score = 0;

  if (length("OPENING") >= 20) score += 0.15; else notes.push("opening short or missing");
  if (length("FACT") >= 30) score += 0.3; else notes.push("fact too short");
  if (length("MEANING") >= 30) score += 0.25; else notes.push("meaning too short");
  if (length("VERDICT") >= 25) score += 0.2; else notes.push("verdict too short");

  const composed = segments.map((segment) => segment.text).join(" ");
  const punctuation = (composed.match(/[.!?…]/g) ?? []).length;
  if (punctuation >= 2) score += 0.06; else notes.push("punctuation sparse");
  const words = composed.split(/\s+/).filter(Boolean);
  const uniqueRatio = new Set(words.map((word) => word.toLowerCase())).size / Math.max(words.length, 1);
  if (uniqueRatio >= 0.55) score += 0.04; else notes.push("repetitive transcript");
  if (coverage !== "full") notes.push(`coverage: ${coverage}`);

  return { quality: coverage === "full" ? Number(Math.min(score, 1).toFixed(2)) : Number((score * 0.5).toFixed(2)), qualityNotes: notes };
}

/** Entry-page selection: full anatomies first, then reach, one video per creator. */
const anatomyCache = new WeakMap<object, Map<string, unknown>>();
function cached<T>(index: object, key: string, compute: () => T): T {
  let cache = anatomyCache.get(index);
  if (!cache) {
    cache = new Map();
    anatomyCache.set(index, cache);
  }
  if (cache.has(key)) return cache.get(key) as T;
  const value = compute();
  cache.set(key, value);
  return value;
}

function selectEntryUncached(index: Index, limit = 6): Array<{ videoId: string; anatomy: Anatomy }> {
  const all = index.dataset.videos
    .slice()
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .map((video) => buildAnatomy(index, video.id))
    .filter((anatomy): anatomy is Anatomy => Boolean(anatomy));

  const rank = (anatomy: Anatomy) =>
    anatomy.quality * 1e15 +
    (anatomy.coverage === "full" ? 4 : anatomy.coverage === "no_verdict" ? 2 : anatomy.coverage === "no_meaning" ? 1 : 0) * 1e12 +
    (anatomy.attribution.views ?? 0);

  const seen = new Set<string>();
  const out: Array<{ videoId: string; anatomy: Anatomy }> = [];
  for (const anatomy of all.filter((item) => item.coverage === "full" && item.quality >= 0.6).sort((a, b) => rank(b) - rank(a))) {
    const key = anatomy.attribution.handle;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ videoId: anatomy.videoId, anatomy });
    if (out.length >= limit) break;
  }
  // The brief opens on the 17 October thread: guarantee one video from it.
  const protest = index.eventById.get("protest_17_october");
  if (protest) {
    const candidate = (protest.video_ids as string[])
      .map((id) => buildAnatomy(index, id))
      .filter((anatomy): anatomy is Anatomy => Boolean(anatomy) && anatomy!.coverage === "full" && anatomy!.quality >= 0.6)
      .sort((a, b) => (b.attribution.views ?? 0) - (a.attribution.views ?? 0))[0];
    if (candidate && !out.some((item) => item.videoId === candidate.videoId)) {
      out.pop();
      out.unshift({ videoId: candidate.videoId, anatomy: candidate });
    }
  }
  return out;
}

export function buildAnatomy(index: Index, videoId: string, facts?: FactDef[]): Anatomy | null {
  return cached(index, `anatomy:${videoId}`, () => buildAnatomyUncached(index, videoId, facts));
}

export function selectEntry(index: Index, limit = 6): Array<{ videoId: string; anatomy: Anatomy }> {
  return cached(index, `entry:${limit}`, () => selectEntryUncached(index, limit));
}
