# Migration day: Sundial to an Exoscale Micro

This moves sync.sundial.services, app.sundial.services and sundial.services from the old instance
(89.145.167.185, 4 GB RAM, 50 GB disk) to a new Micro (512 MB RAM, 1 vCPU, 10 GB disk) in the same zone.

Plan about an hour. Sync is down for 5 to 15 minutes, from step 5 until DNS has moved in step 6.
The apps keep working offline in that time and catch up by themselves.

Run the PC commands in Git Bash, from the repo root. Never `cat` or open `sync.env` or
`caddy-certs.tgz`: they hold the Resend key, the sync tokens and the certificates' private keys. scp
copies them without showing them.

You need the SSH key `danny@sundial` on this PC, the Exoscale and Cloudflare logins, and an inbox for a
test sign-in.

```bash
OLD=89.145.167.185
NEW=        # the Micro's IP, from step 3
```

## 1. Top up

Add credit in the Exoscale portal (Billing). Wait until the account is no longer suspended.

Then open Compute, Instances. The old instance must still be listed, with the IP 89.145.167.185. If it
is gone, or shows another IP, stop here and ask for help. There is no database to copy then. Do not run
step 5, and do not start the Micro's server on an empty database. A fresh database starts at epoch 1,
like the old one, so the devices would not upload what they hold.

## 2. Start the old box and check it

Start the old instance in the portal (Compute, Instances). Then:

```bash
ssh root@$OLD 'curl -fsS http://127.0.0.1:8768/v1/health; echo; ls -lh /var/lib/sundial; df -h /'
```

The health line shows the running version and `"mode":"hosted"`. The database should be well under
400 MB. The Micro's disk holds about 450 MB of database with its nightly copies (Capacity, Disk). If it
is bigger, stop and ask before you go on.

Compare the old box's Caddyfile with the repo's:

```bash
scp root@$OLD:/etc/caddy/Caddyfile /tmp/old-Caddyfile
diff /tmp/old-Caddyfile server/ops/web/Caddyfile
```

Expected: the old file still names `89-145-167-185.sslip.io`, and some comments differ. If the old file
starts with a global options block (a bare `{ ... }` at the very top, for example with `email`), copy
that block to the very top of `server/ops/web/Caddyfile` now.

The repo's sync block was written from the docs, not copied from the box. If the old sync block has any
line the repo's lacks (for example `request_body`, `reverse_proxy` options, timeouts or
`trusted_proxies`), copy it into the sync block of `server/ops/web/Caddyfile` now. Only the sslip.io
name stays behind.

Check that no device still syncs through the sslip.io name. That name always points at the old IP, so
it stops working when the old box goes. The search covers the rolled logs too:

```bash
ssh root@$OLD "zgrep -h 'sslip.io' /var/log/caddy/access*.log* | grep -c '/v1/sync'"
```

`0` is good. Anything else means a device synced through that name in the last two weeks. In that
device's Sundial, set the server to `https://sync.sundial.services` (Settings, Data & sync). Old lines
stay in the logs, so the number never drops. Run the command again just before step 5: the number must
not have grown. A device that is switched off does not show up here, so check the setting on each of
your devices once. Step 8 says why this matters.

Check the DNS TTLs. Cloudflare, sundial.services, DNS, Records: the TTL column for `sundial.services`,
`app` and `sync` must say Auto. If one says anything else, set it to Auto now, and wait as long as the
old TTL said before you start step 5 (up to a day). Better still, check this a day before.

## 3. Create the Micro

Exoscale portal, Compute, Instances, Add instance:

- Zone: `ch-gva-2`
- Template: Linux Ubuntu 24.04 LTS 64-bit
- Instance type: Micro (512 MB, 1 vCPU)
- Disk: 10 GB
- SSH key: `danny@sundial`
- Security group: the one the old box uses (TCP 22, 80 and 443 open)
- IPv6: off (no AAAA records point here)

Put its IP in `NEW`. Exoscale's Ubuntu template blocks root at first (it answers
`Please login as the user "ubuntu"`). The first line below fixes that once: it accepts the host key and
lets your key log in as root. Root stays key-only, the same as on the old box.

```bash
NEW=<the new IP>
ssh ubuntu@$NEW 'sudo install -d -m 700 -o root -g root /root/.ssh && sudo install -m 600 -o root -g root /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys'
ssh root@$NEW true
```

The second line must print nothing. Every later command then works as written. If root is still
refused, stop and ask. Do not rewrite the commands for the ubuntu user by hand.

## 4. Provision the Micro

```bash
ssh root@$NEW 'rm -rf /root/ops' && scp -r server/ops root@$NEW:/root/
ssh root@$NEW 'bash /root/ops/provision.sh'
```

It takes 5 to 10 minutes and prints a line per step. If it stops, fix the cause and run both lines
again. The first line removes the old copy of the folder, so a fix made on the PC reaches the box. It is
safe to run twice.

The checklist at the end should list only two things still to do: copy the env file and the database,
and point DNS here. If it also says a reboot is required, reboot now, while the box holds no data:

```bash
ssh root@$NEW reboot
```

Wait a minute before you go on.

Check from the PC that the Micro answers on port 80:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: sync.sundial.services' http://$NEW/
```

It must print `308`: port 80 is open and Caddy answers. Anything else: check the security group (TCP 80
and 443 open) before you go on.

Copy the old box's certificates. They belong to the names, not to the IP, so the Micro can serve them
before DNS moves, and step 6 does not wait for Let's Encrypt. The file holds private keys: never open it.

```bash
mkdir -p ~/sundial-move
ssh root@$OLD 'tar -C /var/lib/caddy/.local/share/caddy -czf /root/caddy-certs.tgz certificates'
scp root@$OLD:/root/caddy-certs.tgz ~/sundial-move/
ssh root@$OLD 'rm -f /root/caddy-certs.tgz'
scp ~/sundial-move/caddy-certs.tgz root@$NEW:/root/
ssh root@$NEW 'set -e; runuser -u caddy -- mkdir -p /var/lib/caddy/.local/share/caddy; tar -C /var/lib/caddy/.local/share/caddy -xzf /root/caddy-certs.tgz; chown -R caddy:caddy /var/lib/caddy/.local/share/caddy; rm -f /root/caddy-certs.tgz; systemctl restart caddy'
```

If the first `tar` says the folder does not exist, skip the rest of this block. Step 6 then waits for
new certificates instead.

Check that the Micro now serves valid certificates. `--resolve` sends the request to the Micro while
DNS still points at the old box:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve sundial.services:443:$NEW https://sundial.services/
curl -s -o /dev/null -w '%{http_code}\n' --resolve app.sundial.services:443:$NEW https://app.sundial.services/
curl -s -o /dev/null -w '%{http_code}\n' --resolve sync.sundial.services:443:$NEW https://sync.sundial.services/v1/health
```

Expected: `200`, `200` and `502`. The 502 is right: the sync server starts in step 5. `000` means no
valid certificate. Then step 6 waits for new ones, as without the copy.

## 5. Move the data

Sync is down from here until step 6 is done.

On the old box, stop the server for good. `disable` matters: a reboot must not bring it back to take
writes the new box never sees. Then make a consistent copy. `.backup` reads through the WAL file, so the
copy holds every write. The block stops at the first failure:

```bash
ssh root@$OLD bash -s <<'EOF'
set -euo pipefail
systemctl disable --now sundial-sync
rm -f /root/sundial-sync-move.sqlite
sqlite3 /var/lib/sundial/sundial-sync.sqlite ".backup '/root/sundial-sync-move.sqlite'"
check=$(sqlite3 /root/sundial-sync-move.sqlite 'PRAGMA integrity_check;')
echo "integrity: $check"
[ "$check" = ok ] || { echo "STOP: the copy failed its check"; exit 1; }
EOF
```

It prints `integrity: ok`. If it prints `STOP`, use Rollback, before step 6.

Copy both files through the PC to the new box:

```bash
mkdir -p ~/sundial-move
scp root@$OLD:/etc/sundial/sync.env root@$OLD:/root/sundial-sync-move.sqlite ~/sundial-move/
scp ~/sundial-move/sync.env ~/sundial-move/sundial-sync-move.sqlite root@$NEW:/root/
```

On the new box, stop the server first (a rerun or a retry day finds it running), put both files in
place with the right owners, check the database and start the server. This block also stops at the
first failure:

```bash
ssh root@$NEW bash -s <<'EOF'
set -euo pipefail
systemctl stop sundial-sync
install -m 600 -o root -g root /root/sync.env /etc/sundial/sync.env
rm -f /var/lib/sundial/sundial-sync.sqlite-wal /var/lib/sundial/sundial-sync.sqlite-shm
install -m 600 -o sundial -g sundial /root/sundial-sync-move.sqlite /var/lib/sundial/sundial-sync.sqlite
check=$(runuser -u sundial -- sqlite3 /var/lib/sundial/sundial-sync.sqlite 'PRAGMA integrity_check;')
echo "integrity: $check"
[ "$check" = ok ] || { echo "STOP: the copy failed its check"; exit 1; }
rm -f /root/sync.env /root/sundial-sync-move.sqlite
systemctl restart sundial-sync
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8768/v1/health; then echo; break; fi
  if [ "$i" = 20 ]; then journalctl -u sundial-sync -n 20 --no-pager; echo "STOP: no health answer"; exit 1; fi
  sleep 1
done
journalctl -u sundial-sync -n 20 --no-pager
EOF
```

It prints `integrity: ok`, then the health line with `"ok":true` and `"mode":"hosted"`. The journal
must not say `hosted mode without RESEND_API_KEY`.

If it stops before the health line, run both scp lines above again, then this block again. If the check
fails a second time, use Rollback, before step 6. If it says `STOP: no health answer`, read the journal
lines it printed: a rerun will not fix that. If you cannot fix it, use Rollback, before step 6.

For a second opinion, run `ssh root@$NEW 'bash /root/ops/provision.sh'` once more. It checks the env
file's settings without printing them, and its checklist should now list only DNS.

If step 4 copied the certificates, check the whole path from the PC too, before any DNS change:

```bash
curl -fsS --resolve sync.sundial.services:443:$NEW https://sync.sundial.services/v1/health; echo
```

It prints the same health line.

## 6. DNS

From the moment you save the first record here, a rollback takes the "after step 6" path.

Cloudflare, sundial.services, DNS, Records. In the list, `@` shows as `sundial.services`. Do this for
each of the three names `sundial.services`, `app` and `sync`:

1. On its A record row, click Edit.
2. Put the new IP in "IPv4 address".
3. Set Proxy status to "DNS only" (grey cloud) and TTL to "Auto".
4. Click Save.

Edit the record that is there. Do not add a second A record next to it: then part of the traffic still
goes to the old IP. Each name must have exactly one A record, with the new IP. Delete any other A record
for that name.

If the temporary GitHub Pages landing page is on `@`:

- `@` has four A records, 185.199.108.153 to 185.199.111.153. Edit one of them as above and delete the
  other three.
- Delete AAAA records for `@` (2606:50c0:8000::153 and the like), and a CNAME for `www` that points at
  `*.github.io`.
- If `@` itself is a CNAME to `*.github.io`, delete it. Then click Add record: Type A, Name `@`, the new
  IP, "DNS only", TTL "Auto".

Delete any AAAA record for `app` or `sync` too: the Micro has no IPv6. Leave the MX and TXT records
alone. They carry mail and Resend's sender checks.

Right after you save the records, stop Caddy on the old box. Open apps keep their connection to the old
IP and would get errors from it for as long as they run. Stopping Caddy drops those connections, and the
apps reconnect through DNS. Stop it, do not disable it:

```bash
ssh root@$OLD 'systemctl stop caddy'
```

Wait until public DNS shows the new IP for all three names:

```bash
nslookup sundial.services 1.1.1.1
nslookup app.sundial.services 1.1.1.1
nslookup sync.sundial.services 1.1.1.1
nslookup sync.sundial.services 8.8.8.8
```

Each answer must list only the new IP, never 89.145.167.185. 1.1.1.1 is Cloudflare's own resolver and
shows the change at once. 8.8.8.8 shows what other resolvers see.

Wait 5 minutes after the change. Then restart Caddy on the Micro, so it starts fresh certificate
attempts now, and watch it:

```bash
ssh root@$NEW 'systemctl restart caddy'
ssh root@$NEW 'journalctl -u caddy -f'
```

If step 4 copied the certificates, Caddy already has all three. Press Ctrl-C and go on to step 7.

If it did not, wait for `certificate obtained successfully` for each of the three names, then press
Ctrl-C. If those lines do not come within 10 minutes, press Ctrl-C, run this and stop there:

```bash
ssh root@$NEW "journalctl -u caddy --since -15min --no-pager | grep -i error | tail -n 5"
```

The usual causes are a leftover old A or AAAA record, or port 80 closed in the security group.

## 7. Check

From the PC. `--resolve` sends each request to the Micro, so a stale DNS cache on the PC cannot let the
old box answer:

```bash
curl -sI --resolve sundial.services:443:$NEW https://sundial.services | head -n 1
curl -sI --resolve app.sundial.services:443:$NEW https://app.sundial.services | head -n 1
curl -fsS --resolve sync.sundial.services:443:$NEW https://sync.sundial.services/v1/health; echo
curl -s -o /dev/null -D - -X OPTIONS --resolve sync.sundial.services:443:$NEW https://sync.sundial.services/v1/sync \
  -H 'Origin: https://app.sundial.services' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  | grep -i '^access-control-allow-origin'
```

Expected: two lines with `200`, the health line with `"mode":"hosted"`, and
`access-control-allow-origin: https://app.sundial.services`. That last one is CORS for the web app.

On the new box:

```bash
ssh root@$NEW
cat /var/www/app/current/VERSION
systemctl list-timers sundial-web-update.timer --no-pager
journalctl -u sundial-web-update -n 5 --no-pager
/usr/local/bin/sundial-backup && ls -lh /var/backups/sundial
exit
```

The web app shows the newest release. The timer has a next run. The backup prints `ok` and one copy is
listed.

Before the browser test, clear the PC's DNS cache in Git Bash:

```bash
ipconfig //flushdns
```

In a browser, in a private window, open https://app.sundial.services and sign in with your email. The
code email must arrive and the code must work. The console (F12) must show no CORS errors. In Sundial on
your PC, Settings, Data & sync must show a fresh sync time. If an open app still shows an old sync time,
quit it and open it again.

## 8. Clean up

GitHub Pages, only if you used it: in that repository, Settings, Pages, remove the custom domain. Do
this only now. A custom domain removed while DNS still points at GitHub can be claimed by someone else.

The copies on the PC hold the keys, the certificates' private keys and every account's email address,
and the privacy page says the data stays in Switzerland. Delete them:

```bash
rm -f ~/sundial-move/sync.env ~/sundial-move/sundial-sync-move.sqlite ~/sundial-move/caddy-certs.tgz
```

The old instance: destroy it only when every check in step 7 has passed and the sslip.io count from
step 2 was `0`, or stopped growing once the devices were switched. The reason: after the destroy,
Exoscale can give 89.145.167.185 to another customer. That customer can get a valid certificate for
89-145-167-185.sslip.io and receive the sign-in token of any device still set to it.

Then destroy it in the portal (Compute, Instances). Its 50 GB disk and its on-box backups go with it.
The Micro made its own first copy in step 7. If you want one day of safety net, stop it instead and
destroy it tomorrow. A stopped instance still bills its disk.

Billing: check the portal for leftovers such as snapshots or Elastic IPs. Tomorrow, the only things
still billing should be the Micro and its 10 GB disk. Today's usage still includes the old instance's
hours.

## Rollback

Which path: once any DNS record in step 6 has been saved, use "After step 6". Before that, use "Before
step 6".

### Before step 6

DNS still points at the old box and nobody has used the new one. Turn the old server back on:

```bash
ssh root@$OLD 'systemctl enable --now sundial-sync'
```

Then stop the Micro's server and move its database aside. With no database in place, a reboot or a
provision.sh rerun cannot start it again on a stale copy:

```bash
ssh root@$NEW bash -s <<'EOF'
set -euo pipefail
systemctl disable --now sundial-sync
DB=/var/lib/sundial/sundial-sync.sqlite
if [ -f "$DB" ]; then mv "$DB" "/var/lib/sundial/rolled-back-$(date +%F-%H%M).sqlite"; fi
rm -f "$DB-wal" "$DB-shm"
EOF
```

Delete the copies on the PC. Step 8 never runs on this path:

```bash
rm -f ~/sundial-move/*
```

Then destroy the Micro, or fix it and try again another day.

### After step 6

This works while the old instance still exists. Take the new box's data back, so nothing written since
the move is lost. First the Micro: stop its server, copy its database, move the database aside and stop
its Caddy, so open apps drop their connections to it:

```bash
ssh root@$NEW bash -s <<'EOF'
set -euo pipefail
systemctl disable --now sundial-sync
DB=/var/lib/sundial/sundial-sync.sqlite
# A second run must not copy an empty database over the first run's copy.
[ -f "$DB" ] || { echo "STOP: no database at $DB; a first run already made /var/backups/sundial/rollback.sqlite"; exit 1; }
rm -f /var/backups/sundial/rollback.sqlite
runuser -u sundial -- sqlite3 "$DB" ".backup /var/backups/sundial/rollback.sqlite"
mv "$DB" "/var/lib/sundial/rolled-back-$(date +%F-%H%M).sqlite"
rm -f "$DB-wal" "$DB-shm"
systemctl stop caddy
EOF
```

If it says `STOP: no database`, the copy is already there: go on with the next block.

Then put the copy on the old box and start its server and its Caddy again:

```bash
scp root@$NEW:/var/backups/sundial/rollback.sqlite ~/sundial-move/
scp ~/sundial-move/rollback.sqlite root@$OLD:/root/
ssh root@$OLD bash -s <<'EOF'
set -euo pipefail
check=$(sqlite3 /root/rollback.sqlite 'PRAGMA integrity_check;')
echo "integrity: $check"
[ "$check" = ok ] || { echo "STOP: the copy failed its check"; exit 1; }
DB=/var/lib/sundial/sundial-sync.sqlite
rm -f "$DB-wal" "$DB-shm"
install -m 600 -o "$(stat -c %U "$DB")" -g "$(stat -c %G "$DB")" /root/rollback.sqlite "$DB"
rm -f /root/rollback.sqlite
systemctl enable --now sundial-sync
systemctl start caddy
sleep 3
curl -fsS http://127.0.0.1:8768/v1/health; echo
EOF
```

It prints `integrity: ok` and the health line. If it prints `STOP`, run the two scp lines and this
block again. If it stops a second time, the old box still has its own file from step 5. On the old box,
bump its epoch (below), then run `systemctl enable --now sundial-sync` and `systemctl start caddy`.

Then set the three A records back to 89.145.167.185 (or `@` back to GitHub Pages). Delete the copies on
the PC. Step 8 never runs on this path:

```bash
rm -f ~/sundial-move/*
```

If you go back to an older copy instead (for example the old box's own file, which lacks what was
written on the new box), bump the epoch before you start the server. Every device then offers what the
copy is missing (server/README.md, "Backups and restores"):

```bash
sqlite3 /var/lib/sundial/sundial-sync.sqlite "UPDATE meta SET value=value+1 WHERE key='epoch'"
```

### After the old instance is destroyed

The only way is forward: fix the Micro. Its pieces have fallbacks:

- `/opt/sundial/bin/sundial-sync.prev`: the binary before the last update.
- `/etc/caddy/Caddyfile.prev`: the Caddyfile before the last change.
- The web app's previous releases: web/README.md, "Rollback".
- The nightly copies in `/var/backups/sundial`: the restore steps are at the top of
  `/usr/local/bin/sundial-backup`.

## Capacity

These are estimates, not measurements. They assume use like today's: tasks and daily notes.

- Memory. With the idle services off, Ubuntu uses about 150 MB, Caddy 40 to 60 MB and sundial-sync 10
  to 30 MB. That leaves about 250 MB, plus 1 GB of swap for spikes. An open app syncs every 10 seconds
  (once a minute when hidden), and each sync is a small request. A few hundred devices open at the same
  moment is fine. Memory gets tight somewhere past a thousand.
- Disk. About 4 to 5 GB is left after the system, the swap, the journal and the logs. The data is
  encrypted, so gzip shrinks it only a little: each nightly copy is about 0.8 times the database. The
  database, its 7 copies and the room sundial-backup wants free before the next copy (twice the
  database plus 512 MB) take about 9 times the database plus 512 MB. So the database can grow to about
  450 MB before nights start being skipped. The protocol notes put a busy account under 10 MB a year,
  and most are 1 to 2 MB. One account is capped at 50 MB (docs/SYNC-PROTOCOL.md). That is room for
  about 225 to 450 accounts, or about 45 heavy ones.
- Email. The server sends at most 80 sign-in codes a day (Resend's free plan allows 100). That limits
  how many people can sign in on a new device per day, not how many accounts there are.

So the Micro holds a few hundred people. Disk runs out first, memory second.

Signs it needs the 1 GB size (Tiny):

```bash
free -m                                                # "available" under 100 MB at busy times
swapon --show                                          # more than 300 MB of swap used, day after day
vmstat 5 5                                             # si and so are not 0 most of the time
journalctl -k --since -7d | grep -i 'out of memory'    # any line: the kernel killed a process
systemctl show -p NRestarts sundial-sync caddy         # restarts you did not cause
uptime                                                 # load average above 1 for long stretches
```

To resize: in the portal, stop the instance, scale it to Tiny (1 GB), start it. That is a minute or two
of downtime. The instance keeps its IP, so DNS needs nothing. Check the portal shows the same IP after
the start.

Signs it needs more disk:

```bash
df -h /                                # more than 80% used
ls -lh /var/lib/sundial                # the database is past 350 MB
tail -n 3 /var/log/sundial-backup.log  # "ERROR: ... free" means a night was skipped
```

More disk does not need a bigger instance. Stop the instance, resize its disk (it can only grow), and
start it. Ubuntu grows the filesystem at boot.

## Later

- Off-site backups. `server/ops/backup-offsite.sh` is not installed. When there is money for object
  storage, follow the setup in its header. Its comments still say the on-box copies are kept 30 days;
  this box keeps 7.
- PRIVACY.md says the on-box backups are kept 30 days. It should say 7 days now.
- web/README.md step 6 (merging the live Caddyfile and keeping the sslip.io name) described the first
  box. provision.sh does that work now.
