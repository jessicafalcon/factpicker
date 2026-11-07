# Operations — deployment runbook (v0.1)

## Build

```bash
cd api && npm ci --omit=dev
docker build -t factpicker-api:0.1.0 api
```

Reference Dockerfile (not yet committed to a registry):

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY schema.graphql ./
COPY src ./src
COPY data ./data
ENV NODE_ENV=production PORT=8080
CMD ["node", "src/server.ts"]
```

## Configure

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (8080) | listen port |
| `API_TOKEN` | **yes in prod** | `x-api-key` gate |
| `CORS_ORIGIN` | yes in prod | restrict to the app origin |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | optional | live tables; mounted as secrets |
| `GCP_PROJECT`, `VERTEX_LOCATION`, `VERTEX_EMBEDDINGS=1` | optional | semantic search |

## Deploy

1. Push image to Artifact Registry.
2. Deploy to Cloud Run; set secrets from Secret Manager; allow unauthenticated
   **only** if `API_TOKEN` is enforced.
3. Readiness probe: `GET /healthz` (must report the expected `origin`).
4. Smoke test:
   ```bash
   curl -s $URL/healthz
   curl -s -X POST $URL/graphql -H "x-api-key: $TOKEN" -H 'content-type: application/json' \
     -d '{"query":"{ apiVersion }"}'
   ```

## SLOs

| Metric | Target |
|---|---|
| availability | 99.5% monthly |
| p95 latency, `story`/`eventImpact` | < 300 ms warm |
| cold start | < 2 s (snapshot parse) |
| error rate (5xx) | < 0.5% |

## Rollback

Cloud Run keeps revisions: `gcloud run services update-traffic --to-revisions=PREVIOUS=100`.
Because the contract is versioned via `apiVersion`, a client pinned to 0.1.0 can
detect a mismatch from any response.

## Cost controls

- Read-only, no model calls at request time → cost is requests + egress only.
- Embeddings are cached in `api/.cache/embeddings.json` and computed per run, not
  per request.
- Ingestion remains budget-capped in `pipeline/` (see the cost notes in
  `docs/stance-model-analysis.md`).
