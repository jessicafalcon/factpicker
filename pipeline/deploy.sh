#!/usr/bin/env bash
# Deploy the creator-stance ETL to Google Cloud.
#
#   ./pipeline/deploy.sh
#
# Creates (idempotently):
#   - a BigQuery dataset + creator_stance table
#   - a container image in gcr.io
#   - a Cloud Run job that reads Supabase and writes Supabase + BigQuery
#   - an optional Cloud Scheduler trigger (SCHEDULE=1)
#
# Nothing here calls Oriane, so it costs no scraping credits.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
DATASET="${DATASET:-cadrage2027}"
JOB="${JOB:-cadrage2027-stance}"
IMAGE="gcr.io/${PROJECT}/${JOB}"
SCHEDULE="${SCHEDULE:-0}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-2.5-flash}"
MAX_VERTEX_CALLS="${MAX_VERTEX_CALLS:-25}"

if [[ -z "${PROJECT}" ]]; then
  echo "No project. Set PROJECT=<gcp-project-id>." >&2
  exit 1
fi

echo "Project:  ${PROJECT}"
echo "Region:   ${REGION}"
echo "Dataset:  ${DATASET}"
echo "Job:      ${JOB}"
echo "Vertex:   ${VERTEX_MODEL} (max ${MAX_VERTEX_CALLS} calls per run)"
echo

echo "==> APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  bigquery.googleapis.com aiplatform.googleapis.com cloudscheduler.googleapis.com \
  --project "${PROJECT}" >/dev/null

echo "==> BigQuery dataset + table"
bq --location=EU mk --dataset "${PROJECT}:${DATASET}" 2>/dev/null || echo "   dataset exists"
bq mk --table "${PROJECT}:${DATASET}.creator_stance" pipeline/schema/creator_stance.json 2>/dev/null \
  || echo "   table exists"

echo "==> Build image"
gcloud builds submit --project "${PROJECT}" --tag "${IMAGE}" . 

echo "==> Cloud Run job"
if gcloud run jobs describe "${JOB}" --project "${PROJECT}" --region "${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB}" \
    --project "${PROJECT}" --region "${REGION}" \
    --image "${IMAGE}" --command node --args pipeline/main.ts,--write-supabase,--write-bigquery \
    --set-env-vars "GCP_PROJECT=${PROJECT},BQ_DATASET=${DATASET},VERTEX_LOCATION=us-central1,VERTEX_MODEL=${VERTEX_MODEL},MAX_VERTEX_CALLS=${MAX_VERTEX_CALLS}" \
    --set-secrets "SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest"
else
  gcloud run jobs create "${JOB}" \
    --project "${PROJECT}" --region "${REGION}" \
    --image "${IMAGE}" --command node --args pipeline/main.ts,--write-supabase,--write-bigquery \
    --set-env-vars "GCP_PROJECT=${PROJECT},BQ_DATASET=${DATASET},VERTEX_LOCATION=us-central1,VERTEX_MODEL=${VERTEX_MODEL},MAX_VERTEX_CALLS=${MAX_VERTEX_CALLS}" \
    --set-secrets "SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest"
fi

if [[ "${SCHEDULE}" == "1" ]]; then
  echo "==> Cloud Scheduler (daily 06:00 Europe/Paris)"
  gcloud scheduler jobs create http "${JOB}-daily" \
    --project "${PROJECT}" --location "${REGION}" \
    --schedule "0 6 * * *" --time-zone "Europe/Paris" \
    --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run" \
    --http-method POST \
    --oauth-service-account-email "$(gcloud config get-value account)" 2>/dev/null \
    || echo "   scheduler job exists or needs a service account with run.jobs.run"
fi

echo
echo "Run it now:"
echo "  gcloud run jobs execute ${JOB} --project ${PROJECT} --region ${REGION} --wait"
echo
echo "Secrets expected in Secret Manager (create before the first run):"
echo "  supabase-url                 -> your Supabase project URL"
echo "  supabase-service-role-key    -> service role key (server-side only)"
