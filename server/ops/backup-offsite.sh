#!/bin/bash
# Nightly off-site copy of the sync database. Runs after the on-box backup (/var/backups/sundial, 30 days)
# and sends the newest file that backup made. It never opens the live database: a root sqlite3 on the live
# file could leave root-owned -wal/-shm files beside it, and the server could not open it after that.
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
#   # then run it once by hand; the last line must say "ok": /usr/local/bin/sundial-backup-offsite
#
# An off-site file has the on-box file's name plus .enc, so the two are easy to match.
#
# Restore, as root. <file> is the off-site name without .enc; set -a exports the settings, so rclone sees them:
#   set -a; . /etc/sundial/offsite.env; set +a
#   rclone copy "offsite:$OFFSITE_BUCKET/<file>.enc" .
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/etc/sundial/backup.key -in <file>.enc -out <file>
#   gunzip <file>      # only when <file> ends in .gz; either way there is a .sqlite file now
# -iter must be the number used to encrypt below. Without it openssl uses its default and says "bad decrypt".
# After restoring, bump the epoch so every client resyncs: sqlite3 <the .sqlite file> "UPDATE meta SET value=value+1 WHERE key='epoch'"
set -euo pipefail
# Exported (set -a): rclone finds its remote in the RCLONE_CONFIG_OFFSITE_* variables of its environment.
set -a
. /etc/sundial/offsite.env
set +a
DIR=/var/backups/sundial
KEY=/etc/sundial/backup.key
MAX_AGE_HOURS=36
log() { echo "$(date -u +%FT%TZ) off-site backup $*"; }
# Loud on purpose: an ERROR line in the log and a failed exit, never a quiet skip.
fail() { log "ERROR: $*" >&2; exit 1; }

# The newest copy the on-box backup finished. Any *.sqlite or *.sqlite.gz counts, because the script that
# makes them has changed its file names before (its unfinished files end in .tmp or .tmp.gz and do not
# match). A file changed in the last minute may still be being written, so it is left for the next night.
SRC=$(find "$DIR" -maxdepth 1 -type f \( -name '*.sqlite' -o -name '*.sqlite.gz' \) -mmin +1 -printf '%T@ %p\n' \
	| sort -n | tail -n 1 | cut -d' ' -f2-)
[ -n "$SRC" ] || fail "no finished *.sqlite or *.sqlite.gz in $DIR; nothing sent. Is the nightly backup running?"
AGE=$(( $(date +%s) - $(stat -c %Y "$SRC") ))
# One late or skipped night is tolerated (the copy from the night before goes out again). Two are not.
if [ "$AGE" -gt $((MAX_AGE_HOURS * 3600)) ]; then
	fail "the newest copy, $(basename "$SRC"), is $((AGE / 3600)) hours old (limit $MAX_AGE_HOURS); nothing sent. The nightly backup has stopped"
fi
# The file is taken by its name alone, so look at it before it becomes the off-site copy.
case "$SRC" in
	*.gz) gzip -t "$SRC" 2>/dev/null || fail "$(basename "$SRC") is not a whole gzip file; nothing sent" ;;
	*) [ "$(head -c 15 "$SRC")" = "SQLite format 3" ] || fail "$(basename "$SRC") is not an SQLite database; nothing sent" ;;
esac

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
NAME="$(basename "$SRC").enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -in "$SRC" -out "$WORK/$NAME"
rclone copyto "$WORK/$NAME" "offsite:$OFFSITE_BUCKET/$NAME" --s3-no-check-bucket
# keep 30 days off-site (reached only after a good upload, so old copies stay while new ones fail)
rclone delete "offsite:$OFFSITE_BUCKET" --min-age 30d --include '*.sqlite.enc' --include '*.sqlite.gz.enc' || true
log "ok: $NAME ($(stat -c %s "$WORK/$NAME") bytes), from the on-box copy made $((AGE / 3600)) h ago"
