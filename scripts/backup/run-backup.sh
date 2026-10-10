#!/bin/sh
# Off-site backup run for the `backup` cron service (Dockerfile.backup).
# docs/security/backup-restore-runbook.md, section 1 and path C.
#
# One run writes one encrypted object to the off-site store:
#   <prefix>/<run id>.tar.age   tar of the database dump, its count record,
#                               every object from the Railway bucket, a
#                               bundle of the code repository and an inner
#                               manifest with the SHA-256 of each part,
#                               encrypted with `age` to BACKUP_AGE_RECIPIENT
#   manifests/<run id>.json     size and SHA-256 of that object, plain
# The manifest is written last, only after every step and the upload have
# succeeded. A run that fails leaves an object without a manifest, and a
# restore uses only objects that have one: a cut-off pg_dump still decrypts
# and lists its contents, so the manifest is the only safe marker.
#
# The job holds only the age public key, so it cannot decrypt what it wrote,
# and an off-site key that can write and list but not read or delete.
# Plain parts exist only in this container's ephemeral disk during the run
# and are removed on exit.
#
# Variables (Railway service variables on `backup`):
#   BACKUP_DATABASE_URL       truenote_backup connection string (0014_backup_role.sql)
#   BACKUP_AGE_RECIPIENT      age public key (age1...)
#   OFFSITE_S3_ENDPOINT, OFFSITE_S3_REGION, OFFSITE_S3_BUCKET,
#   OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY   off-site store, write-only key
#   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
#                             the Railway bucket truenote-storage (read)
#   BACKUP_GIT_URL            repository to bundle (public HTTPS URL)
#   BACKUP_PREFIX             optional; default weekly
set -eu
umask 077

for name in BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_GIT_URL \
  OFFSITE_S3_ENDPOINT OFFSITE_S3_REGION OFFSITE_S3_BUCKET OFFSITE_S3_ACCESS_KEY_ID OFFSITE_S3_SECRET_ACCESS_KEY \
  S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "[backup] missing variable $name" >&2
    exit 64
  fi
done
case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  *) echo "[backup] BACKUP_AGE_RECIPIENT is not an age public key" >&2; exit 64 ;;
esac

prefix="${BACKUP_PREFIX:-weekly}"
run_id=$(date -u +%Y%m%dT%H%M%SZ)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
work=$(mktemp -d)

finish() {
  rc=$?
  rm -rf "$work"
  if [ "$rc" -ne 0 ]; then
    echo "[backup] run $run_id failed (exit $rc)" >&2
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 143' TERM INT

# rclone remotes from the environment; nothing is written to a config file.
export RCLONE_CONFIG_SOURCE_TYPE=s3 RCLONE_CONFIG_SOURCE_PROVIDER=Other \
  RCLONE_CONFIG_SOURCE_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_SOURCE_REGION="$S3_REGION" \
  RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_SOURCE_FORCE_PATH_STYLE=false
# The off-site key cannot read, so rclone must not check the bucket or HEAD
# the object after uploading it.
export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
  RCLONE_CONFIG_OFFSITE_ENDPOINT="$OFFSITE_S3_ENDPOINT" RCLONE_CONFIG_OFFSITE_REGION="$OFFSITE_S3_REGION" \
  RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$OFFSITE_S3_ACCESS_KEY_ID" RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$OFFSITE_S3_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true RCLONE_CONFIG_OFFSITE_NO_HEAD=true

mkdir "$work/parts"
cd "$work/parts"

# 1. Count record, immediately before the dump (runbook, section 4.1, step 3).
psql "$BACKUP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -o counts.txt -c "
SELECT now() AS captured_at,
  (SELECT count(*) FROM programs) AS programs,
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM documents) AS documents,
  (SELECT count(*) FROM document_versions) AS document_versions,
  (SELECT count(*) FROM chunks) AS chunks,
  (SELECT count(*) FROM query_log) AS query_log,
  (SELECT count(*) FROM security_events) AS security_events,
  (SELECT max(sequence) FROM security_events) AS last_event_sequence;"

# 2. Database dump, same flags as the runbook's operator dump (section 4.1, step 5).
pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --exclude-schema=_system \
  --exclude-table-data-and-children=pgboss.job --exclude-table-data=pgboss.archive \
  --exclude-table-data=public.sessions --exclude-table-data=public.password_reset_tokens \
  --file=db.dump
pg_restore --list db.dump > "$work/toc.txt"
if ! grep -q 'TABLE DATA public users ' "$work/toc.txt"; then
  echo "[backup] dump has no data for public.users" >&2
  exit 65
fi

# 3. Every object in the Railway bucket, after the dump, so each file the
#    dump references is already in the bucket.
rclone copy "source:$S3_BUCKET" files --retries 3 --quiet
mkdir -p files

#    Count the files the dump references that the copy lacks: a document purged
#    between the dump and the copy, or a file that was already missing. The
#    count goes into the manifest; scripts/backup/check-offsite.mjs flags a rise.
pg_restore --data-only --table=document_versions -f "$work/document_versions.sql" db.dump
awk '
  /^COPY public\.document_versions \(/ {
    h = $0; sub(/^[^(]*\(/, "", h); sub(/\) FROM stdin;$/, "", h)
    n = split(h, cols, ", "); for (i = 1; i <= n; i++) if (cols[i] == "source_url") k = i
    if (!k) exit 2
    rows = 1; next
  }
  rows && $0 == "\\." { rows = 0; next }
  rows { split($0, f, "\t"); if (f[k] != "\\N") print f[k] }
' "$work/document_versions.sql" | sort -u > "$work/referenced.txt"
if ! grep -q '^COPY public\.document_versions (.*source_url' "$work/document_versions.sql"; then
  echo "[backup] dump has no document_versions.source_url column" >&2
  exit 65
fi
referenced=$(wc -l < "$work/referenced.txt" | tr -d ' ')
missing=0
while IFS= read -r key; do
  [ -f "files/$key" ] || missing=$((missing + 1))
done < "$work/referenced.txt"
rm -f "$work/document_versions.sql" "$work/referenced.txt"

# 4. Code repository bundle. `git bundle verify` needs a repository.
git clone --quiet --mirror "$BACKUP_GIT_URL" "$work/repo.git"
git -C "$work/repo.git" bundle create "$work/parts/code.bundle" --all 2>/dev/null
git -C "$work/repo.git" bundle verify --quiet "$work/parts/code.bundle"
rm -rf "$work/repo.git"

# 5. Inner manifest: SHA-256 of every part.
find . -type f ! -name parts.sha256 -exec sha256sum {} + > "$work/parts.sha256"
mv "$work/parts.sha256" parts.sha256
file_count=$(find files -type f | wc -l | tr -d ' ')
dump_size=$(wc -c < db.dump | tr -d ' ')

# 6. Encrypt into one object. tar and age run as separate steps so a failure
#    in either stops the run (sh has no pipefail).
tar -cf "$work/backup.tar" .
cd "$work"
rm -rf parts
age -r "$BACKUP_AGE_RECIPIENT" -o backup.tar.age backup.tar
rm -f backup.tar
size=$(wc -c < backup.tar.age | tr -d ' ')
sha=$(sha256sum backup.tar.age | cut -d' ' -f1)

# 7. Upload, then the plain manifest. The first run of a month also goes to monthly/.
keys="$prefix/$run_id.tar.age"
day=$(date -u +%d)
if [ "$prefix" = weekly ] && [ "$day" -le 7 ]; then
  keys="$keys monthly/$run_id.tar.age"
fi
for key in $keys; do
  rclone copyto backup.tar.age "offsite:$OFFSITE_S3_BUCKET/$key" --no-check-dest --retries 3 --quiet
done

objects=""
for key in $keys; do
  objects="$objects${objects:+,}\"$key\""
done
printf '{"run_id":"%s","started_at":"%s","finished_at":"%s","objects":[%s],"size":%s,"sha256":"%s","dump_bytes":%s,"bucket_files":%s,"referenced_files":%s,"referenced_files_missing":%s,"code_bundle":%s,"age_recipient":"%s"}\n' \
  "$run_id" "$started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$objects" "$size" "$sha" "$dump_size" "$file_count" \
  "$referenced" "$missing" true "$BACKUP_AGE_RECIPIENT" > manifest.json
rclone copyto manifest.json "offsite:$OFFSITE_S3_BUCKET/manifests/$run_id.json" --no-check-dest --retries 3 --quiet

echo "[backup] run $run_id ok: $keys, $size bytes, sha256 $sha, $file_count bucket files, $missing of $referenced referenced files missing"
