# Inception — requirements

Product: **Factpicker**, a social-video barometer for the 2027 French
presidential campaign. Source of truth for pages: `docs/Social video barometer.pdf`.
Data window: 2026-06-01 → 2026-11-02 (our snapshot starts 2026-08-08).

## Functional requirements

| ID | Requirement | Acceptance criteria | Verified by |
|---|---|---|---|
| R1 | Expose recorded videos with creator, platform, date, reach and format | any video id resolves; url is a working canonical link | `video detail` test |
| R2 | Expose per-video verdicts toward a candidate with evidence | directional verdict always has a quote; held-out labels are UNCLEAR | `video detail` test |
| R3 | Expose a fact catalog and, per fact, the stories creators attach to it | stories partition the cited videos exactly once | `story` test |
| R4 | Expose, per fact, which candidate each story is aimed at and with what leaning | aimedAt rows have videos > 0 and valid leannings | `story` test |
| R5 | Expose events with commencement, timeline and evidence | timeline sums to the event's video count | `issueGroups` / artifact tests |
| R6 | Expose before/after impact per candidate for an event, default 7 days | event-day videos excluded; changePct null iff before = 0 | `eventImpact` test |
| R7 | Expose the issue hierarchy (major → sub-issue → topics/events) | every event appears exactly once | `issueGroups` test |
| R8 | Expose creator-level stance, never from a single video | minVideos default 2; counts sum to videos | `creator` test |
| R9 | Provide search over video text, and semantic search when Vertex is on | results sorted, method reported | `search` test |
| R10 | Serve over one HTTP endpoint with auth, limits and request ids | healthz + POST round-trip; 401/413/400 paths | `HTTP` test |

## Non-functional requirements

| ID | Requirement | Target | Verified by |
|---|---|---|---|
| N1 | Read-only by construction | no write path in the API process | code review + §6 of the contract |
| N2 | No fabricated evidence | every directional label carries a verbatim or fuzzy-matched quote | R2 test |
| N3 | Honest nullability | undefined values are null, never 0 or a sentinel | `changePct` test |
| N4 | Deterministic local operation | API runs fully offline from artifacts | tests run with no credentials |
| N5 | Bounded payloads | 256 KB request cap; list limits with defaults | `HTTP` test + schema |
| N6 | Versioned contract | apiVersion reported in data and extensions | `apiVersion` test |

## Non-goals (v0.1)

- No writes, no user accounts, no per-user labels.
- No claim that a creator's interpretation is true or false — the product records it.
- No poll inference: the corpus is a sample of indexed videos, not a survey.
- No public exposure of named-creator labels (newsroom view only, per the brief).
