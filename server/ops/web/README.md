# Web app hosting: app.sundial.services and sundial.services

The web app is the same `ui/` the desktop app loads, served as static files by the Caddy that already
fronts the sync server on the Exoscale VPS (ch-gva-2, 89.145.167.185). Nothing runs server-side for it.

What is in this folder:

| File | Goes to | Purpose |
| --- | --- | --- |
| `Caddyfile` | `/etc/caddy/Caddyfile` | all three sites: sync API, web app, landing page |
| `sundial-web-update` | `/usr/local/bin/` | installs the newest release's `sundial-web.tar.gz` |
| `sundial-web-update.service`, `.timer` | `/etc/systemd/system/` | runs the script every 10 minutes |
| `root/index.html` | `/var/www/root/` | the landing page |

How a release reaches the web app: the `web` job in `.github/workflows/build.yml` packages `ui/` into
`sundial-web.tar.gz` and `attach-assets` puts it on the GitHub release. Every 10 minutes the timer asks
the GitHub API for the latest release, compares its tag with `/var/www/app/current/VERSION`, and if
they differ downloads the tarball, checks its sha256 against the digest the API reports, unpacks it to
`/var/www/app/releases/<version>/` and swaps the `current` symlink. The newest three releases stay on
disk for rollback.

## Before you start: DNS

At the domain's DNS, as plain A records (no proxy, "DNS only"):

| Name | Type | Value |
| --- | --- | --- |
| `app` | A | 89.145.167.185 |
| `@` | A | 89.145.167.185 |

Caddy gets certificates for every host named in the Caddyfile, so never name a host there that has no
record; Caddy retries its certificate forever and fills the log. `www` is left out for that reason; add
it to the last site block together with its A record if you want it.

The first `sundial-web-update --force` needs a GitHub release that carries `sundial-web.tar.gz`, that is
a tag built after the `web` job landed in `build.yml`. Until then step 3 fails with
"the latest release has no sundial-web.tar.gz asset"; do the rest and rerun step 3 after the next release.

## Install, as root, in this order

Copy this folder to the box first (for example `scp -r server/ops/web root@89.145.167.185:/root/web`)
and run everything from inside it.

1. Directories and the landing page

       id caddy                                              # the user the Caddy package runs Caddy as
       install -d -m 755 /var/www/app/releases /var/www/root
       chown -R caddy:caddy /var/www/app
       install -m 644 root/index.html /var/www/root/index.html

   `/var/www/app` belongs to `caddy` because the update script runs as that user (`User=caddy` in the
   unit), so nothing downloaded from GitHub is ever handled as root. If `id caddy` fails, Caddy was
   installed some other way; use the user its service runs as (`systemctl show -p User caddy`) in the
   unit and in the `chown`.

2. The update script and its timer

       install -m 755 sundial-web-update /usr/local/bin/sundial-web-update
       install -m 644 sundial-web-update.service sundial-web-update.timer /etc/systemd/system/
       systemctl daemon-reload

3. First install of the web bundle

       systemctl start sundial-web-update.service
       journalctl -u sundial-web-update -n 5 --no-pager
       cat /var/www/app/current/VERSION

   The journal shows one line, `web none -> <version>`. Nothing is serving yet, so the first run needs
   no `--force`. Never run the script as root: files root creates under `/var/www/app` block the timer's
   later runs. By hand it is always `sudo -u caddy /usr/local/bin/sundial-web-update`, with `--force`
   when the version is the same.

4. Start the timer

       systemctl enable --now sundial-web-update.timer
       systemctl list-timers sundial-web-update.timer

5. Let the sync server accept the web app's origin

   `/etc/sundial/sync.env` is a systemd EnvironmentFile, not a shell file (`SUNDIAL_FROM` contains `<>`),
   so do not `source` it. Append the origin to the existing line, or add the line:

       if grep -q '^SUNDIAL_ORIGINS=' /etc/sundial/sync.env; then
         sed -i '/^SUNDIAL_ORIGINS=/ s#$#,https://app.sundial.services#' /etc/sundial/sync.env
       else
         echo 'SUNDIAL_ORIGINS=https://app.sundial.services' >> /etc/sundial/sync.env
       fi
       grep '^SUNDIAL_ORIGINS=' /etc/sundial/sync.env
       systemctl restart sundial-sync
       curl -fsS https://sync.sundial.services/v1/health

   (The Tauri origins and localhost are built into the server; only the web origin needs adding.)

6. Caddy

   The sync block in the repo's Caddyfile was written from the docs, not copied from the box, and
   `install` replaces the whole live file. So first see what the box has:

       cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
       diff /etc/caddy/Caddyfile Caddyfile

   Copy the live sync site block, and any global options block (`{ email ... }`, `trusted_proxies` and
   the like), into the new file verbatim in place of the sync block it has. Keep `89-145-167-185.sslip.io`
   only if the live file names it; otherwise Caddy requests a public certificate for a name nobody uses.
   Then replace that block's `log { ... }` with `import privlog /var/log/caddy/access.log`, so the sync log
   keeps its file name (and its 14-day rolling) and drops the same fields as the two new logs. Then:

       install -m 644 Caddyfile /etc/caddy/Caddyfile
       caddy validate --config /etc/caddy/Caddyfile
       chown caddy:caddy /var/log/caddy/*.log     # validate ran as root and created the new log files root-owned
       systemctl reload caddy
       ls -l /var/log/caddy                                 # access.log, app.log, root.log

   Without the `chown`, the reload fails with "open /var/log/caddy/app.log: permission denied" and Caddy
   keeps the old config. If `caddy validate` complains, put the backup back before reloading. The reload keeps the sync site
   up; Caddy fetches the new certificates in the background, which takes a few seconds the first time.

## Check

    curl -I https://app.sundial.services                    # 200, the security headers, Cache-Control: no-cache
    curl -sI https://app.sundial.services/ui.js | grep -i cache-control
    curl -I https://sundial.services                        # 200, the landing page
    curl -fsS https://sync.sundial.services/v1/health       # the sync API still answers
    cat /var/www/app/current/VERSION
    journalctl -u sundial-web-update -n 20 --no-pager      # the timer's runs (quiet runs log nothing but start/stop)
    systemctl list-timers sundial-web-update.timer
    tail -n 5 /var/log/caddy/app.log /var/log/caddy/root.log
    journalctl -u caddy -n 30 --no-pager                   # certificate issuance, config reload

In a browser, open https://app.sundial.services and sign in; the sync calls go to sync.sundial.services
and must not fail with a CORS error in the console (that means step 5 was skipped).

## Rollback

The previous releases are still on disk:

    ls -l /var/www/app/releases
    sudo -u caddy ln -sfn releases/<previous version> /var/www/app/.current.tmp
    sudo -u caddy mv -T /var/www/app/.current.tmp /var/www/app/current

Then stop the timer, or it reinstalls the newest release within 10 minutes:

    systemctl stop sundial-web-update.timer

Fix forward by publishing a new release, then `systemctl start sundial-web-update.timer`. To reinstall
the newest release by hand at any time: `sudo -u caddy sundial-web-update --force`.

## What the box trusts

The web bundle is not signed. `sundial-web-update` checks the tarball's sha256 against the digest the
GitHub API reports, which proves the file is the one GitHub holds for the release, not who built it. So
anyone who can publish a release in the repo (a collaborator, the workflow's `GITHUB_TOKEN`, a compromised
action in `build.yml`) can put JavaScript in front of every web user within ten minutes, and that
JavaScript can read the sync key, the recovery code and the token from the browser's storage. The desktop
updater does not have this gap: it installs only a build whose minisign signature matches
`src-tauri/updater.pub`.

What is done about it today: the third-party actions in `build.yml` are pinned to commit SHAs, the script
accepts only plain files and directories from the tarball, and it runs as `caddy`, not root. The follow-up
is to sign `sundial-web.tar.gz` in CI with the updater key, attach the `.sig`, and verify it here with
`minisign` before the sha256 step, refusing a release without a signature.

## Updating these files later

Caddyfile: repeat step 6. Script or units: repeat step 2 (and `systemctl daemon-reload` for the units).
Landing page: repeat the second line of step 1.
