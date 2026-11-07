# AI-DLC record — Factpicker

This folder is the audited lifecycle record, following AI-DLC's
**Inception → Construction → Operations** shape (awslabs/aidlc-workflows). Each
phase has an explicit gate: nothing in Construction starts before the Inception
artifacts are agreed, and nothing is deployed before the Construction test plan
is green.

| Phase | Artifact | Gate |
|---|---|---|
| Inception | `inception/requirements.md` | requirements traceable + non-goals stated |
| Inception | `inception/user-stories.md` | every page in the PDF has acceptance criteria |
| Inception | `inception/design.md` | data sources and contracts fixed |
| Inception | `inception/units.md` | work split into units, each independently shippable |
| Construction | `construction/unit-01-api-v0.1/{design,test-plan}.md` | tests green |
| Operations | `operations/deployment.md` | rollback and SLOs defined |

Traceability: every requirement ID maps to a test or an artifact in
`construction/unit-01-api-v0.1/test-plan.md`.

## Current state (2026-11-07)

- U1 **API v0.1** — implemented, 11 API tests passing, contract frozen.
- U2 Fact/story extraction (LLM) — designed, not started.
- U3 UI pages — not started (PDF is the spec).
- U4 Deployment — container + runbook ready, not deployed.
