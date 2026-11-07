# Construction — U1 test plan and results

Command: `cd api && npm test`. Result: **11/11 passing** (2026-11-07).

| Test | Requirement | What it proves |
|---|---|---|
| schema is valid and exposes v0.1 surface | R10, N6 | SDL builds; all Query fields exist; `changePct` nullable |
| apiVersion and candidates resolve | R1, N6 | contract version + candidate metadata |
| story: stories and targets reconcile | R3, R4 | stories partition cited videos exactly once |
| events: filtering and scandal consistency | R5 | filters by scandal/major issue/kind are honoured |
| eventImpact: windows exclude the event day | R6, N3 | before/after recomputed by hand; leaning sums = after; null baseline |
| issueGroups: every event appears exactly once | R7 | no duplicate or dropped events in the hierarchy |
| video detail: verified evidence + held-out labels | R2, N2 | directional labels carry quotes; held-out are UNCLEAR |
| search: lexical by default, descending | R9, N4 | ordering, method reporting, no network |
| creator: aggregates stance and lists videos | R8 | counts sum to videos; |index| ≤ 1; minVideos |
| bad input fails loudly | R10 | unknown field is a validation error; unknown id → null |
| HTTP: /healthz and POST /graphql round-trip | R10, N1 | real server boots, serves, returns extensions |

## Not covered here (owned by other suites)

- Artifact invariants: `test/api/events.test.ts` (10 tests) — timelines, evidence
  provenance, hierarchy, candidate×topic matrix.
- Stance quality: `test/unit/stance-quality.test.ts`, `test/api/stance.test.ts`.
- Schema/DDL: `scripts/verify-schema.sh` against Postgres 16.

## Exit criteria for U1

- [x] all tests green with no credentials
- [x] contract documented in `docs/api-v0.1.md`
- [x] every PDF page mapped to a query
- [ ] deployed behind the token gate (U4)
