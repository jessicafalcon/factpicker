# Inception — units of work

Each unit is independently shippable and has its own gate.

| Unit | Scope | Depends on | Status | Gate |
|---|---|---|---|---|
| **U1 API v0.1** | GraphQL read layer over artifacts/Supabase/Vertex | data artifacts (done) | **Shipped (local)** | 11 API tests green |
| **U2 Facts & stories** | LLM claim extraction: fact → interpretation → verdict with verbatim quotes | U1 schema | Designed | 40-video gold set ≥ 82% agreement |
| **U3 UI pages** | Story / Events / Facts / video detail per the PDF | U1 | Not started | pixel + a11y audit |
| **U4 Operations** | Container, secrets, health checks, dashboards | U1 | Runbook ready | deploy + rollback rehearsal |
| **U5 Ingestion refresh** | Scheduled Oriane pull (bounded) + stance refresh | U1, U4 | Existing scripts | budget cap enforced |

Critical path for the demo: **U1 → U3 → U4**. U2 is the quality upgrade and can
land after the demo if labels are explicitly marked as rules-based.
