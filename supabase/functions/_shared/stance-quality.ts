import type { CandidateDef, VideoRow } from "./types.ts";
import { normalizeText, scanCandidate } from "./normalize.ts";
import { CANDIDATES } from "./candidates.ts";

/**
 * Quality helpers for stance extraction.
 *
 * These exist because the first Gemini pass produced "unclear" for three
 * different situations that need different handling:
 *   1. the candidate is not actually discussed (OCR listicle, credit roll,
 *      a different person with the same surname) — no model can label this;
 *   2. the candidate is named in a list or a news quote — that is `neutral`,
 *      not `unclear`;
 *   3. the model produced a stance but its quote did not match the source
 *      verbatim — recoverable by fuzzy sentence matching.
 */

/**
 * Candidates whose surname alone is not safe: a namesake politician, a common
 * first name, a foreign homograph. Only these require first-name corroboration,
 * because applying it to every candidate would discard most surname-only
 * mentions (French political speech says "Mélenchon", rarely "Jean-Luc").
 */
const NAMESAKE_GUARD = new Set([
  "cazeneuve", // Pierre Cazeneuve, Ensemble
  "lepen",     // Jean-Marie / Marion Maréchal
  "philippe",  // common first name
  "bertrand",  // common first name
  "mathieu",   // common first name
  "lalanne",   // singer, large unrelated corpus
  "ruffin",    // English surname
  "markovic",  // Balkan surname
  "becht",     // German-language homograph
  "labib",     // common Arabic given name
]);

export type RelevanceKind = "direct" | "listicle" | "credit_ocr" | "namesake_risk" | "absent";

export interface Relevance {
  mentioned: boolean;
  kind: RelevanceKind;
  /** How many distinct candidates appear in the text. */
  candidatesInText: number;
  /** The sentence that carries the mention, for inspection. */
  context: string | null;
}

/** Candidate-listing markers typical of carousels and news tickers. */
const LIST_MARKERS = /\b(liste des|la liste|les candidats|candidats d[eé]j[aà]|qui sont les|d[eé]clar[eé]s?)\b/iu;

function sentenceAround(text: string, start: number, end: number): string {
  const before = Math.max(text.lastIndexOf(".", start), text.lastIndexOf("\n", start), text.lastIndexOf("!", start), text.lastIndexOf("?", start));
  const stops = [".", "\n", "!", "?"].map((char) => text.indexOf(char, end)).filter((index) => index >= 0);
  const from = before < 0 ? Math.max(0, start - 120) : before + 1;
  const to = stops.length ? Math.min(...stops) + 1 : Math.min(text.length, end + 120);
  return text.slice(from, to).trim();
}

/**
 * Is the candidate actually discussed, and in what form?
 *
 * `absent` and `credit_ocr` should never produce a stance: the honest output is
 * "not about this candidate", not "unclear stance".
 */
export function assessRelevance(video: VideoRow, candidate: CandidateDef): Relevance {
  const text = [video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""]
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return { mentioned: false, kind: "absent", candidatesInText: 0, context: null };

  const hits = scanCandidate(text, candidate);
  if (hits.length === 0) {
    return { mentioned: false, kind: "absent", candidatesInText: 0, context: null };
  }

  const candidatesInText = CANDIDATES.filter((entry) => scanCandidate(text, entry).length > 0).length;
  const occurrence = hits.flatMap((hit) => hit.occurrences).sort((a, b) => a.start - b.start)[0];
  const context = sentenceAround(text, occurrence.start, occurrence.end);

  // A surname-only match needs first-name corroboration. "PIERRE Cazeneuve" in
  // an Assemblée debate is a different politician, and a bare "Le Pen" may be
  // Jean-Marie or Marion. Without the first name in the same sentence the match
  // is not safe enough to carry a stance.
  const weakOnly = hits.every((hit) => hit.strength === "weak");
  if (weakOnly && NAMESAKE_GUARD.has(candidate.id)) {
    const firstNameTokens = normalizeText(candidate.name).split(" ").slice(0, -1).filter((token) => token.length >= 3);
    const normalizedContext = normalizeText(context);
    const corroborated = firstNameTokens.some((token) => normalizedContext.includes(token));
    if (!corroborated) {
      return { mentioned: true, kind: "namesake_risk", candidatesInText, context };
    }
  }

  // A dense run of names with no verb is a list, not a statement.
  const nameDensity = candidatesInText / Math.max(1, normalizeText(text).split(" ").length / 120);
  const looksLikeList = candidatesInText >= 5 || LIST_MARKERS.test(text) || nameDensity > 2.5;
  if (looksLikeList) {
    return { mentioned: true, kind: "listicle", candidatesInText, context };
  }

  // Credit rolls put names in upper case separated by commas. This is reported
  // for triage but NOT used to suppress a stance: French captions also shout in
  // caps, and the heuristic was flagging genuine coverage as irrelevant.
  const upper = (context.match(/\b[A-ZÀ-Ý]{3,}\b/g) ?? []).length;
  const words = context.split(/\s+/).length;
  if (words >= 6 && upper / words > 0.45) {
    return { mentioned: true, kind: "credit_ocr", candidatesInText, context };
  }

  return { mentioned: true, kind: "direct", candidatesInText, context };
}

export type EvidenceMode = "exact" | "fuzzy" | "none";

export interface EvidenceMatch {
  verified: boolean;
  mode: EvidenceMode;
  source: "caption" | "on_screen_text" | "transcript" | null;
  /** The source sentence used as evidence (always a real substring). */
  sentence: string | null;
  similarity: number;
}

const tokens = (value: string) =>
  new Set(normalizeText(value).split(" ").filter((token) => token.length > 2));

function containment(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

/**
 * Strict quote check first, then a sentence-level fuzzy fallback.
 *
 * The fuzzy path exists because OCR and spoke-word transcripts rarely match a
 * model's quote character-for-character. It never invents text: the returned
 * sentence is a real substring of the source, and the mode is recorded so the UI
 * can label it "close match" instead of "verbatim".
 */
export function matchEvidence(
  quote: string | null | undefined,
  video: VideoRow,
  options: { minSimilarity?: number } = {},
): EvidenceMatch {
  const { minSimilarity = 0.7 } = options;
  const fields: Array<["caption" | "on_screen_text" | "transcript", string]> = [
    ["caption", video.caption ?? ""],
    ["on_screen_text", (video.on_screen_text ?? []).join("\n")],
    ["transcript", video.transcript ?? ""],
  ];
  const needle = (quote ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  if (!needle) return { verified: false, mode: "none", source: null, sentence: null, similarity: 0 };

  // 1. Verbatim.
  for (const [source, text] of fields) {
    if (text && text.toLowerCase().includes(needle)) {
      return { verified: true, mode: "exact", source, sentence: quote!.trim(), similarity: 1 };
    }
  }

  // 2. Fuzzy: best sentence overlap.
  let best: EvidenceMatch = { verified: false, mode: "none", source: null, sentence: null, similarity: 0 };
  for (const [source, text] of fields) {
    if (!text) continue;
    const sentences = text.split(/(?<=[.!?…])\s+|\n+/).filter((sentence) => sentence.trim().length > 8);
    for (const sentence of sentences) {
      const similarity = containment(needle, sentence);
      if (similarity > best.similarity) {
        best = { verified: similarity >= minSimilarity, mode: similarity >= minSimilarity ? "fuzzy" : "none", source: similarity >= minSimilarity ? source : null, sentence: sentence.trim(), similarity };
      }
    }
  }
  if (best.verified) return best;

  return { verified: false, mode: "none", source: null, sentence: best.sentence, similarity: Number(best.similarity.toFixed(3)) };
}

/**
 * Few-shot exemplars for the French political register. Deliberately includes
 * the cases the zero-shot model got wrong: a satirical jab, a campaign placard,
 * a news quote, and a candidate list.
 */
export const FEW_SHOT_EXAMPLES: Array<{ input: string; output: string }> = [
  {
    input: "CAPTION: Ils n'auront plus de professeurs ni de crayons, mais ils auront le drapeau avec Attal.\nON-SCREEN: LE DRAPEAU",
    output: `{"candidate_id":"X","stance":"critical","score":-0.5,"rationale":"Sarcastic jab at the candidate while schools lack resources.","evidence_quote":"ils auront le drapeau avec Attal","evidence_source":"caption"}`,
  },
  {
    input: "CAPTION: SELMA LABIB 2027 — Carburant, logement, alimentation : le NPA propose de bloquer les prix.\nON-SCREEN: SELMA LABIB 2027",
    output: `{"candidate_id":"X","stance":"favorable","score":0.7,"rationale":"Campaign placard presenting the candidate programme without criticism.","evidence_quote":"SELMA LABIB 2027","evidence_source":"on_screen_text"}`,
  },
  {
    input: "CAPTION: ALERTE INFO • Législatives : \"La seule manière\" de bloquer le RN est \"une union de la gauche\" (R. Glucksmann, France Inter).",
    output: `{"candidate_id":"X","stance":"neutral","score":0,"rationale":"A news quote: the candidate is cited, the creator takes no side.","evidence_quote":"La seule manière de bloquer le RN est une union de la gauche","evidence_source":"caption"}`,
  },
  {
    input: "CAPTION: La liste des 30 candidats déjà déclarés pour 2027 — 4/16 Bernard Cazeneuve (La Convention), 6/16 Karim Bouamrane (Parti socialiste)...",
    output: `{"candidate_id":"X","stance":"neutral","score":0,"rationale":"The candidate appears as one row in a list of declared candidates.","evidence_quote":"La liste des 30 candidats déjà déclarés","evidence_source":"caption"}`,
  },
  {
    input: "CAPTION: L'extrême droite qui donne des leçons de légalité alors que leur présidente est sous bracelet électronique... sacré spectacle de l'extrême droite.",
    output: `{"candidate_id":"X","stance":"critical","score":-0.8,"rationale":"Direct attack on the party and its leader through the electronic bracelet conviction.","evidence_quote":"sacré spectacle de l'extrême droite","evidence_source":"caption"}`,
  },
  {
    input: "CAPTION: Pourquoi tout le monde veut se présenter ???\nTRANSCRIPT: La prochaine fois que je déménage, c'est à l'Élysée... la politique n'est pas au niveau face à l'enjeu climatique.",
    output: `{"candidate_id":"X","stance":"neutral","score":0,"rationale":"General commentary on the number of candidates; no evaluation of this one.","evidence_quote":"Pourquoi tout le monde veut se présenter","evidence_source":"caption"}`,
  },
];

export const FEW_SHOT_INSTRUCTION = [
  "Reference examples (French political TikTok register):",
  ...FEW_SHOT_EXAMPLES.map((example, index) => `Example ${index + 1}:\n${example.input}\n=> ${example.output}`),
  "",
  "Apply the same reading. A satirical jab is critical. Campaign material for the candidate is favourable. A news quote or a list row is neutral. Pure irony or an OCR listicle is unclear.",
].join("\n");
