# Cloud Run job image for the creator-stance ETL.
# Node 24 runs TypeScript natively, so there is no build step and no
# node_modules: the pipeline only uses fetch and the standard library.
FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY pipeline ./pipeline
COPY supabase/functions/_shared ./supabase/functions/_shared

ENV NODE_ENV=production
ENV OUT_PATH=/tmp/creator-stance.json

# Reads Supabase, writes Supabase + BigQuery (no --input).
CMD ["node", "pipeline/main.ts", "--write-supabase", "--write-bigquery"]
