#!/usr/bin/env bash
# Verify the migrations and the load path against a throwaway Postgres.
#
#   ./scripts/verify-schema.sh
#
# Creates a local container, applies 0001→0003, loads the JSON snapshot the
# same way the ETL does (jsonb_populate_record), then runs the read models.
# It never touches the real Supabase database.
set -euo pipefail

CONTAINER="${CONTAINER:-cadrage-verify-pg}"
PORT="${PORT:-55432}"
PASSWORD="verify"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Starting Postgres on :${PORT}"
cleanup
docker run -d --name "${CONTAINER}" -e POSTGRES_PASSWORD="${PASSWORD}" -p "${PORT}:5432" postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

PSQL=(docker exec -i -e PGPASSWORD="${PASSWORD}" "${CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 -q)

echo "==> Supabase roles"
"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin;" >/dev/null

echo "==> Migrations"
for file in supabase/migrations/0001_init.sql supabase/migrations/0002_seed.sql supabase/migrations/0003_creator_stance.sql; do
  echo "    ${file}"
  "${PSQL[@]}" < "${file}" >/dev/null
done

echo "==> Generating COPY payloads"
python3 - <<'PY'
import csv, json, os
os.makedirs("data/verify", exist_ok=True)
snap = json.load(open("data/oriane/top10-all.json"))
stance = json.load(open("data/analyses/creator-stance.json"))

def write_csv(path, rows):
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow([json.dumps(row, ensure_ascii=False)])

write_csv("data/verify/videos.csv", [
    {k: v for k, v in video.items() if k != "raw"} for video in snap["videos"]
])
write_csv("data/verify/mentions.csv", [
    {k: v for k, v in mention.items() if k != "id"} for mention in snap["mentions"]
])
write_csv("data/verify/creator_stance.csv", stance["rows"])
write_csv("data/verify/video_stance.csv", stance["perVideo"])
print("    wrote data/verify/*.csv")
PY

echo "==> Loading"
python3 - <<'PYGEN' > /tmp/verify-load.sql
import csv, json

def rows(path):
    with open(path) as handle:
        for row in csv.reader(handle):
            yield json.loads(row[0])

def q(sql, payload):
    return sql.format(json.dumps(payload, ensure_ascii=False))

print("begin;")
for row in rows("data/verify/videos.csv"):
    row.pop("raw", None)
    print(q("insert into public.videos select (jsonb_populate_record(null::public.videos, $json${}$json$::jsonb)).* on conflict (id) do nothing;", row))
for row in rows("data/verify/mentions.csv"):
    row.pop("id", None); row.pop("created_at", None)
    print(q("insert into public.mentions (video_id, candidate_id, matched_terms, source_field, source_key, strength, occurrences) "
            "select video_id, candidate_id, matched_terms, source_field, source_key, strength, occurrences "
            "from jsonb_populate_record(null::public.mentions, $json${}$json$::jsonb) on conflict do nothing;", row))
for row in rows("data/verify/creator_stance.csv"):
    row.pop("computed_at", None)
    print(q("insert into public.creator_stance (creator_handle, candidate_id, creator_display_name, creator_followers, videos, "
            "favorable, critical, neutral, unclear, stance_index, view_weighted_index, avg_score, label, total_views, evidence) "
            "select creator_handle, candidate_id, creator_display_name, creator_followers, videos, favorable, critical, neutral, "
            "unclear, stance_index, view_weighted_index, avg_score, label, total_views, evidence "
            "from jsonb_populate_record(null::public.creator_stance, $json${}$json$::jsonb) "
            "on conflict (creator_handle, candidate_id) do nothing;", row))
for row in rows("data/verify/video_stance.csv"):
    print(q("insert into public.video_stance (video_id, candidate_id, score, label, basis, markers, quote) "
            "select video_id, candidate_id, score, label, basis, markers, quote "
            "from jsonb_populate_record(null::public.video_stance, $json${}$json$::jsonb) on conflict do nothing;", row))
print("commit;")
PYGEN
"${PSQL[@]}" < /tmp/verify-load.sql >/dev/null

echo "==> Read models"
"${PSQL[@]}" -c "select count(*) as videos from public.videos;"
"${PSQL[@]}" -c "select count(*) as mentions from public.mentions;"
"${PSQL[@]}" -c "select count(*) as stance_rows from public.creator_candidate_stance;"
"${PSQL[@]}" -c "select c.name, o.video_count, o.favorable_count, o.critical_count
                 from public.candidate_overview o
                 join public.candidates c on c.id = o.id
                 order by o.video_count desc limit 5;"
"${PSQL[@]}" -c "select creator_handle, candidate_name, videos, favorable, critical, stance_index, label
                 from public.creator_candidate_stance order by videos desc limit 5;"

echo
echo "Schema, seed, load and read models verified on Postgres 16."
