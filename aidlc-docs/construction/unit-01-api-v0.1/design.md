# Construction — U1 API v0.1

## Files

| File | Responsibility |
|---|---|
| `api/schema.graphql` | frozen contract, SDL |
| `api/src/sources.ts` | artifact loader, Supabase adapter, Vertex embedding client |
| `api/src/derive.ts` | `buildIndex`, `eventImpact`, `buildFact`, `lexicalSearch`, `creatorStance` |
| `api/src/resolvers.ts` | type/field mapping, enums, nullability, evidence shaping |
| `api/src/app.ts` | schema build, context factory, custom `fieldResolver` dispatch |
| `api/src/server.ts` | HTTP, auth, body cap, CORS, health, request ids |
| `api/test/api.test.ts` | 11 tests incl. live HTTP round-trip |

## Implementation notes

- **Batching:** `buildIndex` precomputes video↔candidate mentions once per process;
  resolvers never rescan the corpus per field. `factsByVideo` is computed at boot.
- **Nullability:** `changePct` is nullable; `Event.evidence` capped at 4 by default;
  every growth list takes `limit`.
- **Enums:** internal lowercase labels map to GraphQL enums in one place
  (`LEANING`, `KINDS`, `PLATFORM`) — no scattered string casing.
- **Error surface:** validation errors return in `errors` with HTTP 200 (GraphQL
  convention); transport failures use 400/401/413/500 with `extensions.code`.
- **Offline determinism:** with no credentials the service loads artifacts and uses
  hash embeddings, so tests never touch the network (except the local HTTP test).

## Handover to U2

`Fact.stories` today returns three rules labels. U2 will replace the derivation
with extracted labels **without changing the field shape** — `label`, `videos`,
leaning counts and `videosList` stay identical, so the UI is safe.
