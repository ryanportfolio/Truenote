#!/bin/sh
# Restore one off-site backup run into the Postgres server of this container.
# Runs inside the database service of a restore-test project built from
# Dockerfile.backup (runbook section 4.7), never inside production.
#
#   sh /opt/truenote-backup/restore-offsite.sh <run id>
#
# Reads manifests/<run id>.json and the object it names from the off-site
# store with a read-only key, checks size and SHA-256 against the manifest,
# decrypts with the passphrase-protected age identity at IDENTITY_FILE (age
# asks for the passphrase on the terminal), checks every part against the
# inner manifest, restores the dump into POSTGRES_DB, and, when TEST_S3_* is
# set, copies the files into the restore-test bucket. Prints the backup's
# count record next to the restored counts.
#
# Variables:
#   OFFSITE_S3_ENDPOINT, OFFSITE_S3_REGION, OFFSITE_S3_BUCKET,
#   OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY   read-only key
#   IDENTITY_FILE    default /tmp/truenote-identity.age; deleted on exit
#   POSTGRES_DB      default postgres
#   TEST_S3_ENDPOINT, TEST_S3_REGION, TEST_S3_BUCKET,
#   TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY        optional, restore-test bucket
set -eu
umask 077

run_id="${1:-}"
case "$run_id" in
  [0-9]*T[0-9]*Z) ;;
  *) echo "usage: restore-offsite.sh <run id, e.g. 20261018T061700Z>" >&2; exit 64 ;;
esac
for name in OFFSITE_S3_ENDPOINT OFFSITE_S3_REGION OFFSITE_S3_BUCKET OFFSITE_S3_ACCESS_KEY_ID OFFSITE_S3_SECRET_ACCESS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "[restore] missing variable $name" >&2
    exit 64
  fi
done
identity="${IDENTITY_FILE:-/tmp/truenote-identity.age}"
db="${POSTGRES_DB:-postgres}"
if [ ! -s "$identity" ]; then
  echo "[restore] no identity at $identity; paste the passphrase-protected identity there first" >&2
  exit 64
fi

work=$(mktemp -d)
trap 'rm -rf "$work"; rm -f "$identity"' EXIT
trap 'exit 143' TERM INT

export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
  RCLONE_CONFIG_OFFSITE_ENDPOINT="$OFFSITE_S3_ENDPOINT" RCLONE_CONFIG_OFFSITE_REGION="$OFFSITE_S3_REGION" \
  RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$OFFSITE_S3_ACCESS_KEY_ID" RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$OFFSITE_S3_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true

echo "[restore] start $(date -u +%Y-%m-%dT%H:%M:%SZ), run $run_id"

# 1. Manifest and object.
rclone copyto "offsite:$OFFSITE_S3_BUCKET/manifests/$run_id.json" "$work/manifest.json" --quiet
want_sha=$(sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$work/manifest.json")
want_size=$(sed -n 's/.*"size":\([0-9]*\).*/\1/p' "$work/manifest.json")
keys=$(sed -n 's/.*"objects":\[\([^]]*\)\].*/\1/p' "$work/manifest.json" | tr -d '"' | tr ',' ' ')
if [ -z "$want_sha" ] || [ -z "$want_size" ] || [ -z "$keys" ]; then
  echo "[restore] manifest unreadable" >&2
  exit 65
fi
# A monthly run lists its weekly and monthly copies; the weekly one expires
# first, so take the first listed copy that still exists.
key=""
for candidate in $keys; do
  if rclone copyto "offsite:$OFFSITE_S3_BUCKET/$candidate" "$work/backup.tar.age" --quiet 2>/dev/null; then
    key="$candidate"
    break
  fi
done
if [ -z "$key" ]; then
  echo "[restore] no listed copy could be downloaded: $keys" >&2
  exit 65
fi
got_size=$(wc -c < "$work/backup.tar.age" | tr -d ' ')
got_sha=$(sha256sum "$work/backup.tar.age" | cut -d' ' -f1)
if [ "$got_size" != "$want_size" ] || [ "$got_sha" != "$want_sha" ]; then
  echo "[restore] object does not match its manifest (size $got_size/$want_size)" >&2
  exit 65
fi
echo "[restore] object $key matches manifest: $got_size bytes, sha256 $got_sha"

# 2. Decrypt and check every part.
age -d -i "$identity" -o "$work/backup.tar" "$work/backup.tar.age"
rm -f "$identity" "$work/backup.tar.age"
mkdir "$work/parts"
tar -xf "$work/backup.tar" -C "$work/parts"
rm -f "$work/backup.tar"
cd "$work/parts"
sha256sum --quiet -c parts.sha256
echo "[restore] decrypted; all parts match the inner manifest"

# 3. Restore the database. Roles belong to the server, so truenote_app is
#    created without a login before the restore; the dump's grants need it.
psql -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -q -c "
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_app') THEN CREATE ROLE truenote_app NOLOGIN; END IF;
END \$\$;"
pg_restore -U postgres -d "$db" --no-owner --single-transaction --exit-on-error db.dump
psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -q \
  -c "REVOKE TEMPORARY ON DATABASE \"$db\" FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE \"$db\" TO truenote_app"
echo "[restore] database restored $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 4. Files.
file_count=$(find files -type f | wc -l | tr -d ' ')
if [ -n "${TEST_S3_BUCKET:-}" ]; then
  export RCLONE_CONFIG_TEST_TYPE=s3 RCLONE_CONFIG_TEST_PROVIDER=Other \
    RCLONE_CONFIG_TEST_ENDPOINT="$TEST_S3_ENDPOINT" RCLONE_CONFIG_TEST_REGION="$TEST_S3_REGION" \
    RCLONE_CONFIG_TEST_ACCESS_KEY_ID="$TEST_S3_ACCESS_KEY_ID" RCLONE_CONFIG_TEST_SECRET_ACCESS_KEY="$TEST_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_TEST_FORCE_PATH_STYLE=false
  rclone copy files "test:$TEST_S3_BUCKET" --quiet
  rclone check files "test:$TEST_S3_BUCKET" --one-way --quiet
  echo "[restore] $file_count files copied to $TEST_S3_BUCKET and checked"
else
  echo "[restore] $file_count files in the backup; TEST_S3_BUCKET unset, not copied"
fi
if [ -s code.bundle ]; then
  # `git bundle verify` needs a repository; an empty one is enough for a
  # bundle of every ref, which has no prerequisites.
  git init --quiet --bare "$work/verify.git"
  git -C "$work/verify.git" bundle verify --quiet "$work/parts/code.bundle"
  echo "[restore] code bundle verifies"
fi

# 5. Counts: the backup's count record, then the restored database.
echo "[restore] count record from the backup:"
cat counts.txt
echo "[restore] restored counts:"
psql -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "
SELECT now() AS captured_at,
  (SELECT count(*) FROM programs) AS programs,
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM documents) AS documents,
  (SELECT count(*) FROM document_versions) AS document_versions,
  (SELECT count(*) FROM chunks) AS chunks,
  (SELECT count(*) FROM query_log) AS query_log,
  (SELECT count(*) FROM security_events) AS security_events,
  (SELECT max(sequence) FROM security_events) AS last_event_sequence;"
echo "[restore] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
