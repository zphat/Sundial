#!/bin/bash
# provision.sh: turns a fresh Exoscale Micro (512 MB RAM, 1 vCPU, 10 GB disk, Ubuntu 24.04) into the
# Sundial box: sundial-sync behind Caddy for sync.sundial.services, the web app (app.sundial.services)
# and the landing page (sundial.services). MIGRATE.md next to this file is the runbook; this is its step 4.
#
# Run as root from a copy of the repo's server/ops folder. The old copy goes first: scp -r into an
# existing /root/ops would land in /root/ops/ops, and a rerun would use the old, unfixed files.
#   ssh root@NEW 'rm -rf /root/ops' && scp -r server/ops root@NEW:/root/
#   ssh root@NEW 'bash /root/ops/provision.sh'
#
# Safe to run again. Every step checks what is already in place and only changes what differs. A rerun
# does fetch the newest sync binary and web bundle again, and installs them if they are newer.
# It never creates or prints a secret: /etc/sundial/sync.env and the database are copied from the old
# box (MIGRATE.md step 5). Until both are here, sundial-sync is installed and enabled but not started.
set -euo pipefail

OPS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WEB="$OPS/web"
REPO="zphat/Sundial"
SYNC_ASSET="sundial-sync-linux-x86_64.tar.gz"
SYNC_MEMBER="sundial-sync-linux-x86_64"
SYNC_BIN=/opt/sundial/bin/sundial-sync
SYNC_STAGE=/opt/sundial/bin/.sundial-sync.new
SYNC_ENV=/etc/sundial/sync.env
SYNC_DB=/var/lib/sundial/sundial-sync.sqlite
SYNC_UNIT=/etc/systemd/system/sundial-sync.service
UA="sundial-provision (+https://sundial.services)"
HOSTS=(sundial.services app.sundial.services sync.sundial.services)

# apt never asks anything: no debconf questions, changed config files are kept, and needrestart only
# lists what it would restart. The lock timeout waits for the first-boot apt jobs (unattended-upgrades
# starts soon after the first boot) instead of failing on "Could not get lock".
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
APT=(apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

STEP="start"
TODO=()
CHANGED=0
WORK=$(mktemp -d)
cleanup() {
	local rc=$?
	rm -rf "$WORK"
	rm -f "$SYNC_STAGE"
	if [ "$rc" -ne 0 ]; then
		echo >&2
		echo "provision.sh stopped in step '$STEP' (exit $rc). Fix the cause and run it again; finished steps only re-check." >&2
		echo "If the fix was to a file on the PC, run MIGRATE.md step 4 again: it copies the folder fresh." >&2
	fi
}
trap cleanup EXIT

step() { STEP=$1; printf '\n==> %s\n' "$1"; }
say() { printf '    %s\n' "$*"; }
warn() { printf '    WARN: %s\n' "$*"; TODO+=("$*"); }
die() { printf 'provision.sh: %s\n' "$*" >&2; exit 1; }

# put MODE PATH: write stdin to PATH (root-owned) only when the content differs. CHANGED=1 when it wrote.
put() {
	local mode=$1 path=$2 tmp="$WORK/put"
	cat >"$tmp"
	if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
		CHANGED=0
	else
		install -D -m "$mode" -o root -g root "$tmp" "$path"
		CHANGED=1
	fi
	chmod "$mode" "$path"
}
# copy MODE SRC DEST: the same for a file from this folder.
copy() { put "$1" "$3" <"$2"; }
# dir MODE OWNER DIR...: create directories, or correct the owner and mode of existing ones.
dir() {
	local mode=$1 owner=$2
	shift 2
	install -d "$@"
	chown "$owner" "$@"
	chmod "$mode" "$@"
}

# ---------------------------------------------------------------------------------------------------
step "0/10 Checks"
[ "$(id -u)" -eq 0 ] || die "run this as root (sudo bash $0)"
OS_ID=$(. /etc/os-release && echo "${ID:-}")
OS_VER=$(. /etc/os-release && echo "${VERSION_ID:-}")
[ "$OS_ID" = ubuntu ] || die "this script is for Ubuntu 24.04; this box runs '$OS_ID $OS_VER'"
if [ "$OS_VER" != 24.04 ]; then
	warn "written for Ubuntu 24.04, this box runs $OS_VER; check the result carefully"
fi
[ "$(uname -m)" = x86_64 ] || die "the sundial-sync release binary is x86_64 only; this box is $(uname -m)"
for f in web/Caddyfile web/sundial-web-update web/sundial-web-update.service web/sundial-web-update.timer web/root/index.html; do
	[ -f "$OPS/$f" ] || die "missing $OPS/$f; copy the whole server/ops folder again (MIGRATE.md step 4: ssh root@HOST 'rm -rf /root/ops' && scp -r server/ops root@HOST:/root/)"
	# The folder comes from a Windows PC. The repo checks out LF (.gitattributes), but an editor can add
	# CRLF, and a script with CRLF fails on the box in odd ways.
	if grep -q $'\r' "$OPS/$f"; then
		die "$OPS/$f has Windows line endings (CRLF); convert it to LF on the PC and run MIGRATE.md step 4 again"
	fi
done
# Every host in the Caddyfile needs DNS pointing here, or Caddy retries its certificate forever. The old
# box's sslip.io name is tied to the old IP. The repo copy no longer has it; an older copy might.
if grep -Eq '^[^#]*sslip\.io' "$WEB/Caddyfile"; then
	die "$WEB/Caddyfile names an sslip.io host, which is tied to one IP; remove it from the sync site block on the PC and run MIGRATE.md step 4 again"
fi
say "Ubuntu $OS_VER on $(uname -m), files from $OPS"
if command -v cloud-init >/dev/null 2>&1; then
	say "waiting for cloud-init to finish the first boot"
	cloud-init status --wait >/dev/null 2>&1 || warn "cloud-init reports a problem (cloud-init status --long); continuing"
fi

# ---------------------------------------------------------------------------------------------------
step "1/10 Memory: 1 GiB swap, swappiness 10, journal capped, idle services off"
SWAP=/swapfile
# make_swap [dd]: a fresh 1 GiB swap file. fallocate is instant; dd is the fallback for a filesystem
# where swapon refuses a fallocated file ("swapfile has holes").
make_swap() {
	rm -f "$SWAP"
	if [ "${1:-}" = dd ] || ! fallocate -l 1G "$SWAP" 2>/dev/null; then
		dd if=/dev/zero of="$SWAP" bs=1M count=1024 status=none
	fi
	chmod 600 "$SWAP"
	mkswap "$SWAP" >/dev/null
}
if grep -qx "$SWAP" <<<"$(swapon --show=NAME --noheadings)"; then
	say "swap: $SWAP is already on"
else
	# A new file, unless one of exactly 1 GiB is left from a run that stopped right after creating it.
	if [ ! -f "$SWAP" ] || [ "$(stat -c %s "$SWAP")" -ne 1073741824 ]; then
		make_swap
	else
		chmod 600 "$SWAP"
		mkswap "$SWAP" >/dev/null
	fi
	if ! swapon "$SWAP" 2>/dev/null; then
		make_swap dd
		swapon "$SWAP"
	fi
	say "swap: $SWAP created and on"
fi
if ! grep -Eq "^$SWAP[[:space:]]" /etc/fstab; then
	echo "$SWAP none swap sw 0 0" >>/etc/fstab
	say "swap: added to /etc/fstab, so it survives a reboot"
fi

# The swap is there for spikes (apt, a burst of big syncs). Low swappiness keeps the services in RAM.
put 644 /etc/sysctl.d/90-sundial.conf <<'EOF'
# Written by server/ops/provision.sh (Sundial). 512 MB box: swap is for spikes, keep the services in RAM.
vm.swappiness = 10
EOF
sysctl -q -p /etc/sysctl.d/90-sundial.conf
say "vm.swappiness = $(sysctl -n vm.swappiness)"

# Uncapped, the journal may take 10% of the filesystem, about 1 GB of the 10 GB disk.
put 644 /etc/systemd/journald.conf.d/90-sundial.conf <<'EOF'
# Written by server/ops/provision.sh (Sundial): keep the journal small on the 10 GB disk.
[Journal]
SystemMaxUse=100M
EOF
if [ "$CHANGED" = 1 ]; then
	systemctl restart systemd-journald
	journalctl --vacuum-size=100M >/dev/null 2>&1 || true
	say "journal: capped at 100M"
else
	say "journal: cap already in place"
fi

# These cost memory (multipathd even locks its pages in RAM) and do nothing on a one-disk cloud VM: no
# snaps are used, there is no modem, no multipath storage, no removable disk, no desktop software centre.
# They are masked, not removed: "systemctl unmask <unit>" brings one back. cloud-init, ssh and
# systemd-resolved are not touched: the box needs them to boot, get its network and be reached.
for unit in snapd.socket snapd.service snapd.seeded.service snapd.snap-repair.timer snapd.autoimport.service \
	ModemManager.service multipathd.socket multipathd.service udisks2.service packagekit.service; do
	state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
	if [ "$state" = masked ]; then
		say "$unit: off already"
	elif [ -z "$state" ] || [ "$state" = not-found ]; then
		say "$unit: not installed"
	else
		systemctl disable --now "$unit" >/dev/null 2>&1 || true
		if systemctl mask "$unit" >/dev/null 2>&1; then
			say "$unit: stopped and masked"
		else
			warn "could not mask $unit (systemctl status $unit)"
		fi
	fi
done

# ---------------------------------------------------------------------------------------------------
step "2/10 Packages"
"${APT[@]}" update
"${APT[@]}" install sqlite3 curl ca-certificates gnupg python3 cron \
	debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades
say "sqlite3 $(sqlite3 --version | cut -d' ' -f1), $(python3 --version)"

# ---------------------------------------------------------------------------------------------------
step "3/10 Caddy from the official repository"
# As caddyserver.com/docs/install documents it for Debian and Ubuntu. The key and the list are written
# to temporary files first, so a run that stops half way never leaves a broken keyring behind.
CADDY_KEY=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
CADDY_LIST=/etc/apt/sources.list.d/caddy-stable.list
CADDY_NEW=0
if [ ! -s "$CADDY_KEY" ]; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --batch --yes -o "$WORK/caddy.gpg"
	install -m 644 "$WORK/caddy.gpg" "$CADDY_KEY"
	CADDY_NEW=1
	say "added the Caddy signing key"
fi
if [ ! -s "$CADDY_LIST" ]; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o "$WORK/caddy.list"
	grep -q "signed-by=$CADDY_KEY" "$WORK/caddy.list" \
		|| die "the Caddy repository list does not use $CADDY_KEY; compare with caddyserver.com/docs/install"
	install -m 644 "$WORK/caddy.list" "$CADDY_LIST"
	CADDY_NEW=1
	say "added the Caddy apt repository"
fi
chmod o+r "$CADDY_KEY" "$CADDY_LIST"
if [ "$(dpkg-query -W -f='${Status}' caddy 2>/dev/null || true)" != "install ok installed" ]; then
	# A list added just now needs an update; one from an earlier run was already read by step 2's update.
	if [ "$CADDY_NEW" = 1 ]; then
		"${APT[@]}" update
	fi
	"${APT[@]}" install caddy
fi
id caddy >/dev/null 2>&1 || die "the caddy package did not create the caddy user"
say "caddy $(caddy version | cut -d' ' -f1)"

# ---------------------------------------------------------------------------------------------------
step "4/10 The sundial user and its directories"
if id -u sundial >/dev/null 2>&1; then
	say "user sundial exists"
else
	# A system user with no login and no home of its own: it only runs the server and owns its data.
	useradd --system --user-group --home-dir /var/lib/sundial --no-create-home \
		--shell /usr/sbin/nologin --comment "Sundial Sync server" sundial
	say "created the system user sundial"
fi
dir 755 root:root /opt/sundial /opt/sundial/bin
dir 700 sundial:sundial /var/lib/sundial
dir 700 root:root /etc/sundial
# The nightly copies are made as sundial (see sundial-backup in step 9), so this directory is sundial's.
dir 700 sundial:sundial /var/backups/sundial
say "/opt/sundial/bin, /var/lib/sundial, /etc/sundial and /var/backups/sundial are in place"

# ---------------------------------------------------------------------------------------------------
step "5/10 sundial-sync: the newest release binary"
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 30 --retry 3 -A "$UA" \
	-H 'Accept: application/vnd.github+json' \
	"https://api.github.com/repos/$REPO/releases/latest" -o "$WORK/release.json" \
	|| die "could not fetch the latest release from the GitHub API"
# Parsed with python3 (no jq on a stock box). -I: isolated mode, nothing shadowed from the environment.
python3 -I - "$WORK/release.json" "$SYNC_ASSET" >"$WORK/sync.meta" <<'PY' || die "the latest release has no $SYNC_ASSET asset (or no tag)"
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    rel = json.load(f)
asset = next((a for a in rel.get("assets") or [] if a.get("name") == sys.argv[2]), None)
if not rel.get("tag_name") or asset is None:
    sys.exit(3)
print(rel["tag_name"])
print(asset.get("browser_download_url") or "")
print(asset.get("digest") or "")
PY
{ read -r SYNC_TAG; read -r SYNC_URL; read -r SYNC_DIGEST; } <"$WORK/sync.meta"
case "$SYNC_URL" in
	"https://github.com/$REPO/releases/download/"*) ;;
	*) die "unexpected download URL '$SYNC_URL'" ;;
esac
# The digest comes from the GitHub API, separately from the file. No digest, no install.
case "$SYNC_DIGEST" in
	sha256:*) WANT=${SYNC_DIGEST#sha256:}; WANT=${WANT,,} ;;
	*) die "GitHub reports no sha256 digest for $SYNC_ASSET in $SYNC_TAG; refusing to install it unchecked" ;;
esac
[[ $WANT =~ ^[0-9a-f]{64}$ ]] || die "malformed digest '$SYNC_DIGEST' for $SYNC_ASSET"
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 300 --retry 3 -A "$UA" \
	-o "$WORK/$SYNC_ASSET" "$SYNC_URL" || die "could not download $SYNC_URL"
GOT=$(sha256sum "$WORK/$SYNC_ASSET" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || die "sha256 mismatch for $SYNC_ASSET $SYNC_TAG (GitHub says $WANT, the file is $GOT)"
say "$SYNC_TAG: $SYNC_ASSET matches the sha256 GitHub reports"

# Only the binary is taken from the archive, and only if it is a plain file (not a link or anything else).
kind=$(tar -tvzf "$WORK/$SYNC_ASSET" | awk -v m="$SYNC_MEMBER" '$NF == m { print substr($1, 1, 1) }')
[ "$kind" = "-" ] || die "$SYNC_ASSET has no plain file named $SYNC_MEMBER"
mkdir "$WORK/sync"
tar -xzf "$WORK/$SYNC_ASSET" -C "$WORK/sync" --no-same-owner --no-same-permissions "$SYNC_MEMBER"
NEW_BIN="$WORK/sync/$SYNC_MEMBER"
if [ ! -f "$NEW_BIN" ] || [ -L "$NEW_BIN" ]; then
	die "$SYNC_MEMBER did not unpack as a plain file"
fi

NEW_SUM=$(sha256sum "$NEW_BIN" | cut -d' ' -f1)
OLD_SUM=none
if [ -f "$SYNC_BIN" ]; then
	OLD_SUM=$(sha256sum "$SYNC_BIN" | cut -d' ' -f1)
fi
BIN_CHANGED=0
if [ "$NEW_SUM" = "$OLD_SUM" ]; then
	say "sundial-sync $SYNC_TAG is already installed"
else
	install -m 755 -o root -g root "$NEW_BIN" "$SYNC_STAGE"
	# A dry start before it goes live, as the sundial user and with no settings at all. A build this box
	# cannot run (for example one linked against a newer glibc than Ubuntu 24.04 has) fails here, not on
	# migration day. Without SUNDIAL_TOKENS or SUNDIAL_MODE the server refuses to start and exits with 2,
	# before it opens a database or a port.
	rc=0
	(cd / && timeout 10 runuser -u sundial -- env -i "$SYNC_STAGE") >"$WORK/smoke.log" 2>&1 || rc=$?
	case "$rc" in
		2) say "dry start ok (it asks for its settings, as it should)" ;;
		126|127) die "the $SYNC_TAG binary does not run on this box: $(head -c 300 "$WORK/smoke.log")" ;;
		*) warn "the $SYNC_TAG binary's dry start ended with exit $rc, not 2 ($(head -c 200 "$WORK/smoke.log")); installed anyway" ;;
	esac
	# The binary before this one stays next to it for a quick rollback. A rename never disturbs a running
	# process: it keeps the old file until it restarts.
	if [ -f "$SYNC_BIN" ]; then
		cp -p "$SYNC_BIN" "$SYNC_BIN.prev"
	fi
	mv -f "$SYNC_STAGE" "$SYNC_BIN"
	BIN_CHANGED=1
	say "installed sundial-sync $SYNC_TAG at $SYNC_BIN"
fi
printf '%s\n' "$SYNC_TAG" >/opt/sundial/VERSION

# ---------------------------------------------------------------------------------------------------
step "6/10 sundial-sync: the systemd unit"
put 644 "$SYNC_UNIT" <<'EOF'
# Written by server/ops/provision.sh (Sundial). Edit the copy in provision.sh, not this file.
[Unit]
Description=Sundial Sync server (sync.sundial.services, behind Caddy)
Documentation=https://github.com/zphat/Sundial/blob/main/server/README.md
After=network-online.target
Wants=network-online.target
# Both come from the old box on migration day. Until they are here, a start (or a boot) skips the unit
# cleanly instead of crash-looping, and the server never starts on a new, empty database by accident.
# To start on purpose with an empty database: runuser -u sundial -- touch /var/lib/sundial/sundial-sync.sqlite
ConditionPathExists=/etc/sundial/sync.env
ConditionPathExists=/var/lib/sundial/sundial-sync.sqlite
# Restart=always, and never give up after a burst of failures (the old box had a drop-in for this).
StartLimitIntervalSec=0

[Service]
Type=exec
User=sundial
Group=sundial
# A systemd EnvironmentFile, not a shell file: SUNDIAL_FROM contains <>, so it is never sourced.
EnvironmentFile=/etc/sundial/sync.env
ExecStart=/opt/sundial/bin/sundial-sync
# An unset SUNDIAL_DB (sundial-sync.sqlite) resolves here too.
WorkingDirectory=/var/lib/sundial
Restart=always
RestartSec=3
# The server shuts down cleanly on SIGINT only; SIGTERM would end it mid-request. SQLite in WAL mode
# survives either, but a clean close also folds the WAL back into the database file.
KillSignal=SIGINT
TimeoutStopSec=20
# /var/lib/sundial holds the database and its -wal and -shm files. systemd creates it for sundial if it
# is missing, and it is the only path the server may write.
StateDirectory=sundial
StateDirectoryMode=0700
UMask=0077

# Hardening. The server needs its listen socket, outbound HTTPS to Resend, DNS and /var/lib/sundial.
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
# A blocked call fails with EPERM instead of killing the server.
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF
UNIT_CHANGED=$CHANGED
if [ -d /etc/systemd/system/sundial-sync.service.d ]; then
	warn "found /etc/systemd/system/sundial-sync.service.d; the unit has Restart=always itself, check the drop-in undoes nothing"
fi
systemctl daemon-reload
systemctl enable sundial-sync.service >/dev/null 2>&1
say "unit written and enabled"

# Settings checks without printing a single value: only the key names are shown.
check_env() {
	env_has() { grep -Eq "^$1=" "$SYNC_ENV"; }
	env_is() { grep -Eq "^$1=\"?$2\"?[[:space:]]*\$" "$SYNC_ENV"; }
	say "env file keys: $(grep -Eo '^[A-Za-z_][A-Za-z0-9_]*=' "$SYNC_ENV" | tr -d '=' | paste -sd' ' -)"
	if env_has SUNDIAL_DB && ! env_is SUNDIAL_DB '/var/lib/sundial/sundial-sync\.sqlite'; then
		die "SUNDIAL_DB in $SYNC_ENV is not $SYNC_DB; the unit lets the server write /var/lib/sundial only"
	fi
	if env_has SUNDIAL_BIND && ! env_is SUNDIAL_BIND '127\.0\.0\.1:8768'; then
		warn "SUNDIAL_BIND in $SYNC_ENV is not 127.0.0.1:8768, where Caddy sends the sync traffic"
	fi
	env_is SUNDIAL_MODE hosted || warn "SUNDIAL_MODE in $SYNC_ENV is not hosted: email sign-in is off"
	env_has RESEND_API_KEY || warn "RESEND_API_KEY is missing from $SYNC_ENV: sign-in codes would go to the log, not by email"
	grep -Eq '^SUNDIAL_ORIGINS=.*https://app\.sundial\.services' "$SYNC_ENV" \
		|| warn "SUNDIAL_ORIGINS in $SYNC_ENV lacks https://app.sundial.services: the web app would hit CORS errors (web/README.md step 5)"
	# The old box also answered on an sslip.io name tied to its IP. If a link base still names it, the
	# sign-in emails point at a dead IP, and at a stranger once Exoscale hands that IP out again.
	if grep -q 'sslip\.io' "$SYNC_ENV"; then
		warn "$SYNC_ENV names an sslip.io host (SUNDIAL_PUBLIC_URL or SUNDIAL_APP_URL?); it must be https://sync.sundial.services / https://app.sundial.services"
	fi
}

if [ ! -f "$SYNC_ENV" ] || [ ! -f "$SYNC_DB" ]; then
	[ -f "$SYNC_ENV" ] || say "not started: $SYNC_ENV is not here yet"
	[ -f "$SYNC_DB" ] || say "not started: there is no database at $SYNC_DB yet"
	TODO+=("copy from the old box (MIGRATE.md step 5): /etc/sundial/sync.env as root:root 0600, and a sqlite3 .backup copy of the database (made with sundial-sync stopped) as $SYNC_DB, sundial:sundial 0600; then: systemctl start sundial-sync")
else
	chown root:root "$SYNC_ENV"
	chmod 600 "$SYNC_ENV"
	check_env
	# The copied database (and any -wal/-shm beside it) must belong to sundial, or the server cannot write.
	chown sundial:sundial "$SYNC_DB"*
	chmod 600 "$SYNC_DB"*
	if [ "$UNIT_CHANGED" = 1 ] || [ "$BIN_CHANGED" = 1 ]; then
		systemctl restart sundial-sync
	else
		systemctl start sundial-sync
	fi
	ok=0
	for _ in $(seq 1 20); do
		if curl -fsS --max-time 2 http://127.0.0.1:8768/v1/health >"$WORK/health" 2>/dev/null; then
			ok=1
			break
		fi
		sleep 1
	done
	if [ "$ok" = 1 ]; then
		say "running, health: $(cat "$WORK/health")"
	else
		warn "sundial-sync does not answer on 127.0.0.1:8768 (journalctl -u sundial-sync -n 30 --no-pager)"
	fi
fi

# ---------------------------------------------------------------------------------------------------
step "7/10 Caddy: the three sites"
# 512 MB box: if the kernel's out-of-memory killer ever picks Caddy, systemd brings it back. The
# package's unit has no Restart= line, so all three sites would stay down until someone logs in.
put 644 /etc/systemd/system/caddy.service.d/10-sundial-restart.conf <<'EOF'
# Written by server/ops/provision.sh (Sundial).
[Service]
Restart=on-failure
RestartSec=5s
EOF
if [ "$CHANGED" = 1 ]; then
	systemctl daemon-reload
fi
# Caddy writes its logs as the caddy user. "caddy validate" runs as root and would create a missing log
# file root-owned; the reload after it then fails with "permission denied" and Caddy keeps the old config.
# So the logs exist, caddy-owned, before validate, and are chowned again after it. Existing logs stay as
# they are (never truncated).
dir 755 caddy:caddy /var/log/caddy
for f in access app root; do
	if [ ! -e "/var/log/caddy/$f.log" ]; then
		install -m 600 -o caddy -g caddy /dev/null "/var/log/caddy/$f.log"
	fi
done
CADDY_CHANGED=0
if cmp -s "$WEB/Caddyfile" /etc/caddy/Caddyfile; then
	say "/etc/caddy/Caddyfile is already this one"
else
	install -m 644 -o root -g root "$WEB/Caddyfile" /etc/caddy/Caddyfile.new
	if ! caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >"$WORK/validate.log" 2>&1; then
		chown caddy:caddy /var/log/caddy/*.log
		tail -n 20 "$WORK/validate.log" >&2
		rm -f /etc/caddy/Caddyfile.new
		die "caddy validate rejected $WEB/Caddyfile; the live config is unchanged. Fix the file on the PC and run MIGRATE.md step 4 again"
	fi
	chown caddy:caddy /var/log/caddy/*.log
	if [ -f /etc/caddy/Caddyfile ]; then
		cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev
	fi
	mv -f /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
	CADDY_CHANGED=1
	say "installed /etc/caddy/Caddyfile (the one before it is Caddyfile.prev)"
fi
chown caddy:caddy /var/log/caddy/*.log
systemctl enable caddy >/dev/null 2>&1
if [ "$CADDY_CHANGED" = 1 ]; then
	systemctl reload-or-restart caddy \
		|| die "caddy did not take the new config (journalctl -u caddy -n 30 --no-pager); the previous file is /etc/caddy/Caddyfile.prev"
elif ! systemctl is-active --quiet caddy; then
	systemctl restart caddy
fi
systemctl is-active --quiet caddy || die "caddy is not running (journalctl -u caddy -n 30 --no-pager)"
say "caddy is running; certificates follow once DNS points at this box"

# ---------------------------------------------------------------------------------------------------
step "8/10 Web app updater and landing page"
# /var/www/app belongs to caddy: sundial-web-update runs as caddy (User=caddy in its unit), so nothing
# downloaded from GitHub is handled as root. The landing page belongs to root; Caddy only reads it.
dir 755 root:root /var/www
dir 755 caddy:caddy /var/www/app /var/www/app/releases
chown -R caddy:caddy /var/www/app
dir 755 root:root /var/www/root /var/www/root/img
copy 644 "$WEB/root/index.html" /var/www/root/index.html
for f in "$WEB"/root/img/*; do
	[ -f "$f" ] || continue
	copy 644 "$f" "/var/www/root/img/$(basename "$f")"
done
say "landing page in /var/www/root"
copy 755 "$WEB/sundial-web-update" /usr/local/bin/sundial-web-update
copy 644 "$WEB/sundial-web-update.service" /etc/systemd/system/sundial-web-update.service
copy 644 "$WEB/sundial-web-update.timer" /etc/systemd/system/sundial-web-update.timer
systemctl daemon-reload
# The first install, through the unit and so as caddy. Never as root: root-owned files under /var/www/app
# would block the timer's later runs. With nothing new to install, a run does nothing.
if systemctl start sundial-web-update.service; then
	if [ -f /var/www/app/current/VERSION ]; then
		say "web app: $(cat /var/www/app/current/VERSION)"
	else
		warn "sundial-web-update ran but /var/www/app/current/VERSION is missing (journalctl -u sundial-web-update -n 20)"
	fi
else
	warn "the first web update failed (journalctl -u sundial-web-update -n 20 --no-pager); the timer retries every 10 minutes"
fi
systemctl enable --now sundial-web-update.timer >/dev/null 2>&1
say "sundial-web-update.timer is on (every 10 minutes)"

# ---------------------------------------------------------------------------------------------------
step "9/10 Nightly database backup"
put 755 /usr/local/bin/sundial-backup <<'EOF'
#!/bin/bash
# sundial-backup: a consistent copy of the Sundial sync database, made nightly by /etc/cron.d/sundial-backup.
# Written by server/ops/provision.sh. Copies go to /var/backups/sundial as sundial-sync-<UTC time>.sqlite.gz.
# Copies more than 7 days old are deleted, but only after a good new copy exists.
#
# Restore one:
#   systemctl stop sundial-sync
#   rm -f /var/lib/sundial/sundial-sync.sqlite-wal /var/lib/sundial/sundial-sync.sqlite-shm
#   gunzip -c /var/backups/sundial/<file>.sqlite.gz >/var/lib/sundial/sundial-sync.sqlite
#   chown sundial:sundial /var/lib/sundial/sundial-sync.sqlite && chmod 600 /var/lib/sundial/sundial-sync.sqlite
#   runuser -u sundial -- sqlite3 /var/lib/sundial/sundial-sync.sqlite "UPDATE meta SET value=value+1 WHERE key='epoch'"
#   systemctl start sundial-sync
# The epoch bump makes every device offer what the copy is missing (server/README.md, "Backups and restores").
set -euo pipefail
DB=/var/lib/sundial/sundial-sync.sqlite
DIR=/var/backups/sundial
KEEP_DAYS=7
log() { echo "$(date -u +%FT%TZ) sundial-backup: $*"; }
cd /
exec 9>/run/sundial-backup.lock
# A run still going at the next night means the copy is stuck. That is an error to see in the log, not a
# quiet skip: a silent exit 0 here could hide weeks without a new copy.
flock -n 9 || { log "ERROR: an earlier run is still going"; exit 1; }
if [ ! -f "$DB" ]; then
	log "no database at $DB yet; nothing to do"
	exit 0
fi
# Leftovers of a run that died part way.
find "$DIR" -maxdepth 1 -type f -name '*.tmp*' -delete
# Room first. Before gzip the copy can be as big as the database, and a full disk would also stop the live
# database from writing. So ask for twice its size plus 512 MB, and skip the night if that is not there.
need=$(( $(stat -c %s "$DB") * 2 / 1024 + 524288 ))
avail=$(df -Pk "$DIR" | awk 'NR == 2 { print $4 }')
if [ "$avail" -lt "$need" ]; then
	log "ERROR: $avail KB free in $DIR, $need KB wanted; no copy made (the disk needs to grow, MIGRATE.md, Capacity)"
	exit 1
fi
OUT="$DIR/sundial-sync-$(date -u +%Y%m%dT%H%MZ).sqlite"
# Everything runs as sundial, the database's owner. A root sqlite3 that died part way could leave
# root-owned -wal/-shm files beside the database, and the server could not open it after that.
as_sundial() { runuser -u sundial -- "$@"; }
# VACUUM INTO, not .backup. Every signed-in request writes to the database (tokens.last_seen), and the
# sqlite3 shell's .backup starts over whenever another connection commits between its steps, so with a
# big database and steady traffic it may never finish. VACUUM INTO is one read transaction: in WAL mode
# the server keeps writing and nothing restarts it. The copy comes out compacted too. The timeout ends a
# run that hangs anyway, so the next night is not blocked by the lock.
if ! as_sundial timeout 20m sqlite3 "$DB" "VACUUM INTO '$OUT.tmp'"; then
	rm -f "$OUT.tmp"
	log "ERROR: VACUUM INTO failed or took more than 20 minutes; no copy made, the older copies are kept"
	exit 1
fi
check=$(as_sundial sqlite3 "$OUT.tmp" 'PRAGMA quick_check;' 2>&1 || true)
if [ "$check" != ok ]; then
	rm -f "$OUT.tmp"
	log "ERROR: the new copy failed its check ($check); the older copies are kept"
	exit 1
fi
as_sundial gzip -n "$OUT.tmp"
mv -f "$OUT.tmp.gz" "$OUT.gz"
# Keep 7 days: delete copies more than 6 full days old, which leaves today's and the six before it.
find "$DIR" -maxdepth 1 -type f -name 'sundial-sync-*.sqlite.gz' -mtime +$((KEEP_DAYS - 1)) -delete
kept=$(find "$DIR" -maxdepth 1 -type f -name 'sundial-sync-*.sqlite.gz' | wc -l)
log "ok: $(basename "$OUT.gz") ($(stat -c %s "$OUT.gz") bytes), $kept copies kept"
EOF
put 644 /etc/cron.d/sundial-backup <<'EOF'
# Nightly copy of the Sundial sync database, 7 days kept. Written by server/ops/provision.sh.
# 03:30 box time (UTC). server/ops/backup-offsite.sh, if it is ever installed, runs at 03:45, after this.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root /usr/local/bin/sundial-backup >>/var/log/sundial-backup.log 2>&1
EOF
systemctl enable --now cron >/dev/null 2>&1
say "sundial-backup runs at 03:30 into /var/backups/sundial, 7 days kept (log: /var/log/sundial-backup.log)"
say "off-site copies (backup-offsite.sh) are not installed; see MIGRATE.md, Later"

# ---------------------------------------------------------------------------------------------------
step "10/10 Security updates (unattended-upgrades)"
# The same two lines "dpkg-reconfigure unattended-upgrades" writes, plus a weekly clean of old package
# files so the apt cache does not creep up on the 10 GB disk. No automatic reboots (the default).
put 644 /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
say "daily security updates are on"

# ---------------------------------------------------------------------------------------------------
STEP="checklist"
printf '\n==> Checklist\n'
say "box: $(free -m | awk '/^Mem:/ { print $2 " MB RAM, " $7 " MB available" }'), $(free -m | awk '/^Swap:/ { print $2 " MB swap" }'), $(df -h / | awk 'NR == 2 { print $4 " free of " $2 " on /" }')"
say "caddy: $(systemctl is-active caddy || true), $(caddy version | cut -d' ' -f1)"
say "sundial-sync: $(systemctl is-active sundial-sync || true), binary $(cat /opt/sundial/VERSION)"
if [ -f /var/www/app/current/VERSION ]; then
	say "web app: $(cat /var/www/app/current/VERSION), timer $(systemctl is-active sundial-web-update.timer || true)"
else
	say "web app: not installed yet, timer $(systemctl is-active sundial-web-update.timer || true)"
fi
say "nightly backup: /etc/cron.d/sundial-backup, $(find /var/backups/sundial -maxdepth 1 -name '*.sqlite.gz' | wc -l) copies so far"
say "security updates: apt-daily-upgrade.timer $(systemctl is-active apt-daily-upgrade.timer || true)"

# Exoscale puts the public IPv4 on the interface itself (no NAT), so the first global address is it.
ME=$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR == 1 { sub(/\/.*/, "", $4); print $4 }' || true)
DNS_TODO=0
for h in "${HOSTS[@]}"; do
	ip=$(getent ahostsv4 "$h" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
	if [ -n "$ME" ] && [ "$ip" = "$ME" ]; then
		say "DNS: $h -> $ip (this box)"
	else
		say "DNS: $h -> ${ip:-nothing} (this box is ${ME:-unknown})"
		DNS_TODO=1
	fi
done
if [ "$DNS_TODO" = 1 ]; then
	TODO+=("point the A records @, app and sync at ${ME:-the new IP} (Cloudflare, DNS only), then: systemctl restart caddy (MIGRATE.md step 6). Until then new certificates cannot be issued; that is expected (MIGRATE.md step 4 copies the old box's)")
fi
if [ -f /var/run/reboot-required ]; then
	TODO+=("reboot: a package update asks for it. Best before the data is copied")
fi

if [ "${#TODO[@]}" -eq 0 ]; then
	printf '\n    Nothing left to do.\n'
else
	printf '\n    Still to do:\n'
	for t in "${TODO[@]}"; do
		printf '    - %s\n' "$t"
	done
fi
