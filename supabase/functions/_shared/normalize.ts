import type {
  CandidateDef,
  FieldScan,
  MatchStrength,
  SourceField,
  TermHit,
  VideoFormat,
} from "./types.ts";

/**
 * Deterministic normalization used by the matcher, the French detector and the
 * evidence check. Mirrors the `norm()` in the idea doc: lowercase, strip
 * combining accents, turn separators into single spaces.
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, " ")
    .replace(/[-_#@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const ACCENT_GROUPS: Record<string, string> = {
  a: "aàâäáãå",
  c: "cç",
  e: "eéèêë",
  i: "iîïíì",
  n: "nñ",
  o: "oôöóòõ",
  s: "sš",
  u: "uûüúù",
  y: "yÿý",
  z: "zž",
};

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a regex that matches `alias` in the original text while tolerating
 * accents, case, hyphens and collapsed spaces, so "Mélenchon", "MELENCHON",
 * "melanchon" and "Le Pen"/"LePen" are handled without edit distance.
 * Offsets are indices into the ORIGINAL string, which is what the UI needs to
 * highlight the evidence.
 *
 * The returned pattern is NOT global: callers can test() it repeatedly without
 * lastIndex state leaking between calls.
 */
export function aliasPattern(alias: string): RegExp {
  const chars = [...alias.toLowerCase()];
  const body = chars
    .map((ch) => {
      if (/\s/.test(ch) || ch === "-" || ch === "_") return "[\\s\\-_.]*";
      const folded = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const group = ACCENT_GROUPS[folded];
      if (group) return `[${group}]`;
      return escapeRegex(folded);
    })
    .join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** Same pattern, global, for iterating matches with matchAll(). */
export function aliasPatternGlobal(alias: string): RegExp {
  return new RegExp(aliasPattern(alias).source, "giu");
}

/** Scans one field's original text for one candidate's aliases. */
export function scanCandidate(
  text: string | null | undefined,
  candidate: CandidateDef,
): TermHit[] {
  if (!text) return [];

  // Keyed by span, so "Marine Le Pen" and "Marine LePen" matching the same
  // characters produce one occurrence, not two.
  const claimed = new Map<string, { start: number; end: number; term: string; strength: MatchStrength }>();

  const collect = (aliases: string[], strength: MatchStrength) => {
    for (const alias of aliases) {
      const pattern = aliasPatternGlobal(alias);
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        const key = `${start}:${end}`;
        const existing = claimed.get(key);
        if (!existing || alias.length > existing.term.length) {
          claimed.set(key, { start, end, term: alias, strength });
        }
      }
    }
  };

  collect(candidate.aliases, "strong");
  collect(candidate.weakAliases, "weak");

  const spans = [...claimed.values()].sort((a, b) => a.start - b.start);
  const strongSpans = spans.filter((span) => span.strength === "strong");
  // A bare "Le Pen" inside "Marine Le Pen" is not a separate weak mention.
  const kept = spans.filter(
    (span) =>
      span.strength === "strong" ||
      !strongSpans.some((strong) => strong.start <= span.start && span.end <= strong.end),
  );

  const byTerm = new Map<string, TermHit>();
  for (const span of kept) {
    let hit = byTerm.get(span.term);
    if (!hit) {
      hit = {
        candidateId: candidate.id,
        term: span.term,
        strength: span.strength,
        count: 0,
        occurrences: [],
      };
      byTerm.set(span.term, hit);
    }
    hit.occurrences.push({ start: span.start, end: span.end });
    hit.count++;
  }
  return [...byTerm.values()];
}

/**
 * Party names are a separate, weaker signal: they are stored on the video for
 * context but never promoted to a candidate mention.
 */
export function scanPartySignals(
  candidate: CandidateDef,
  texts: Array<string | null | undefined>,
): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const signal of candidate.partySignals) {
      const pattern = aliasPattern(signal);
      if (pattern.test(text)) found.add(signal);
    }
  }
  return [...found];
}

export function scanFields(
  fields: Array<{ field: SourceField; text: string | null | undefined; index?: number }>,
  candidate: CandidateDef,
): FieldScan[] {
  const out: FieldScan[] = [];
  for (const { field, text, index } of fields) {
    const hits = scanCandidate(text, candidate);
    if (hits.length === 0) continue;
    if (index !== undefined) {
      for (const hit of hits) {
        hit.term = `onscreen[${index}] ${hit.term}`;
      }
    }
    out.push({ field, hits });
  }
  return out;
}

const FRENCH_STOPWORDS = new Set([
  "le","la","les","de","des","du","un","une","et","en","que","qui","pour","pas",
  "sur","dans","au","aux","ce","cet","cette","ces","il","elle","on","nous",
  "vous","ils","elles","avec","est","sont","plus","mais","comme","tout","tous",
  "faire","dit","dire","a","à","se","sa","son","ses","leur","leurs","être",
  "avoir","même","très","bien","je","tu","mon","ma","mes","y","ne","sans",
  "comme","quand","alors","donc","car","si","oui","non","c'est","j'ai",
]);

/**
 * Deterministic French detection on caption + transcript, used instead of a
 * language filter because Oriane's `transcriptLanguage` drops image posts that
 * have no transcript at all.
 */
export function detectFrench(
  texts: Array<string | null | undefined>,
  declaredLanguages: Array<string | null | undefined> = [],
): { isFrench: boolean; score: number; reason: string } {
  const declared = declaredLanguages.filter(Boolean) as string[];
  if (declared.includes("fr")) {
    return { isFrench: true, score: 1, reason: "language field = fr" };
  }
  const text = texts.filter(Boolean).join(" ");
  const tokens = normalizeText(text).split(" ").filter((t) => t.length > 1);
  if (tokens.length < 8) {
    return { isFrench: false, score: 0, reason: "too little text" };
  }
  let hits = 0;
  for (const token of tokens) if (FRENCH_STOPWORDS.has(token)) hits++;
  const score = hits / tokens.length;
  return {
    isFrench: score >= 0.12,
    score,
    reason: `stopword ratio ${score.toFixed(3)}`,
  };
}

/**
 * idea.md rule: a short or empty transcript plus on-screen text is an image
 * post, whatever the platform calls the format.
 */
export function classifyFormat(
  platformFormat: string | null | undefined,
  transcript: string | null | undefined,
): VideoFormat {
  const words = normalizeText(transcript).split(" ").filter(Boolean).length;
  if (platformFormat === "image" || platformFormat === "carousel") {
    return "image_post";
  }
  return words < 40 ? "image_post" : "talking";
}

/** Exact-substring evidence check. Whitespace is normalized, nothing else. */
export function evidenceIsVerbatim(
  quote: string | null | undefined,
  sourceText: string | null | undefined,
): boolean {
  if (!quote || !sourceText) return false;
  const needle = collapseSpaces(quote);
  const haystack = collapseSpaces(sourceText);
  if (needle.length < 3) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function buildVideoUrl(
  platform: string,
  platformId: string,
  handle: string | null,
  platformType: string | null,
): string {
  switch (platform) {
    case "youtube":
      return platformType === "short"
        ? `https://www.youtube.com/shorts/${platformId}`
        : `https://www.youtube.com/watch?v=${platformId}`;
    case "tiktok":
      return handle
        ? `https://www.tiktok.com/@${handle.replace(/^@/, "")}/video/${platformId}`
        : `https://www.tiktok.com/video/${platformId}`;
    case "instagram":
      return platformType === "reel"
        ? `https://www.instagram.com/reel/${platformId}/`
        : `https://www.instagram.com/p/${platformId}/`;
    default:
      return "";
  }
}
