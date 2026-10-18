#!/bin/bash
# Nightly off-site copy of the sync database. Runs after the on-box backup (/var/backups/sundial, 30 days).
# The copy is encrypted here first, so the bucket provider only ever holds ciphertext of ciphertext.
#
# One-time setup on the box (as root):
#   apt-get install -y rclone
#   install -d -m 700 /etc/sundial
#   head -c 48 /dev/urandom | base64 > /etc/sundial/backup.key && chmod 600 /etc/sundial/backup.key
#   # keep a copy of /etc/sundial/backup.key somewhere safe OFF the box: without it the off-site copies are unreadable
#   # Bucket: Exoscale Simple Object Storage (SOS) in zone ch-dk-2, a second Swiss site; the VPS itself is in ch-gva-2.
#   # Not a non-Swiss bucket: the file holds email addresses under the encryption, and the privacy page says Switzerland.
#   # The key pair is an Exoscale IAM key limited to SOS on this one bucket. Ubuntu 24.04 ships rclone 1.60, which has
#   # no "Exoscale" provider name, hence PROVIDER=Other.
#   cat > /etc/sundial/offsite.env <<EOF
#   RCLONE_CONFIG_OFFSITE_TYPE=s3
#   RCLONE_CONFIG_OFFSITE_PROVIDER=Other
#   RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=...
#   RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=...
#   RCLONE_CONFIG_OFFSITE_ENDPOINT=https://sos-ch-dk-2.exo.io
#   RCLONE_CONFIG_OFFSITE_REGION=ch-dk-2
#   OFFSITE_BUCKET=sundial-backups
#   EOF
#   chmod 600 /etc/sundial/offsite.env
#   install -m 755 backup-offsite.sh /usr/local/bin/sundial-backup-offsite
#   echo '45 3 * * * root /usr/local/bin/sundial-backup-offsite >> /var/log/sundial-backup.log 2>&1' > /etc/cron.d/sundial-offsite
#
# Restore: rclone copy offsite:$OFFSITE_BUCKET/<file>.enc . && openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/etc/sundial/backup.key -in <file>.enc -out sundial-sync.sqlite
# After restoring, bump the epoch so every client resyncs: sqlite3 sundial-sync.sqlite "UPDATE meta SET value=value+1 WHERE key='epoch'"
set -euo pipefail
. /etc/sundial/offsite.env
SRC=/var/lib/sundial/sundial-sync.sqlite
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
STAMP=$(date -u +%Y%m%dT%H%MZ)
# a consistent snapshot even while the server writes
sqlite3 "$SRC" ".backup '$WORK/sundial-sync.sqlite'"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:/etc/sundial/backup.key -in "$WORK/sundial-sync.sqlite" -out "$WORK/sundial-sync-$STAMP.sqlite.enc"
rclone copyto "$WORK/sundial-sync-$STAMP.sqlite.enc" "offsite:$OFFSITE_BUCKET/sundial-sync-$STAMP.sqlite.enc" --s3-no-check-bucket
# keep 30 days off-site
rclone delete "offsite:$OFFSITE_BUCKET" --min-age 30d --include 'sundial-sync-*.sqlite.enc' || true
echo "$(date -u +%FT%TZ) off-site backup ok: sundial-sync-$STAMP.sqlite.enc ($(stat -c %s "$WORK/sundial-sync-$STAMP.sqlite.enc") bytes)"
