import type { CandidateDef, Platform, SourceField } from "./types.ts";
import { CANDIDATES, DEMO_CANDIDATE_IDS, TOPICS } from "./candidates.ts";
import { COMMUNITIES, COMMUNITIES_BY_ID, MEDIA_HANDLES, PARTY_HANDLES } from "./communities.ts";
import type { ContentFilters, ContentQuery, SearchParams, SortField } from "./oriane.ts";
import { TEXT_FIELDS, textFilter } from "./oriane.ts";

/**
 * Query catalog.
 *
 * Every entry is one question a journalist can ask of the index, expressed as a
 * concrete `POST /rest/contents/search` body. They are deliberately layered:
 * a text-only query finds the video, while the creator / engagement / format /
 * vision facets describe *what kind of post* it is. Combine them by starting
 * from the candidate group and adding root filters (see `combine`).
 *
 * Verified constraints (live API, 2026-11-07):
 *  - 100 results per page max; `limit` and `offset` only.
 *  - One operand per field per filter object, so language and text for the same
 *    field cannot share an object.
 *  - Root filters must be AND-ed with a SINGLE nested OR group; putting three
 *    sub-queries as siblings under `operator: "and"` turns the OR into an AND.
 *  - `transcriptLanguage` excludes image posts (no transcript), so filter
 *    language after fetching instead.
 *  - 500 filter values max across all levels; 2 nesting levels; 10 visual
 *    similarity values.
 *  - Hashtags are indexed with the leading "#": match "#lepen", not "lepen".
 *  - Accents are significant in `includesExactly` ("Édouard" ≠ "Edouard").
 */

export type QueryFacet =
  | "candidate"
  | "topic"
  | "format"
  | "on_screen_text"
  | "creator"
  | "engagement"
  | "audio"
  | "hashtag"
  | "mention"
  | "community"
  | "location"
  | "vision"
  | "temporal";

export interface QueryContext {
  candidates?: CandidateDef[];
  candidateIds?: string[];
  fields?: SourceField[];
  since?: string;
  until?: string;
  platforms?: Platform[];
  assets?: Record<string, string>;
}

export interface QuerySpec {
  id: string;
  facet: QueryFacet;
  title: string;
  /** The journalistic question this query answers. */
  question: string;
  notes?: string;
  build: (ctx: QueryContext) => ContentQuery;
  params?: Partial<SearchParams>;
  /** Applied after fetching, because the index cannot express it. */
  postFilter?: "french" | "none";
}

function resolveCandidates(ctx: QueryContext): CandidateDef[] {
  if (ctx.candidates?.length) return ctx.candidates;
  const ids = ctx.candidateIds ?? DEMO_CANDIDATE_IDS;
  return ids.map((id) => CANDIDATES.find((c) => c.id === id)).filter(Boolean) as CandidateDef[];
}

function globalFilters(ctx: QueryContext, extra: ContentFilters = {}): ContentFilters {
  const filters: ContentFilters = { ...extra };
  if (ctx.since || ctx.until) {
    filters.publishedAt = {};
    if (ctx.since) filters.publishedAt.after = ctx.since;
    if (ctx.until) filters.publishedAt.before = ctx.until;
  }
  // Only add a platform filter when the caller asked for one, and never
  // overwrite an explicit filter: the index only has these three platforms, so
  // "no filter" already means "all platforms".
  if (ctx.platforms?.length && !filters.platform) {
    filters.platform = { includes: ctx.platforms, operator: "and" };
  }
  return filters;
}

/** Candidate × text-field sub-queries, OR-ed together. */
export function candidateOrGroup(
  candidates: CandidateDef[],
  fields: SourceField[] = TEXT_FIELDS,
  includeWeak = true,
): ContentQuery {
  const subQueries: ContentQuery[] = [];
  for (const candidate of candidates) {
    const values = includeWeak
      ? [...candidate.aliases, ...candidate.weakAliases]
      : candidate.aliases;
    for (const field of fields) {
      subQueries.push({
        name: `${candidate.id}|${field}`,
        operator: "and",
        filters: textFilter(field, values),
      });
    }
  }
  return { operator: "or", queries: subQueries };
}

/**
 * The canonical composition: root AND(filters, OR(candidate sub-queries)).
 * Adding a facet = one more root filter.
 */
export function combine(
  ctx: QueryContext,
  group: ContentQuery | null,
  extra: ContentFilters = {},
): ContentQuery {
  const filters = globalFilters(ctx, extra);
  const body: ContentQuery = { operator: "and" };
  if (Object.keys(filters).length) body.filters = filters;
  if (group) body.queries = [group];
  return body;
}

/** Standalone filter-only query (no candidate group). */
export function filterOnly(ctx: QueryContext, extra: ContentFilters): ContentQuery {
  return { operator: "and", filters: globalFilters(ctx, extra) };
}

function termGroup(terms: string[], fields: SourceField[], name: string): ContentQuery {
  return {
    operator: "or",
    queries: fields.map((field) => ({
      name: `${name}|${field}`,
      operator: "and" as const,
      filters: textFilter(field, terms),
    })),
  };
}

/**
 * Position on the political spectrum, for community-vs-candidate framing.
 * Returns the community's own aliases, so a hit is a community mention.
 */
export function communityGroup(communityId: string, fields: SourceField[] = TEXT_FIELDS): ContentQuery {
  const community = COMMUNITIES_BY_ID[communityId];
  if (!community) throw new Error(`Unknown community: ${communityId}`);
  return {
    operator: "and",
    filters: {},
    queries: [termGroup(community.aliases, fields, community.id)],
  };
}

export const QUERY_CATALOG: QuerySpec[] = [
  // ── 1. Candidate framing ───────────────────────────────────────────────
  {
    id: "candidate_text_all",
    facet: "candidate",
    title: "Candidate mentioned in transcript, caption or on-screen text",
    question: "Which videos talk about this candidate at all?",
    notes: "Discovery query. Weak (surname-only) aliases included; strength is computed locally.",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx))),
  },
  {
    id: "candidate_spoken_only",
    facet: "candidate",
    title: "Candidate said out loud (transcript only)",
    question: "What does the video actually say about the candidate, as opposed to what the caption claims?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx), ["transcript"])),
  },
  {
    id: "candidate_caption_only",
    facet: "candidate",
    title: "Candidate in the caption only",
    question: "Which posts are sold by their caption rather than their content?",
    notes: "High-yield for hashtag-activism posts and reposted clips.",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx), ["caption"])),
  },
  {
    id: "candidate_on_screen_only",
    facet: "candidate",
    title: "Candidate on screen but never spoken",
    question: "Which videos show the candidate's name as an overlay without discussing them?",
    notes: "The image-post and meme layer: OCR text carries the framing.",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx), ["on_screen_text"])),
  },
  {
    id: "candidate_pair",
    facet: "candidate",
    title: "Two candidates in the same video",
    question: "Who is being contrasted with whom?",
    notes:
      "Oriane allows two nesting levels, so 'A in any field AND B in any field' cannot be expressed as two OR groups. " +
      "This body finds A; intersect the result with B's mentions locally (buildMentions) to get the pair. " +
      "A video mentioning A and B may favour A while mocking B: leaning stays per candidate.",
    build: (ctx) => {
      const [a] = resolveCandidates(ctx);
      return combine(ctx, candidateOrGroup([a]));
    },
  },

  // ── 2. Topics and issues ───────────────────────────────────────────────
  {
    id: "topic_issue",
    facet: "topic",
    title: "Issue-specific coverage (retraites, immigration, pouvoir d'achat…)",
    question: "Which issue does each camp use to attack or defend a candidate?",
    notes: "Oracle: replace TOPICS key. Issue is a second dimension on the mention, not a global filter.",
    build: (ctx) => {
      const topic = TOPICS.retraites;
      return combine(ctx, termGroup(topic.terms, TEXT_FIELDS, "topic"));
    },
  },
  {
    id: "topic_candidate_cross",
    facet: "topic",
    title: "Candidate × issue cross-tab",
    question: "For a given issue, which candidates are invoked and by whom?",
    notes:
      "The issue rides as a root filter on the transcript, so it is AND-ed with the candidate OR group " +
      "at a legal nesting depth. Swap the field to caption/onScreenText for the image-post layer.",
    build: (ctx) => {
      const topic = TOPICS.immigration;
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        transcript: { includesExactly: { values: topic.terms, operator: "or" } },
      });
    },
  },
  {
    id: "topic_election_context",
    facet: "topic",
    title: "Election context without naming a candidate",
    question: "What is the ambient campaign conversation?",
    build: (ctx) => combine(ctx, termGroup(TOPICS.presidentielle_2027.terms, TEXT_FIELDS, "presidentielle")),
  },

  // ── 3. Format semantics ────────────────────────────────────────────────
  {
    id: "format_image_post",
    facet: "format",
    title: "Image and carousel posts",
    question: "What framing lives in stills, where caption and overlay carry everything?",
    notes: "The idea doc's 'image post' bucket. format=image|carousel.",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { format: { includes: ["image", "carousel"] } }),
  },
  {
    id: "format_video_talking",
    facet: "format",
    title: "Talking-head video",
    question: "Which videos are direct address rather than montage or slideshow?",
    notes: "Platform format video; the local classifier then splits talking vs image_post on transcript length.",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { format: { includes: ["video"] } }),
  },
  {
    id: "format_short_form",
    facet: "format",
    title: "Short-form native (Reels, Shorts, TikTok video)",
    question: "What is the short-form layer of the campaign?",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        platformType: {
          includes: [
            { platform: "instagram", type: "reel" },
            { platform: "youtube", type: "short" },
            { platform: "tiktok", type: "video" },
          ],
        },
      }),
  },
  {
    id: "format_live",
    facet: "format",
    title: "Live and long-form",
    question: "Which campaign moments are broadcast rather than edited?",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        platformType: { includes: [{ platform: "youtube", type: "live" }, { platform: "youtube", type: "video" }] },
      }),
  },

  // ── 4. On-screen text ──────────────────────────────────────────────────
  {
    id: "onscreen_claim_terms",
    facet: "on_screen_text",
    title: "Claim language burned into the image",
    question: "Which slogans and accusations appear as text overlays?",
    notes: "Typed text, not speech-to-text: the most reliable signal for names and slogans.",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx), ["on_screen_text"]), {}),
  },

  // ── 5. Creator facets ──────────────────────────────────────────────────
  {
    id: "creator_mega",
    facet: "creator",
    title: "Mega accounts (1M+ followers)",
    question: "Which frames reach the largest audiences?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { profileFollowersCount: { min: 1_000_000 } }),
  },
  {
    id: "creator_micro",
    facet: "creator",
    title: "Micro creators (10k–100k followers)",
    question: "What does the campaign look like outside institutional media?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { profileFollowersCount: { min: 10_000, max: 100_000 } }),
  },
  {
    id: "creator_media_handles",
    facet: "creator",
    title: "Newsroom accounts",
    question: "How do media accounts frame the candidate versus individual creators?",
    notes: "Handles verified against the index; use includesExactly with the bare handle, not '@handle'.",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        profileHandle: { includesExactly: { values: MEDIA_HANDLES, operator: "or" } },
      }),
  },
  {
    id: "creator_party_handles",
    facet: "creator",
    title: "Party accounts",
    question: "What does the party itself publish about its candidate?",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        profileHandle: { includesExactly: { values: PARTY_HANDLES, operator: "or" } },
      }),
  },

  // ── 6. Engagement facets ───────────────────────────────────────────────
  {
    id: "engagement_high_rate",
    facet: "engagement",
    title: "High engagement rate (10%+)",
    question: "Which framing actually lands, rather than just being seen?",
    notes: "engagementRatePerViews is a percentage and tolerates outliers, so pair it with a view floor.",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        engagementRatePerViews: { min: 10 },
        viewsCount: { min: 10_000 },
      }),
  },
  {
    id: "engagement_viral",
    facet: "engagement",
    title: "Viral (1M+ views)",
    question: "Which videos shaped the widest first impression?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { viewsCount: { min: 1_000_000 } }),
  },
  {
    id: "engagement_small_account_outlier",
    facet: "engagement",
    title: "Small account, outsized reach",
    question: "Which unknown creators broke out on a candidate?",
    notes: "viewsRatePerFollowers > 100 means the video travelled far beyond the follower base.",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        profileFollowersCount: { max: 50_000 },
        viewsCount: { min: 100_000 },
      }),
  },

  // ── 7. Audio ───────────────────────────────────────────────────────────
  {
    id: "audio_trend",
    facet: "audio",
    title: "Videos built on a specific sound",
    question: "Which audio trend is being used to frame a candidate?",
    notes: "audioTitle/audioAuthor are exact-phrase filters; feed a sound discovered from a sample.",
    build: (ctx) => filterOnly(ctx, { audioTitle: { includesExactly: { values: ["La Marseillaise"], operator: "or" } } }),
  },
  {
    id: "audio_copyrighted",
    facet: "audio",
    title: "Commercial music rather than original audio",
    question: "Which posts are edited productions versus raw speech?",
    build: (ctx) => filterOnly(ctx, { audioCopyrighted: true }),
  },

  // ── 8. Hashtags ────────────────────────────────────────────────────────
  {
    id: "hashtag_campaign",
    facet: "hashtag",
    title: "Campaign hashtags",
    question: "Which coordinated hashtags are in play?",
    notes: "Index stores '#' in the value: '#presidentielle2027', not 'presidentielle2027'.",
    build: (ctx) =>
      filterOnly(ctx, {
        hashtags: { includesExactly: { values: ["#presidentielle2027", "#presidentielle", "#2027"], operator: "or" } },
      }),
  },

  // ── 9. Mentions and co-authors ─────────────────────────────────────────
  {
    id: "mention_any",
    facet: "mention",
    title: "Posts that tag another account",
    question: "Which posts are part of a coordinated tagging pattern?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { hasMentions: true }),
  },
  {
    id: "coauthor_duet",
    facet: "mention",
    title: "Duets, stitches and collabs",
    question: "Which videos are replies to another creator's framing?",
    build: (ctx) => combine(ctx, candidateOrGroup(resolveCandidates(ctx)), { hasCoAuthors: true }),
  },

  // ── 10. Communities ────────────────────────────────────────────────────
  {
    id: "community_union_left",
    facet: "community",
    title: "Union voices (CGT, Solidaires, FO)",
    question: "How do unions frame the candidates they oppose or back?",
    notes: "Community mention is a separate signal from a candidate mention.",
    build: (ctx) => {
      const aliases = [...COMMUNITIES_BY_ID.cgt.aliases, ...COMMUNITIES_BY_ID.solidaires.aliases];
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        transcript: { includesFuzzy: { values: aliases, operator: "or" } },
      });
    },
  },
  {
    id: "community_youth_wings",
    facet: "community",
    title: "Party youth wings",
    question: "Which youth structure is amplifying which candidate?",
    build: (ctx) => {
      const aliases = COMMUNITIES.filter((c) => c.type === "party_youth").flatMap((c) => c.aliases);
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        transcript: { includesFuzzy: { values: aliases, operator: "or" } },
      });
    },
  },
  {
    id: "community_ngos",
    facet: "community",
    title: "NGOs and advocacy groups",
    question: "Which candidates are being held to account by civil society?",
    build: (ctx) => {
      const aliases = COMMUNITIES.filter((c) => c.type === "ngo" || c.type === "think_tank").flatMap((c) => c.aliases);
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        transcript: { includesFuzzy: { values: aliases, operator: "or" } },
      });
    },
  },

  // ── 11. Location ───────────────────────────────────────────────────────
  {
    id: "location_tagged",
    facet: "location",
    title: "Tagged location",
    question: "Where was the video shot, and does place change the frame?",
    notes: "locationCompleteAddress is sparse (most posts are untagged); use it for meetings and field reporting.",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        locationCompleteAddress: { includesExactly: { values: ["Paris"], operator: "or" } },
      }),
  },
  {
    id: "location_profile",
    facet: "location",
    title: "Creator based in a given area",
    question: "Is the framing different outside the Paris news bubble?",
    build: (ctx) =>
      combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        profileLocationCompleteAddress: {
          includesExactly: { values: ["Marseille"], operator: "or" },
        },
      }),
  },

  // ── 12. Vision ─────────────────────────────────────────────────────────
  {
    id: "vision_semantic_anchor",
    facet: "vision",
    title: "Visually similar to a described scene",
    question: "Which videos *show* the candidate's world even when nobody names them?",
    notes:
      "Create a text asset once (POST /rest/assets {type:'text', text:'…'}), then filter by its id. " +
      "Semantic, not face recognition: it matches scenes, compositions and graphics. Keep minScore >= 0.3 " +
      "and pair with a text filter, because score-only searches return millions of rows.",
    build: (ctx) => {
      const assetId = ctx.assets?.podium ?? "ast_REPLACE_ME";
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        visualSimilarity: { includes: { values: [{ assetId, minScore: 0.3 }], operator: "or" } },
      });
    },
  },
  {
    id: "vision_image_anchor",
    facet: "vision",
    title: "Same graphic reused across creators",
    question: "Which accounts are reposting the same campaign visual?",
    notes: "Create the asset from an image URL (type:'url'). Frames expose visualSimilarityScore per video.",
    build: (ctx) => {
      const assetId = ctx.assets?.poster ?? "ast_REPLACE_ME";
      return combine(ctx, candidateOrGroup(resolveCandidates(ctx)), {
        visualSimilarity: { includes: { values: [{ assetId, minScore: 0.6 }], operator: "or" } },
      });
    },
  },

  // ── 13. Temporal ───────────────────────────────────────────────────────
  {
    id: "temporal_debate",
    facet: "temporal",
    title: "Around the MEDEF debate (2026-08-27)",
    question: "How did the seven-candidate debate shift the frames?",
    build: (ctx) =>
      combine({ ...ctx, since: "2026-08-26", until: "2026-09-02" }, candidateOrGroup(resolveCandidates(ctx))),
  },
  {
    id: "temporal_conviction",
    facet: "temporal",
    title: "Around the Le Pen appeal ruling (2026-07-07)",
    question: "How did creators cover the ruling and her declaration?",
    build: (ctx) =>
      combine({ ...ctx, since: "2026-07-06", until: "2026-07-13" }, candidateOrGroup(resolveCandidates(ctx))),
  },
];

export const QUERY_CATALOG_BY_ID: Record<string, QuerySpec> = Object.fromEntries(
  QUERY_CATALOG.map((spec) => [spec.id, spec]),
);

/** The demo pull: top N videos per candidate, ranked by interactions. */
export function topVideosQuery(
  candidate: CandidateDef,
  options: { since?: string; fields?: SourceField[]; platforms?: Platform[] } = {},
): ContentQuery {
  return combine(
    { candidates: [candidate], since: options.since, platforms: options.platforms },
    candidateOrGroup([candidate], options.fields),
  );
}

export const QUERY_FACETS: QueryFacet[] = [
  "candidate", "topic", "format", "on_screen_text", "creator",
  "engagement", "audio", "hashtag", "mention", "community", "location",
  "vision", "temporal",
];
