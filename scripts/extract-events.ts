/**
 * Event extraction over the local Oriane snapshot.
 *
 *   npm run events
 *
 * Reads data/oriane/*.json (no API calls) and writes:
 *   data/analyses/events.json   events, topics, scandals, timelines
 *   data/analyses/events.csv    one row per event × date (timeline, long format)
 *
 * An event is only emitted when at least `minVideos` videos match its anchors,
 * and it always carries the videos that prove it. Titles are curated; the dates,
 * counts, timelines and quotes are computed from the corpus.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { normalizeText, scanCandidate } from "../supabase/functions/_shared/normalize.ts";
import type { VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, num, parseArgs, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));
const MIN_VIDEOS = num(args["min-videos"], 2);
const OUT = String(args.out ?? "data/analyses/events.json");

// ── Load ──────────────────────────────────────────────────────────────────
const files = readdirSync("data/oriane").filter(
  (file) => file.endsWith(".json") && !file.startsWith("_") && file !== "top10-all.json",
);
const videosById = new Map<string, VideoRow>();
for (const file of files) {
  const payload = JSON.parse(readFileSync(`data/oriane/${file}`, "utf8"));
  for (const video of payload.videos as VideoRow[]) {
    if (video.is_french) videosById.set(video.id, video);
  }
}
const videos = [...videosById.values()].filter((video) => video.posted_at);
const corpus = new Map(videos.map((video) => [video.id, normalizeText(text(video))]));

function text(video: VideoRow): string {
  return [video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""].filter(Boolean).join(" \n ");
}

const DATE = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).valueOf() - new Date(`${a}T00:00:00Z`).valueOf()) / 86_400_000);

function matches(video: VideoRow, anchors: string[]): string[] {
  const normalized = corpus.get(video.id)!;
  const found: string[] = [];
  for (const anchor of anchors) {
    const term = normalizeText(anchor).trim();
    if (!term) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(normalized)) {
      found.push(anchor);
    }
  }
  return found;
}

// ── Dates mentioned in the text (the event may predate our coverage) ──────
const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

function rawDatesMentioned(video: VideoRow): string[] {
  const raw = text(video);
  const year = new Date(video.posted_at!).getUTCFullYear();
  const found = new Map<string, string>();
  // Only dates written with a year. Assigning the post's year to a bare
  // "4 juillet" invents a date (archive footage, old rulings), so those are
  // dropped rather than guessed.
  for (const match of raw.matchAll(/\b(\d{1,2})(?:er)?\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})\b/giu)) {
    const day = Number(match[1]);
    const month = MONTHS[normalizeText(match[2])];
    const year = Number(match[3]);
    if (!month || day < 1 || day > 31 || year < 2000 || year > 2028) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    found.set(iso, match[0].replace(/\s+/g, " "));
  }
  return [...found.keys()].sort();
}

// Only the campaign year survives: older explicit dates in the text are
// biography, archive footage or previous rulings, and they were polluting the
// "commencement" signal. The raw match is still kept for audit below.
const VIDEO_DATES = new Map<string, string[]>();
for (const video of videos) VIDEO_DATES.set(video.id, rawDatesMentioned(video));

function datesMentioned(video: VideoRow): string[] {
  return (VIDEO_DATES.get(video.id) ?? []).filter((date) => date.startsWith("2026"));
}

// ── Event definitions (anchors verified present in the corpus) ────────────
interface EventDef {
  id: string;
  title: string;
  category: string;
  kind: "scandal" | "policy" | "campaign" | "society" | "international";
  isScandal: boolean;
  majorIssue: string;
  subIssue: string;
  anchors: string[];
  /** Videos matching any of these are dropped (e.g. "1961" disambiguation). */
  exclude?: string[];
  /** AND of OR-groups: every group must match at least one anchor. */
  groups?: string[][];
  notes?: string;
}

const EVENTS: EventDef[] = [
  {
    id: "lepen_conviction_ineligibility",
    title: "Marine Le Pen's conviction, ineligibility and the electronic bracelet",
    category: "justice",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Rule of law & scandals",
    subIssue: "Justice and convictions",
    anchors: ["bracelet électronique", "bracelet electronique", "assistants parlementaires", "inéligibilité", "ineligibilite", "détournement", "detournement", "condamnation", "condamné", "procès en appel"],
    notes: "The ruling predates the coverage window; no explicit ruling date appears in the corpus, so commencement is first coverage.",
  },
  {
    id: "rn_antisemitism_row",
    title: "RN antisemitism accusations and the Alain Soral reference",
    category: "racism",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Society & rights",
    subIssue: "Racism and antisemitism",
    anchors: ["antisémitisme", "antisemitisme", "antisémite", "antisemite", "soral"],
  },
  {
    id: "lycee_blockades_uni",
    title: "Lycée blockades and the UNI / Louise Montangon row",
    category: "education",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Society & rights",
    subIssue: "Education",
    anchors: ["blocus", "blocage", "blocages", "lycée", "lycee", "lycéens", "lyceens", "montangon", "uni"],
    groups: [
      ["montangon", "uni"],
      ["blocus", "blocage", "blocages", "lycée", "lycee", "lycéens", "lyceens"],
    ],
    notes: "Requires both the student-union thread and the blockade thread; 'lycée' alone is education coverage.",
  },
  {
    id: "adele_haenel_censorship",
    title: "Adèle Haenel, France 5 and the cancelled Grande Librairie",
    category: "media",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Media & democracy",
    subIssue: "Media and censorship",
    anchors: ["adèle haenel", "adele haenel", "haenel", "grande librairie", "france 5"],
    notes: "Bare 'censure' is excluded on purpose: it mostly means a motion of censure here.",
  },
  {
    id: "socialist_primary_glucksmann",
    title: "Socialist primary and Glucksmann's nomination",
    category: "campaign",
    kind: "campaign",
    isScandal: false,
    majorIssue: "Campaign",
    subIssue: "Primaries and nominations",
    anchors: ["primaire", "place publique", "primaire socialiste", "désigné candidat", "investiture"],
  },
  {
    id: "medef_ref_debate",
    title: "Seven-candidate debate at the MEDEF summer school (REF)",
    category: "campaign",
    kind: "campaign",
    isScandal: false,
    majorIssue: "Campaign",
    subIssue: "Debates",
    anchors: ["medef", "rencontre des entrepreneurs de france", "rencontre des entrepreneurs", "université d'été du medef"],
    notes: "The REF debate took place on 2026-08-27, before most of this coverage.",
  },
  {
    id: "pensions_reform",
    title: "Pensions and the reform at 64",
    category: "pensions",
    kind: "policy",
    isScandal: false,
    majorIssue: "Economy & work",
    subIssue: "Pensions",
    anchors: ["retraite", "retraites", "réforme des retraites", "reforme des retraites", "64 ans"],
  },
  {
    id: "purchasing_power_smic",
    title: "Purchasing power, the SMIC and prices",
    category: "purchasing_power",
    kind: "policy",
    isScandal: false,
    majorIssue: "Economy & work",
    subIssue: "Cost of living",
    anchors: ["smic", "pouvoir d'achat", "pouvoir d achats", "inflation", "salaire", "salaires", "coût de la vie", "prix"],
  },
  {
    id: "immigration_oqtf",
    title: "Immigration, OQTF and regularisation",
    category: "immigration",
    kind: "policy",
    isScandal: false,
    majorIssue: "Society & rights",
    subIssue: "Immigration",
    anchors: ["immigration", "oqtf", "sans-papiers", "sans papiers", "régularisation", "regularisation", "expulsion", "frontières", "frontieres"],
  },
  {
    id: "police_custody_igpn",
    title: "Police custody, IGPN and accusations of police violence",
    category: "police_violence",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Rule of law & scandals",
    subIssue: "Police and custody",
    anchors: ["garde à vue", "garde a vue", "igpn", "violences policières", "violences policieres", "contrôle au faciès", "controle au facies", "bavure"],
    notes: "Thin coverage: no 'violences policières' phrase in the corpus, custody and IGPN only.",
  },
  {
    id: "budget_deficit_493",
    title: "Budget, deficit and article 49.3",
    category: "government",
    kind: "policy",
    isScandal: false,
    majorIssue: "Economy & work",
    subIssue: "Budget and debt",
    anchors: ["budget", "déficit", "deficit", "dette publique", "49.3", "motion de censure"],
  },
  {
    id: "palestine_gaza",
    title: "Palestine, Gaza and the French left",
    category: "international",
    kind: "international",
    isScandal: false,
    majorIssue: "World",
    subIssue: "Middle East",
    anchors: ["palestine", "palestinien", "palestinienne", "gaza", "israël", "israel", "génocide", "genocide"],
  },
  {
    id: "ukraine_russia",
    title: "Ukraine, Russia and defence",
    category: "international",
    kind: "international",
    isScandal: false,
    majorIssue: "World",
    subIssue: "Ukraine and defence",
    anchors: ["ukraine", "poutine", "russie", "otan", "trump"],
  },
  {
    id: "heatwaves_fires",
    title: "Heatwaves, fires and the firefighter protest",
    category: "ecology",
    kind: "society",
    isScandal: false,
    majorIssue: "Society & rights",
    subIssue: "Ecology and climate",
    anchors: ["canicule", "incendie", "incendies", "pompier", "pompiers", "inondation", "sécheresse", "secheresse"],
  },
  {
    id: "hospital_health",
    title: "Hospital, doctors and access to care",
    category: "health",
    kind: "policy",
    isScandal: false,
    majorIssue: "Society & rights",
    subIssue: "Health",
    anchors: ["hôpital", "hopital", "santé", "sante", "médecin", "medecin", "désert médical", "desert medical", "sécurité sociale", "securite sociale"],
  },
  {
    id: "housing_rents",
    title: "Housing, rents and social housing",
    category: "housing",
    kind: "policy",
    isScandal: false,
    majorIssue: "Economy & work",
    subIssue: "Housing",
    anchors: ["logement", "loyers", "loyer", "hlm", "immobilier"],
  },
  {
    id: "strikes_demonstrations",
    title: "Strikes, unions and demonstrations",
    category: "labour",
    kind: "society",
    isScandal: false,
    majorIssue: "Economy & work",
    subIssue: "Labour and strikes",
    anchors: ["grève", "greve", "syndicat", "syndicats", "manifestation", "manifestants", "cgt", "cfdt", "salariés", "salaries"],
  },
  {
    id: "candidate_declarations",
    title: "Candidate declarations, meetings and polls",
    category: "campaign",
    kind: "campaign",
    isScandal: false,
    majorIssue: "Campaign",
    subIssue: "Declarations and meetings",
    anchors: ["candidature", "candidat à l'élection", "meeting", "sondage", "parrainage", "déclare candidate", "se déclare"],
  },
  {
    id: "protest_17_october",
    title: "The 17 October national mobilisation and its aftermath",
    category: "protest",
    kind: "society",
    isScandal: false,
    majorIssue: "Campaign",
    subIssue: "Protests",
    anchors: ["17 octobre", "manifs 17", "17 10", "journée de mobilisation"],
    groups: [
      ["17 octobre", "manifs 17"],
      ["manif", "manifestation", "manifestants", "mobilisation", "mobilisations", "rue", "pillage", "pillages", "greve", "grève"],
    ],
    exclude: ["1961"],
    notes: "Disambiguated from the 17 October 1961 massacre, which is a separate event in this corpus.",
  },
  {
    id: "paris_massacre_1961",
    title: "17 October 1961 and the memory of the Paris massacre",
    category: "memory",
    kind: "scandal",
    isScandal: true,
    majorIssue: "Rule of law & scandals",
    subIssue: "Police and custody",
    anchors: ["17 octobre 1961", "1961"],
    notes: "Memory-politics thread; 2026 mobilisation coverage is kept separate.",
  },
];

// ── Topic lexicons (also used for per-event sub-issue breakdown) ─────────
const TOPIC_LEXICONS: Record<string, string[]> = {
  education: ["lycée", "lycee", "école", "ecole", "université", "universite", "étudiant", "etudiant", "enseignant", "professeur", "bac", "éducation nationale", "education nationale", "blocus"],
  police_violence: ["garde à vue", "garde a vue", "igpn", "violences policières", "violences policieres", "contrôle au faciès", "controle au facies", "bavure", "matraque", "lacrymogène", "lacrymogene"],
  scandals: ["scandale", "affaire", "condamnation", "condamné", "procès", "corruption", "détournement", "detournement", "inéligibilité", "ineligibilite", "antisémitisme", "antisemitisme"],
  government: ["gouvernement", "premier ministre", "ministre", "élysée", "elysee", "49.3", "budget", "déficit", "deficit"],
  immigration: ["immigration", "oqtf", "sans-papiers", "sans papiers", "régularisation", "regularisation", "expulsion", "frontières", "frontieres"],
  security: ["insécurité", "insecurite", "délinquance", "delinquance", "narcotrafic", "police", "sécurité", "securite"],
  pensions: ["retraite", "retraites", "réforme des retraites", "reforme des retraites", "64 ans"],
  purchasing_power: ["smic", "pouvoir d'achat", "inflation", "salaire", "salaires", "coût de la vie", "prix"],
  ecology: ["climat", "écologie", "ecologie", "canicule", "incendie", "pompier", "pompiers", "inondation"],
  health: ["hôpital", "hopital", "santé", "sante", "médecin", "medecin", "sécurité sociale", "securite sociale"],
  housing: ["logement", "loyer", "loyers", "hlm", "immobilier"],
  labour: ["grève", "greve", "syndicat", "manifestation", "manifestants", "salariés", "salaries", "cgt", "cfdt"],
  racism: ["racisme", "raciste", "antisémite", "antisemite", "islamophobie", "discrimination"],
  international: ["palestine", "gaza", "israël", "israel", "ukraine", "poutine", "trump", "otan"],
  media: ["cnews", "bfmtv", "lci", "france inter", "journaliste", "média", "media"],
  institutions: ["assemblée nationale", "assemblee nationale", "sénat", "senat", "constitution", "motion de censure", "référendum", "referendum"],
  campaign: ["présidentielle", "presidentielle", "candidature", "sondage", "débat", "debat", "meeting", "parrainage"],
};

// ── Build events ──────────────────────────────────────────────────────────
interface Bucket {
  date: string;
  videos: number;
  candidates: Record<string, number>;
}

function eventMatches(video: VideoRow, def: EventDef): string[] {
  if (def.exclude && matches(video, def.exclude).length > 0) return [];
  if (!def.groups) return matches(video, def.anchors);
  const found: string[] = [];
  for (const group of def.groups) {
    const hit = matches(video, group);
    if (hit.length === 0) return [];
    found.push(...hit);
  }
  return found;
}

function buildEvent(def: EventDef) {
  const matched = videos.filter((video) => eventMatches(video, def).length > 0);
  if (matched.length < MIN_VIDEOS) return null;

  matched.sort((a, b) => (a.posted_at! < b.posted_at! ? -1 : 1));
  const daily = new Map<string, Bucket>();
  const candidateCounts: Record<string, number> = {};
  const platforms: Record<string, number> = {};
  const creators = new Set<string>();
  const mentioned = new Set<string>();

  for (const video of matched) {
    const date = DATE(video.posted_at!);
    const bucket = daily.get(date) ?? { date, videos: 0, candidates: {} };
    bucket.videos++;
    for (const candidate of CANDIDATES) {
      if (scanCandidate(text(video), candidate).length === 0) continue;
      bucket.candidates[candidate.id] = (bucket.candidates[candidate.id] ?? 0) + 1;
      candidateCounts[candidate.id] = (candidateCounts[candidate.id] ?? 0) + 1;
    }
    daily.set(date, bucket);
    platforms[video.platform] = (platforms[video.platform] ?? 0) + 1;
    creators.add(video.creator_handle ?? "unknown");
    for (const date2 of datesMentioned(video)) mentioned.add(date2);
  }

  const timeline = [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const peak = [...timeline].sort((a, b) => b.videos - a.videos)[0];
  const first = DATE(matched[0].posted_at!);
  const last = DATE(matched[matched.length - 1].posted_at!);

  const evidence = [...matched]
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 4)
    .map((video) => {
      const anchors = eventMatches(video, def);
      const source = text(video);
      const normalized = normalizeText(source);
      const needle = normalizeText(anchors[0] ?? "");
      const index = needle ? normalized.indexOf(needle) : -1;
      const quote = index >= 0 ? source.slice(Math.max(0, index - 60), index + needle.length + 60).replace(/\s+/g, " ").trim() : (video.caption ?? "").slice(0, 160);
      return {
        video_id: video.id,
        url: video.url,
        posted_at: video.posted_at,
        creator_handle: video.creator_handle,
        platform: video.platform,
        views: video.views,
        matched_anchors: anchors,
        quote,
      };
    });

  return {
    id: def.id,
    title: def.title,
    category: def.category,
    kind: def.kind,
    major_issue: def.majorIssue,
    sub_issue: def.subIssue,
    is_scandal: def.isScandal,
    commencement: first,
    first_covered_at: matched[0].posted_at,
    peak_date: peak?.date ?? first,
    peak_videos: peak?.videos ?? 0,
    last_covered_at: matched[matched.length - 1].posted_at!,
    duration_days: daysBetween(first, last),
    active_days: timeline.length,
    videos: matched.length,
    creators: creators.size,
    platforms,
    candidates: Object.entries(candidateCounts)
      .map(([id, count]) => ({ id, name: CANDIDATES_BY_ID[id]?.name ?? id, videos: count }))
      .sort((a, b) => b.videos - a.videos),
    anchors: def.anchors,
    commencement_basis: "first_covered_video",
    // Explicit dates only (year written in the text). These describe the
    // underlying facts, never the commencement of coverage.
    dates_mentioned_explicit: [...mentioned].sort(),
    earliest_mentioned_date: [...mentioned].sort()[0] ?? null,
    video_ids: matched.map((video) => video.id),
    timeline,
    // Which sub-issues inside the same major issue this event touches.
    topic_breakdown: Object.entries(TOPIC_LEXICONS)
      .map(([topicId, anchors]) => ({
        topic: topicId,
        videos: matched.filter((video) => matches(video, anchors).length > 0).length,
      }))
      .filter((row) => row.videos > 0)
      .sort((a, b) => b.videos - a.videos)
      .slice(0, 6),
    evidence,
    confidence: matched.length >= 8 ? "high" : matched.length >= 4 ? "medium" : "low",
    notes: def.notes ?? null,
  };
}

const events = EVENTS.map(buildEvent).filter(Boolean) as any[];
events.sort((a, b) => (a.commencement < b.commencement ? -1 : 1));

// ── Topics (issue rollups, including events too small to list) ────────────


function buildTopic(id: string, anchors: string[]) {
  const matched = videos.filter((video) => matches(video, anchors).length > 0);
  if (matched.length === 0) return null;
  matched.sort((a, b) => (a.posted_at! < b.posted_at! ? -1 : 1));
  const dates = matched.map((video) => DATE(video.posted_at!));
  const candidateCounts: Record<string, number> = {};
  for (const video of matched) {
    for (const candidate of CANDIDATES) {
      if (scanCandidate(text(video), candidate).length > 0) {
        candidateCounts[candidate.id] = (candidateCounts[candidate.id] ?? 0) + 1;
      }
    }
  }
  const daily = new Map<string, number>();
  for (const date of dates) daily.set(date, (daily.get(date) ?? 0) + 1);
  const timeline = [...daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, videos: count }));
  const peak = [...timeline].sort((a, b) => b.videos - a.videos)[0];
  return {
    id,
    label: id.replace(/_/g, " "),
    videos: matched.length,
    video_ids: matched.map((video) => video.id),
    creators: new Set(matched.map((video) => video.creator_handle)).size,
    first_covered_at: dates[0],
    last_covered_at: dates[dates.length - 1],
    peak_date: peak?.date ?? dates[0],
    active_days: timeline.length,
    candidates: Object.entries(candidateCounts)
      .map(([candidateId, count]) => ({ id: candidateId, name: CANDIDATES_BY_ID[candidateId]?.name ?? candidateId, videos: count }))
      .sort((a, b) => b.videos - a.videos),
    timeline,
  };
}

const topics = Object.entries(TOPIC_LEXICONS)
  .map(([id, anchors]) => buildTopic(id, anchors))
  .filter(Boolean) as any[];

// ── Output ────────────────────────────────────────────────────────────────
const window = {
  first: DATE(videos.map((video) => video.posted_at!).sort()[0]),
  last: DATE(videos.map((video) => video.posted_at!).sort().slice(-1)[0]),
};


// ── Hierarchy: major issue → sub-issue → topics/events ────────────────────
const TOPIC_GROUPS: Record<string, { major: string; sub: string }> = {
  education: { major: "Society & rights", sub: "Education" },
  police_violence: { major: "Rule of law & scandals", sub: "Police and custody" },
  scandals: { major: "Rule of law & scandals", sub: "Justice and convictions" },
  government: { major: "State & institutions", sub: "Government" },
  immigration: { major: "Society & rights", sub: "Immigration" },
  security: { major: "Society & rights", sub: "Security" },
  pensions: { major: "Economy & work", sub: "Pensions" },
  purchasing_power: { major: "Economy & work", sub: "Cost of living" },
  ecology: { major: "Society & rights", sub: "Ecology and climate" },
  health: { major: "Society & rights", sub: "Health" },
  housing: { major: "Economy & work", sub: "Housing" },
  labour: { major: "Economy & work", sub: "Labour and strikes" },
  racism: { major: "Society & rights", sub: "Racism and antisemitism" },
  international: { major: "World", sub: "International" },
  media: { major: "Media & democracy", sub: "Media and censorship" },
  institutions: { major: "State & institutions", sub: "Institutions" },
  campaign: { major: "Campaign", sub: "Declarations and meetings" },
};

function buildIssueGroups() {
  const groups = new Map<string, Map<string, { topics: any[]; events: any[]; videoIds: Set<string> }>>();
  for (const topic of topics) {
    const meta = TOPIC_GROUPS[topic.id];
    if (!meta) continue;
    if (!groups.has(meta.major)) groups.set(meta.major, new Map());
    const subs = groups.get(meta.major)!;
    if (!subs.has(meta.sub)) subs.set(meta.sub, { topics: [], events: [], videoIds: new Set() });
    const bucket = subs.get(meta.sub)!;
    bucket.topics.push({ id: topic.id, videos: topic.videos, first: topic.first_covered_at, last: topic.last_covered_at });
    for (const id of topic.video_ids) bucket.videoIds.add(id);
  }
  for (const event of events) {
    if (!groups.has(event.major_issue)) groups.set(event.major_issue, new Map());
    const subs = groups.get(event.major_issue)!;
    if (!subs.has(event.sub_issue)) subs.set(event.sub_issue, { topics: [], events: [], videoIds: new Set() });
    const bucket = subs.get(event.sub_issue)!;
    bucket.events.push({ id: event.id, videos: event.videos, commencement: event.commencement, is_scandal: event.is_scandal });
    for (const id of event.video_ids) bucket.videoIds.add(id);
  }
  return [...groups.entries()]
    .map(([major, subs]) => ({
      major_issue: major,
      sub_issues: [...subs.entries()].map(([sub, bucket]) => ({
        sub_issue: sub,
        topics: bucket.topics,
        events: bucket.events,
        videos: bucket.videoIds.size,
      })).sort((a, b) => b.videos - a.videos),
      videos: new Set([...subs.values()].flatMap((bucket) => [...bucket.videoIds])).size,
    }))
    .sort((a, b) => b.videos - a.videos);
}

// ── Candidate × topic matrix (what each candidate is talked about) ────────
function buildCandidateTopicMatrix() {
  const stancePath = ["data/analyses/runs/v2-fuzzy/candidate-stance.json", "data/analyses/candidate-stance.json"]
    .find((path) => existsSync(path));
  const labels = new Map<string, string>();
  if (stancePath) {
    for (const row of JSON.parse(readFileSync(stancePath, "utf8")).videos) {
      labels.set(`${row.video_id}|${row.candidate_id}`, row.label);
    }
  }
  const matrix = [];
  for (const candidate of CANDIDATES) {
    const topicsForCandidate = [];
    for (const [topicId, anchors] of Object.entries(TOPIC_LEXICONS)) {
      let count = 0;
      const leaning = { favorable: 0, critical: 0, neutral: 0, unclear: 0 };
      for (const video of videos) {
        if (matches(video, anchors).length === 0) continue;
        if (scanCandidate(text(video), candidate).length === 0) continue;
        count++;
        const label = labels.get(`${video.id}|${candidate.id}`) as keyof typeof leaning | undefined;
        if (label && label in leaning) leaning[label]++;
        else leaning.unclear++;
      }
      if (count === 0) continue;
      topicsForCandidate.push({
        topic: topicId,
        videos: count,
        ...leaning,
        index: Number(((leaning.favorable - leaning.critical) / count).toFixed(3)),
      });
    }
    if (topicsForCandidate.length === 0) continue;
    matrix.push({
      candidate_id: candidate.id,
      name: candidate.name,
      party: candidate.partyShort,
      videos: topicsForCandidate.reduce((total, row) => total + row.videos, 0),
      topics: topicsForCandidate.sort((a, b) => b.videos - a.videos),
      stance_source: stancePath ?? null,
    });
  }
  return matrix.sort((a, b) => b.videos - a.videos);
}

const issueGroups = buildIssueGroups();
const candidateTopicMatrix = buildCandidateTopicMatrix();

const payload = {
  generatedAt: new Date().toISOString(),
  window,
  method: {
    source: `${files.length} candidate files in data/oriane`,
    videos: videos.length,
    minVideosPerEvent: MIN_VIDEOS,
    anchors: "curated phrase sets, verified present in the corpus",
    dates: "commencement = first covered video; dates_mentioned = explicit dates in the text",
    noModelCalls: true,
  },
  summary: {
    events: events.length,
    scandals: events.filter((event) => event.is_scandal).length,
    topics: topics.length,
    earliest_event: events[0]?.commencement ?? null,
    latest_event: events.map((event) => event.last_covered_at.slice(0, 10)).sort().slice(-1)[0] ?? null,
    videosCoveredByAnEvent: new Set(events.flatMap((event) => event.video_ids)).size,
    latestCoverage: events.map((event) => event.last_covered_at.slice(0, 10)).sort().slice(-1)[0] ?? null,
  },
  scandals: events.filter((event) => event.is_scandal),
  issue_groups: issueGroups,
  events,
  topics,
  candidate_topic_matrix: candidateTopicMatrix,
};

mkdirSync("data/analyses", { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2));

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const csvRows: string[] = ["event_id,title,category,kind,is_scandal,date,videos,candidates"];
for (const event of events) {
  for (const bucket of event.timeline) {
    csvRows.push([
      event.id, event.title, event.category, event.kind, event.is_scandal,
      bucket.date, bucket.videos, Object.keys(bucket.candidates).join("|"),
    ].map(csvCell).join(","));
  }
}
writeFileSync("data/analyses/events.csv", csvRows.join("\n"));

// ── Report ────────────────────────────────────────────────────────────────
console.log(`Window ${window.first} → ${window.last} | ${videos.length} French videos | ${events.length} events (${payload.summary.scandals} scandals)\n`);
console.log(
  table(
    events.map((event) => ({
      id: event.id,
      start: event.commencement,
      end: event.last_covered_at.slice(0, 10),
      videos: event.videos,
      days: event.duration_days,
      scandal: event.is_scandal ? "yes" : "",
      conf: event.confidence,
    })),
  ),
);

console.log("\nTopics:");
console.log(
  table(
    topics
      .slice()
      .sort((a, b) => b.videos - a.videos)
      .map((topic) => ({
        topic: topic.id,
        videos: topic.videos,
        first: topic.first_covered_at,
        last: topic.last_covered_at,
        peak: topic.peak_date,
        candidates: topic.candidates.slice(0, 3).map((candidate: any) => candidate.id).join(","),
      })),
  ),
);

console.log(`\nWrote ${OUT} and data/analyses/events.csv`);
