export type Platform = "instagram" | "tiktok" | "youtube";
export type PlatformFormat = "image" | "video" | "carousel";
export type VideoFormat = "talking" | "image_post";
export type SourceField = "caption" | "transcript" | "on_screen_text";
export type MatchStrength = "strong" | "weak";
export type Leaning = "favorable" | "critical" | "neutral" | "unclear";
export type Tone =
  | "informative"
  | "critical"
  | "mocking"
  | "alarmed"
  | "enthusiastic"
  | "personal";
export type Confidence = "low" | "medium" | "high";

export type CandidateTier = "frontrunner" | "major" | "minor";

export interface CandidateDef {
  id: string;
  name: string;
  party: string;
  partyShort?: string;
  status: "declared" | "presumed" | "not_declared" | "not_declared_discussed";
  tier: CandidateTier;
  statusNote?: string;
  slogan?: string;
  /** Community ids from communities.ts that amplify or oppose this candidate. */
  communities: string[];
  /** Full names and speech-to-text variants. A hit here is a strong mention. */
  aliases: string[];
  /** Surname-only or truncated forms. A hit here is a weak mention. */
  weakAliases: string[];
  /** Party / movement labels. Recorded as a signal, never as a mention. */
  partySignals: string[];
}

export interface TermHit {
  candidateId: string;
  term: string;
  strength: MatchStrength;
  count: number;
  /** Character offsets into the field's original text, for highlighting. */
  occurrences: Array<{ start: number; end: number }>;
}

export interface FieldScan {
  field: SourceField;
  hits: TermHit[];
}

export interface MentionRow {
  video_id: string;
  candidate_id: string;
  matched_terms: string[];
  source_field: SourceField;
  /** Field instance: "transcript", "caption" or "on_screen_text[2]". */
  source_key: string;
  strength: MatchStrength;
  occurrences: Array<{ start: number; end: number }>;
}

export interface VideoRow {
  id: string;
  platform: Platform;
  platform_id: string | null;
  url: string;
  creator_handle: string | null;
  creator_display_name: string | null;
  creator_followers: number | null;
  creator_verified: boolean | null;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  interactions: number | null;
  title: string | null;
  caption: string | null;
  caption_language: string | null;
  transcript: string | null;
  transcript_language: string | null;
  on_screen_text: string[];
  visual_tags: string[];
  platform_format: PlatformFormat | null;
  format: VideoFormat;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  is_french: boolean;
  party_signals: string[];
  source: "oriane";
  raw?: unknown;
}

export interface AnalysisRow {
  video_id: string;
  candidate_id: string;
  leaning: Leaning;
  evidence_quote: string | null;
  evidence_source: SourceField | null;
  evidence_verified: boolean;
  tone: Tone;
  confidence: Confidence;
  model: string | null;
  prompt_version: string;
}

export interface ClaimRow {
  video_id: string;
  candidate_id: string;
  claim_text: string;
  issue: string | null;
  evidence_quote: string | null;
}
