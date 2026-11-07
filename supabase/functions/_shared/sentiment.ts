import type { CandidateDef, VideoRow } from "./types.ts";
import { aliasPatternGlobal, normalizeText, scanCandidate } from "./normalize.ts";

/**
 * Basic stance detection for French political video.
 *
 * Two principles from the idea doc, carried over here:
 *  1. Deterministic first. A curated lexicon plus proximity to the candidate
 *     mention produces an auditable score with the exact markers that drove it.
 *     Vertex AI only fills in what the lexicon cannot read (see vertex.ts).
 *  2. Describe the post, never the person. The output is "N of this handle's
 *     videos favour X", not "this creator is biased".
 *
 * Scope by design: caption and on-screen text carry the stance, because that is
 * what the creator typed and what the viewer reads before pressing play. The
 * transcript is a fallback only, and it is labelled as such.
 */

export type StancePolarity = "positive" | "negative";

export interface StanceMarker {
  term: string;
  polarity: StancePolarity;
  weight: number;
  field: "caption" | "on_screen_text" | "transcript";
  start: number;
  end: number;
  negated: boolean;
  text: string;
}

export interface StanceScore {
  /** -1 (hostile) to +1 (supportive). 0 with no markers means "no signal". */
  score: number;
  /** Verbatim snippets that drove the score, sliced from the source field. */
  quote: string;
  quoteField: "caption" | "on_screen_text" | "transcript" | null;
  positive: number;
  negative: number;
  markers: StanceMarker[];
  basis: "caption+on_screen_text" | "on_screen_text" | "caption" | "transcript_fallback" | "none";
  confidence: "low" | "medium" | "high";
  /** True when the lexicon found nothing either way. */
  unclear: boolean;
}

interface LexiconEntry {
  term: string;
  polarity: StancePolarity;
  weight: number;
  /** Descriptive labels that leak into political speech but do not by
   *  themselves express a stance ("extrême droite", "libéral"). */
  descriptive?: boolean;
}

/** Weighted French lexicon. Weight 2 = explicit praise/attack, 1 = leaning,
 *  0.5 = weak or descriptive cue. */
export const LEXICON: LexiconEntry[] = [
  // ── Positive ────────────────────────────────────────────────────────────
  { term: "soutien", polarity: "positive", weight: 2 },
  { term: "soutenir", polarity: "positive", weight: 2 },
  { term: "soutiens", polarity: "positive", weight: 2 },
  { term: "je vote pour", polarity: "positive", weight: 2 },
  { term: "vote pour", polarity: "positive", weight: 2 },
  { term: "voter pour", polarity: "positive", weight: 2 },
  { term: "avec elle", polarity: "positive", weight: 1 },
  { term: "avec lui", polarity: "positive", weight: 1 },
  { term: "meilleur", polarity: "positive", weight: 2 },
  { term: "meilleure", polarity: "positive", weight: 2 },
  { term: "capable", polarity: "positive", weight: 1.5 },
  { term: "courage", polarity: "positive", weight: 2 },
  { term: "courageux", polarity: "positive", weight: 2 },
  { term: "courageuse", polarity: "positive", weight: 2 },
  { term: "respect", polarity: "positive", weight: 1.5 },
  { term: "espoir", polarity: "positive", weight: 1 },
  { term: "esperance", polarity: "positive", weight: 1 },
  { term: "rassembler", polarity: "positive", weight: 1.5 },
  { term: "credible", polarity: "positive", weight: 1.5 },
  { term: "competent", polarity: "positive", weight: 2 },
  { term: "competente", polarity: "positive", weight: 2 },
  { term: "honnete", polarity: "positive", weight: 2 },
  { term: "determine", polarity: "positive", weight: 1 },
  { term: "bravo", polarity: "positive", weight: 2 },
  { term: "chapeau", polarity: "positive", weight: 1.5 },
  { term: "formidable", polarity: "positive", weight: 1.5 },
  { term: "magnifique", polarity: "positive", weight: 1 },
  { term: "a raison", polarity: "positive", weight: 1.5 },
  { term: "il a raison", polarity: "positive", weight: 1.5 },
  { term: "elle a raison", polarity: "positive", weight: 1.5 },
  { term: "felicitations", polarity: "positive", weight: 2 },
  { term: "digne", polarity: "positive", weight: 1 },
  { term: "sincere", polarity: "positive", weight: 1.5 },
  { term: "proche des gens", polarity: "positive", weight: 1.5 },
  { term: "travailleur", polarity: "positive", weight: 1 },
  { term: "travailleuse", polarity: "positive", weight: 1 },
  { term: "efficace", polarity: "positive", weight: 1.5 },
  { term: "protege", polarity: "positive", weight: 1 },
  { term: "defend", polarity: "positive", weight: 1 },
  { term: "vive", polarity: "positive", weight: 1.5 },

  // ── Negative ────────────────────────────────────────────────────────────
  { term: "non merci", polarity: "negative", weight: 1.5 },
  { term: "danger", polarity: "negative", weight: 2 },
  { term: "dangereux", polarity: "negative", weight: 2 },
  { term: "dangereuse", polarity: "negative", weight: 2 },
  { term: "menace", polarity: "negative", weight: 2 },
  { term: "extremiste", polarity: "negative", weight: 1.5 },
  { term: "fasciste", polarity: "negative", weight: 2.5 },
  { term: "facho", polarity: "negative", weight: 2.5 },
  { term: "raciste", polarity: "negative", weight: 2.5 },
  { term: "xenophobe", polarity: "negative", weight: 2.5 },
  { term: "antisemite", polarity: "negative", weight: 2.5 },
  { term: "islamophobe", polarity: "negative", weight: 2.5 },
  { term: "complotiste", polarity: "negative", weight: 2 },
  { term: "honte", polarity: "negative", weight: 2 },
  { term: "scandale", polarity: "negative", weight: 2 },
  { term: "scandaleux", polarity: "negative", weight: 2 },
  { term: "mensonge", polarity: "negative", weight: 2 },
  { term: "mensonges", polarity: "negative", weight: 2 },
  { term: "menteur", polarity: "negative", weight: 2.5 },
  { term: "menteuse", polarity: "negative", weight: 2.5 },
  { term: "hypocrite", polarity: "negative", weight: 2 },
  { term: "hypocrisie", polarity: "negative", weight: 2 },
  { term: "traitre", polarity: "negative", weight: 2 },
  { term: "trahison", polarity: "negative", weight: 2 },
  { term: "incompetent", polarity: "negative", weight: 2.5 },
  { term: "incompetente", polarity: "negative", weight: 2.5 },
  { term: "incapable", polarity: "negative", weight: 2 },
  { term: "nul", polarity: "negative", weight: 1.5 },
  { term: "nulle", polarity: "negative", weight: 1.5 },
  { term: "catastrophique", polarity: "negative", weight: 2 },
  { term: "echec", polarity: "negative", weight: 2 },
  { term: "faillite", polarity: "negative", weight: 2 },
  { term: "corrompu", polarity: "negative", weight: 2.5 },
  { term: "corruption", polarity: "negative", weight: 2 },
  { term: "condamne", polarity: "negative", weight: 1.5 },
  { term: "condamnation", polarity: "negative", weight: 1.5 },
  { term: "inelegible", polarity: "negative", weight: 1.5 },
  { term: "deteste", polarity: "negative", weight: 2 },
  { term: "detestable", polarity: "negative", weight: 2 },
  { term: "rejet", polarity: "negative", weight: 1.5 },
  { term: "rejeter", polarity: "negative", weight: 1.5 },
  { term: "degagisme", polarity: "negative", weight: 1.5 },
  { term: "degage", polarity: "negative", weight: 2 },
  { term: "dehors", polarity: "negative", weight: 1 },
  { term: "boycott", polarity: "negative", weight: 1.5 },
  { term: "revolte", polarity: "negative", weight: 1 },
  { term: "indigne", polarity: "negative", weight: 2 },
  { term: "mepris", polarity: "negative", weight: 2 },
  { term: "meprisant", polarity: "negative", weight: 2 },
  { term: "insulte", polarity: "negative", weight: 1.5 },
  { term: "insultes", polarity: "negative", weight: 1.5 },
  { term: "provocation", polarity: "negative", weight: 1.5 },
  { term: "arnaque", polarity: "negative", weight: 2 },
  { term: "escroc", polarity: "negative", weight: 2.5 },
  { term: "voleur", polarity: "negative", weight: 2.5 },
  { term: "detournement", polarity: "negative", weight: 2 },
  { term: "fraude", polarity: "negative", weight: 2 },
  { term: "privilege", polarity: "negative", weight: 1 },
  { term: "privileges", polarity: "negative", weight: 1 },
  { term: "austerite", polarity: "negative", weight: 1.5 },
  { term: "casse sociale", polarity: "negative", weight: 2 },
  { term: "regression", polarity: "negative", weight: 1.5 },
  { term: "inquietant", polarity: "negative", weight: 1.5 },
  { term: "inquietude", polarity: "negative", weight: 1 },
  { term: "promesse non tenue", polarity: "negative", weight: 2 },
  { term: "langue de bois", polarity: "negative", weight: 1.5 },
  { term: "politicard", polarity: "negative", weight: 1.5 },
  { term: "ambition personnelle", polarity: "negative", weight: 1.5 },
  { term: "ultraliberal", polarity: "negative", weight: 1.5 },
  { term: "la honte", polarity: "negative", weight: 2 },
  { term: "beurk", polarity: "negative", weight: 1.5 },
  { term: "nausee", polarity: "negative", weight: 1.5 },
  // ── Added after reading real captions: specific political phrasing ─────
  { term: "soutient", polarity: "positive", weight: 2 },
  { term: "soutenez", polarity: "positive", weight: 2 },
  { term: "soutenons", polarity: "positive", weight: 2 },
  { term: "appelle a voter", polarity: "positive", weight: 2 },
  { term: "appel a voter", polarity: "positive", weight: 2 },
  { term: "votez", polarity: "positive", weight: 2 },
  { term: "je vote", polarity: "positive", weight: 1.5 },
  { term: "se range derriere", polarity: "positive", weight: 2 },
  { term: "rallie", polarity: "positive", weight: 1.5 },
  { term: "rejoint", polarity: "positive", weight: 1 },
  { term: "a ses cotes", polarity: "positive", weight: 1.5 },
  { term: "salue", polarity: "positive", weight: 1.5 },
  { term: "felicite", polarity: "positive", weight: 2 },
  { term: "rend hommage", polarity: "positive", weight: 1.5 },
  { term: "notre candidate", polarity: "positive", weight: 2 },
  { term: "notre candidat", polarity: "positive", weight: 2 },
  { term: "notre presidente", polarity: "positive", weight: 2 },
  { term: "notre president", polarity: "positive", weight: 1.5 },
  { term: "la seule a", polarity: "positive", weight: 1.5 },
  { term: "le seul a", polarity: "positive", weight: 1.5 },
  { term: "confiance", polarity: "positive", weight: 1 },
  { term: "a la hauteur", polarity: "positive", weight: 1.5 },
  { term: "bilan positif", polarity: "positive", weight: 2 },
  { term: "attaque", polarity: "negative", weight: 1 },
  { term: "s attaque a", polarity: "negative", weight: 1.5 },
  { term: "accuse", polarity: "negative", weight: 1.5 },
  { term: "accusations", polarity: "negative", weight: 1.5 },
  { term: "denonce", polarity: "negative", weight: 1.5 },
  { term: "se moque", polarity: "negative", weight: 1.5 },
  { term: "moquerie", polarity: "negative", weight: 1.5 },
  { term: "raille", polarity: "negative", weight: 1.5 },
  { term: "humilie", polarity: "negative", weight: 1.5 },
  { term: "a menti", polarity: "negative", weight: 2.5 },
  { term: "ment", polarity: "negative", weight: 1.5 },
  { term: "mensonger", polarity: "negative", weight: 2 },
  { term: "rien fait", polarity: "negative", weight: 2 },
  { term: "inutile", polarity: "negative", weight: 1.5 },
  { term: "catastrophe", polarity: "negative", weight: 2 },
  { term: "naufrage", polarity: "negative", weight: 2 },
  { term: "desastre", polarity: "negative", weight: 2 },
  { term: "clown", polarity: "negative", weight: 2 },
  { term: "guignol", polarity: "negative", weight: 2 },
  { term: "bouffon", polarity: "negative", weight: 2 },
  { term: "ridicule", polarity: "negative", weight: 1.5 },
  { term: "risible", polarity: "negative", weight: 1.5 },
  { term: "lache", polarity: "negative", weight: 1.5 },
  { term: "esquive", polarity: "negative", weight: 1.5 },
  { term: "fuit", polarity: "negative", weight: 1.5 },
  { term: "renonce", polarity: "negative", weight: 1 },
  { term: "sert a rien", polarity: "negative", weight: 1.5 },
];

const NEGATIONS = ["ne", "n", "pas", "plus", "jamais", "aucun", "aucune", "sans", "ni", "refuse", "refusent", "refusa", "refuser"];
const INTENSIFIERS = ["tres", "vraiment", "totalement", "completement", "tellement", "trop"];

interface CompiledMarker {
  normalized: string;
  polarity: StancePolarity;
  weight: number;
  regex: RegExp;
}

const COMPILED: CompiledMarker[] = LEXICON.map((entry) => ({
  normalized: normalizeText(entry.term),
  polarity: entry.polarity,
  weight: entry.weight,
  // Accent-, case- and hyphen-tolerant: "fierte" also matches "fierté",
  // "extreme droite" matches "extrême-droite".
  regex: aliasPatternGlobal(entry.term),
}));

export interface TextBundle {
  text: string;
  /** Character range (start inclusive, end exclusive) for each field. */
  ranges: Array<{ field: "caption" | "on_screen_text" | "transcript"; start: number; end: number }>;
}

export function buildTextBundle(video: VideoRow, fields: Array<"caption" | "on_screen_text" | "transcript">): TextBundle {
  let text = "";
  const ranges: TextBundle["ranges"] = [];
  for (const field of fields) {
    const value =
      field === "caption" ? video.caption ?? "" : field === "on_screen_text" ? (video.on_screen_text ?? []).join("\n") : video.transcript ?? "";
    if (!value) continue;
    if (text.length) text += "\n";
    const start = text.length;
    text += value;
    ranges.push({ field, start, end: text.length });
  }
  return { text, ranges };
}

function fieldAt(bundle: TextBundle, offset: number) {
  return bundle.ranges.find((range) => offset >= range.start && offset < range.end)?.field ?? "caption";
}

function isNegated(text: string, start: number): boolean {
  const before = normalizeText(text.slice(Math.max(0, start - 40), start)).split(" ");
  return before.slice(-3).some((token) => NEGATIONS.includes(token));
}

function intensityAt(text: string, start: number): number {
  const before = normalizeText(text.slice(Math.max(0, start - 30), start)).split(" ");
  return before.slice(-2).some((token) => INTENSIFIERS.includes(token)) ? 1.5 : 1;
}

/** Every lexicon hit in the text, with the field it came from. */
export function findMarkers(bundle: TextBundle): StanceMarker[] {
  const markers: StanceMarker[] = [];
  const claimed = new Set<string>();

  for (const entry of COMPILED) {
    for (const match of bundle.text.matchAll(entry.regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const key = `${start}:${end}`;
      if (claimed.has(key)) continue;
      claimed.add(key);

      const negated = isNegated(bundle.text, start);
      markers.push({
        term: entry.normalized,
        polarity: entry.polarity,
        weight: Number((entry.weight * intensityAt(bundle.text, start)).toFixed(2)),
        field: fieldAt(bundle, start),
        start,
        end,
        negated,
        text: match[0],
      });
    }
  }

  return markers.sort((a, b) => a.start - b.start);
}

function polarityOf(marker: StanceMarker): number {
  const base = marker.polarity === "positive" ? 1 : -1;
  return base * (marker.negated ? -1 : 1) * marker.weight;
}

function confidenceFor(markers: StanceMarker[]): StanceScore["confidence"] {
  const strong = markers.filter((marker) => marker.weight >= 2).length;
  if (strong >= 1 && markers.length >= 2) return "high";
  if (markers.length >= 1) return "medium";
  return "low";
}

/** Scores one candidate inside one text bundle, using mention proximity. */

const HASHTAG_INTENT = ["avec", "2027", "votez", "soutien", "pour"];

/**
 * Typed support signals: #avecmarine, #jlm2027, #votezlepen.
 * A hashtag only counts when it contains a distinctive token of the candidate
 * name (or their initials) AND an intent word, which keeps #marinebiology out.
 */
function hashtagMarkers(bundle: TextBundle, candidate: CandidateDef): StanceMarker[] {
  const tokens = new Set(
    [...candidate.aliases, ...candidate.weakAliases]
      .flatMap((alias) => normalizeText(alias).split(" "))
      .filter((token) => token.length >= 4),
  );
  const acronym = normalizeText(candidate.name)
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("");
  if (acronym.length >= 2) tokens.add(acronym);

  const out: StanceMarker[] = [];
  for (const match of bundle.text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = normalizeText(match[1]);
    const hasName = [...tokens].some((token) => tag.includes(token));
    const hasIntent = HASHTAG_INTENT.some((word) => tag.includes(word));
    if (!hasName || !hasIntent) continue;
    const start = match.index ?? 0;
    out.push({
      term: `#${tag}`,
      polarity: "positive",
      weight: 1.5,
      field: fieldAt(bundle, start),
      start,
      end: start + match[0].length,
      negated: false,
      text: match[0],
    });
  }
  return out;
}


/** Ordered sentences, used for sentence-anchored attribution. */
function splitSentences(text: string): Array<{ start: number; end: number }> {
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…\n]/g)) {
    const end = (match.index ?? 0) + 1;
    if (end > start) chunks.push({ start, end });
    start = end;
  }
  if (start < text.length) chunks.push({ start, end: text.length });
  return chunks.length ? chunks : [{ start: 0, end: text.length }];
}

/** Verbs where the candidate can be the speaker, not the target. */
/** Creators often tell you the post is ironic; believe them. */
const IRONY_CUES = /\b(ironie|ironique|second degr[eé]|sarcasme|sarcastique|je blague|humour noir)\b/iu;

const AGENT_VERBS = new Set(["denonce", "accuse", "attaque", "s attaque a", "critique", "se moque", "raille"]);

export function scoreCandidateInBundle(
  bundle: TextBundle,
  candidate: CandidateDef,
  otherCandidates: CandidateDef[] = [],
  /** Pronouns are a transcript phenomenon; captions name their subject. */
  allowCoreference = false,
): StanceScore {
  const markers = findMarkers(bundle);

  const candidates = [candidate, ...otherCandidates.filter((other) => other.id !== candidate.id)];
  const mentions = candidates.flatMap((entry) =>
    scanCandidate(bundle.text, entry).flatMap((hit) =>
      hit.occurrences.map((occurrence) => ({ candidateId: entry.id, start: occurrence.start, end: occurrence.end })),
    ),
  );

  const scored: StanceMarker[] = [];
  const chunks = splitSentences(bundle.text);
  const chunkOf = (offset: number) => chunks.findIndex((chunk) => offset >= chunk.start && offset < chunk.end);
  const mentionsByChunk = new Map<number, Set<string>>();
  for (const mention of mentions) {
    const index = chunkOf(mention.start);
    if (index < 0) continue;
    const set = mentionsByChunk.get(index) ?? new Set<string>();
    set.add(mention.candidateId);
    mentionsByChunk.set(index, set);
  }

  for (const marker of markers) {
    const index = chunkOf(marker.start);
    if (index < 0) continue;
    const chunk = chunks[index];

    // "X dénonce Y" is X acting, not an attack on X.
    if (AGENT_VERBS.has(marker.term)) {
      const candidateBefore = mentions.some(
        (mention) =>
          mention.candidateId === candidate.id && mention.end <= marker.start && mention.start >= chunk.start,
      );
      if (candidateBefore) continue;
    }

    const namedHere = mentionsByChunk.get(index)?.has(candidate.id) ?? false;
    if (namedHere) {
      scored.push(marker);
      continue;
    }

    // Transcripts use pronouns: if the candidate was the only one named in the
    // two preceding sentences, attribute the marker to them. This is the
    // cheapest deterministic coreference and it is only used when unambiguous.
    if (allowCoreference && index >= 1) {
      const lookback = new Set<string>();
      for (const offset of [1, 2]) {
        const set = mentionsByChunk.get(index - offset);
        if (set) for (const id of set) lookback.add(id);
      }
      if (lookback.size === 1 && lookback.has(candidate.id)) {
        scored.push(marker);
      }
    }
  }

  // Hashtag support is typed by the creator, so it needs no proximity window.
  const withHashtags = [...scored, ...hashtagMarkers(bundle, candidate)];

  // A single weak marker is noise ("protège la diversité", "on intègre le
  // principe"). Demand one strong marker or two markers, and treat explicit
  // self-declared irony as no signal.
  const strongMarkers = withHashtags.filter((marker) => marker.weight >= 1.5).length;
  const enoughEvidence = withHashtags.length >= 2 || strongMarkers >= 1;
  const ironic = IRONY_CUES.test(bundle.text);

  const positive = withHashtags.filter((marker) => polarityOf(marker) > 0).reduce((sum, marker) => sum + polarityOf(marker), 0);
  const negative = withHashtags
    .filter((marker) => polarityOf(marker) < 0)
    .reduce((sum, marker) => sum + Math.abs(polarityOf(marker)), 0);

  const total = positive + negative;
  const score = total === 0 ? 0 : Number(((positive - negative) / (total + 1)).toFixed(3));

  const fields = new Set(withHashtags.map((marker) => marker.field));
  const basis: StanceScore["basis"] =
    withHashtags.length === 0 || !enoughEvidence || ironic
      ? "none"
      : fields.has("caption") && fields.has("on_screen_text")
        ? "caption+on_screen_text"
        : fields.has("caption")
          ? "caption"
          : fields.has("on_screen_text")
            ? "on_screen_text"
            : "transcript_fallback";

  // An unclear row must not carry a direction: the score is what the UI shows.
  const unclear = withHashtags.length === 0 || !enoughEvidence || ironic;
  const displayScore = unclear ? 0 : score;

  const quoteMarkers = withHashtags.slice(0, 2);
  const quote = quoteMarkers
    .map((marker) => bundle.text.slice(Math.max(0, marker.start - 40), Math.min(bundle.text.length, marker.end + 40)).trim())
    .join(" … ");
  const quoteField = quoteMarkers[0]?.field ?? null;

  return {
    score: displayScore,
    quote,
    quoteField,
    positive: Number(positive.toFixed(2)),
    negative: Number(negative.toFixed(2)),
    markers: withHashtags,
    basis,
    confidence: confidenceFor(withHashtags),
    unclear,
  };
}

/** Video-level convenience: score the primary fields, fall back to transcript. */
export function scoreVideoForCandidate(
  video: VideoRow,
  candidate: CandidateDef,
  allCandidates: CandidateDef[],
): StanceScore & { ownMentions: number } {
  const primary = buildTextBundle(video, ["caption", "on_screen_text"]);
  const ownMentions = scanCandidate(primary.text, candidate).reduce((sum, hit) => sum + hit.occurrences.length, 0);

  if (primary.text.trim()) {
    const score = scoreCandidateInBundle(primary, candidate, allCandidates, false);
    if (!score.unclear) return { ...score, ownMentions };
  }

  if (video.transcript) {
    const fallback = scoreCandidateInBundle(buildTextBundle(video, ["transcript"]), candidate, allCandidates, true);
    if (!fallback.unclear) return { ...fallback, basis: "transcript_fallback", ownMentions };
    return { ...fallback, ownMentions };
  }

  return {
    score: 0,
    quote: "",
    quoteField: null,
    positive: 0,
    negative: 0,
    markers: [],
    basis: "none",
    confidence: "low",
    unclear: true,
    ownMentions,
  };
}

export type StanceLabel =
  | "favorable"
  | "leaning_favorable"
  | "mixed"
  | "leaning_critical"
  | "critical"
  | "no_signal"
  | "single_video"
  | "insufficient";

export interface CreatorCandidateStance {
  creator_handle: string;
  creator_display_name: string | null;
  creator_followers: number | null;
  candidate_id: string;
  videos: number;
  favorable: number;
  critical: number;
  neutral: number;
  unclear: number;
  stance_index: number;
  view_weighted_index: number;
  avg_score: number;
  label: StanceLabel;
  total_views: number;
  evidence: Array<{ video_id: string; score: number; basis: string; markers: string[]; quote: string }>;
  computed_at: string;
}

export interface AggregateOptions {
  /** Below this many videos the label is "insufficient", not a stance. */
  minVideos?: number;
  /** |score| below this is neutral rather than leaning. */
  neutralBand?: number;
  maxEvidence?: number;
}

interface VideoStanceRow {
  video_id: string;
  candidate_id: string;
  score: number;
  positive: number;
  negative: number;
  unclear: boolean;
  label: "favorable" | "critical" | "neutral" | "unclear";
  basis: string;
  markers: string[];
  quote: string;
}

/** Injected by the ETL when Vertex AI re-scored a video. */
export interface StanceOverride {
  score: number;
  basis: string;
  markers: string[];
  quote: string;
}

export interface AggregateOptions {
  /** Below this many videos the label is "insufficient", not a stance. */
  minVideos?: number;
  /** |score| below this is neutral rather than leaning. */
  neutralBand?: number;
  maxEvidence?: number;
  /** Keyed by `${video_id}|${candidate_id}`. */
  overrides?: Map<string, StanceOverride>;
  /** Called periodically so a long deterministic pass can show progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Groups per-video scores into creator × candidate rows.
 *
 * Label thresholds are deliberately conservative: one video never produces a
 * stance, and the UI should show counts before it shows an index.
 */
export function aggregateCreatorStance(
  videos: VideoRow[],
  mentions: Array<{ video_id: string; candidate_id: string; strength: string }>,
  candidates: CandidateDef[],
  options: AggregateOptions = {},
): { rows: CreatorCandidateStance[]; perVideo: VideoStanceRow[] } {
  const { minVideos = 2, neutralBand = 0.15, maxEvidence = 3, overrides } = options;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const videosById = new Map(videos.map((video) => [video.id, video]));

  // One row per (video, candidate), using only mentions that are real.
  const pairs = new Set(
    mentions
      .filter((mention) => byId.has(mention.candidate_id) && videosById.has(mention.video_id))
      .map((mention) => `${mention.video_id}|${mention.candidate_id}`),
  );

  const perVideo: VideoStanceRow[] = [];
  const groups = new Map<string, CreatorCandidateStance>();
  let processed = 0;

  for (const pair of pairs) {
    const [videoId, candidateId] = pair.split("|");
    const video = videosById.get(videoId)!;
    const candidate = byId.get(candidateId)!;
    const stance = scoreVideoForCandidate(video, candidate, candidates);
    const override = overrides?.get(pair);

    const quote = override?.quote || stance.quote || (video.caption ?? "").slice(0, 160);

    const finalScore = override ? override.score : stance.score;
    const finalBasis = override ? override.basis : stance.basis;
    const finalMarkers = override ? override.markers : stance.markers.map((marker) => marker.term);
    const unclear = override ? false : stance.unclear;

    perVideo.push({
      video_id: video.id,
      candidate_id: candidateId,
      score: finalScore,
      positive: stance.positive,
      negative: stance.negative,
      unclear,
      label: unclear
        ? "unclear"
        : finalScore >= neutralBand
          ? "favorable"
          : finalScore <= -neutralBand
            ? "critical"
            : "neutral",
      basis: finalBasis,
      markers: finalMarkers,
      quote,
    });

    const key = `${video.creator_handle}|${candidateId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        creator_handle: video.creator_handle ?? "unknown",
        creator_display_name: video.creator_display_name ?? null,
        creator_followers: video.creator_followers ?? null,
        candidate_id: candidateId,
        videos: 0,
        favorable: 0,
        critical: 0,
        neutral: 0,
        unclear: 0,
        stance_index: 0,
        view_weighted_index: 0,
        avg_score: 0,
        label: "insufficient",
        total_views: 0,
        evidence: [],
        computed_at: new Date().toISOString(),
      };
      groups.set(key, group);
    }

    group.videos += 1;
    group.total_views += video.views ?? 0;

    if (unclear) group.unclear += 1;
    else if (finalScore >= neutralBand) group.favorable += 1;
    else if (finalScore <= -neutralBand) group.critical += 1;
    else group.neutral += 1;

    if (group.evidence.length < maxEvidence && !unclear) {
      group.evidence.push({
        video_id: video.id,
        score: finalScore,
        basis: finalBasis,
        markers: finalMarkers,
        quote,
      });
    }
    (group as any)._scoreSum = ((group as any)._scoreSum ?? 0) + finalScore;
    (group as any)._weightedSum = ((group as any)._weightedSum ?? 0) + finalScore * (video.views ?? 0);

    processed += 1;
    if (options.onProgress && (processed % 50 === 0 || processed === pairs.size)) {
      options.onProgress(processed, pairs.size);
    }
  }

  const rows = [...groups.values()].map((group) => {
    const scoreSum = (group as any)._scoreSum as number;
    const weightedSum = (group as any)._weightedSum as number;
    delete (group as any)._scoreSum;
    delete (group as any)._weightedSum;

    group.stance_index = Number(((group.favorable - group.critical) / Math.max(group.videos, 1)).toFixed(3));
    group.view_weighted_index = Number((weightedSum / Math.max(group.total_views, 1)).toFixed(3));
    group.avg_score = Number((scoreSum / Math.max(group.videos, 1)).toFixed(3));

    const decisive = group.favorable + group.critical;
    if (group.videos < minVideos || decisive === 0) {
      group.label = group.videos === 1 ? "single_video" : group.videos < minVideos ? "insufficient" : "no_signal";
    } else if (group.stance_index >= 0.6) group.label = "favorable";
    else if (group.stance_index >= 0.2) group.label = "leaning_favorable";
    else if (group.stance_index <= -0.6) group.label = "critical";
    else if (group.stance_index <= -0.2) group.label = "leaning_critical";
    else group.label = "mixed";

    return group;
  });

  rows.sort((a, b) => Math.abs(b.stance_index) - Math.abs(a.stance_index));
  return { rows, perVideo };
}

/** Copy-safe summary for the UI: counts first, stance second. */
export function describeStance(row: CreatorCandidateStance): string {
  if (row.label === "single_video") {
    return `One video mentioning this candidate — the video-level stance is shown, the handle is not characterised.`;
  }
  if (row.label === "insufficient") {
    return `${row.videos} video(s) mentioning this candidate — not enough to characterise the handle.`;
  }
  if (row.label === "no_signal") {
    return `${row.videos} video(s), none expressing a clear stance.`;
  }
  return `${row.favorable} favourable, ${row.critical} critical, ${row.neutral} neutral out of ${row.videos} videos mentioning this candidate.`;
}
