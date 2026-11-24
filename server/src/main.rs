//! Sundial Sync server, protocol v1 (see ../../docs/SYNC-PROTOCOL.md).
//! A single binary with a single SQLite file. It stores encrypted documents per account and hands back
//! everything newer than a cursor. It never sees a task: ciphertext in, ciphertext out.
//!
//! Modes (env SUNDIAL_MODE):
//!   self   (default) — tokens from SUNDIAL_TOKENS="a,b"; each token is its own account. No email.
//!   hosted           — email sign-in codes; sent through Resend when RESEND_API_KEY + SUNDIAL_FROM are set,
//!                      otherwise printed to the log (development).

use axum::{
    body::HttpBody,
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    timeout::TimeoutLayer,
};

const PROTOCOL: i64 = 1;
const PAGE: i64 = 500;
// The longest a /v1/sync request may ask to be held while nothing is new. Kept under the 30 seconds clients allow a request.
const MAX_WAIT_SECS: u64 = 25;
/// The most a request body may hold. Everything but /v1/sync carries a few short fields, so only /v1/sync gets room
/// for documents, and only for a token the server knows (see known_token).
const SMALL_BODY: usize = 4096;
const SYNC_BODY: usize = 8 * 1024 * 1024;
/// How long a request may take from the moment its headers are in until its answer starts. A body that stalls is
/// dropped then, with whatever of it was read. It has to stay well above MAX_WAIT_SECS: a held /v1/sync request is
/// meant to take that long.
const REQUEST_SECS: u64 = 60;
/// A /v1/sync body above this size is read under a permit, and there are BIG_UPLOADS permits. A body is held in
/// memory from its first byte until the request is answered, and anyone with a sign-in can send 8 MB slowly on
/// many connections at once: the permits bound that at BIG_UPLOADS x 8 MB whatever the number of connections.
/// Ordinary syncs are far below BIG_BODY and never wait for a permit.
const BIG_BODY: usize = 256 * 1024;
const BIG_UPLOADS: usize = 6;
const _: () = assert!(REQUEST_SECS >= MAX_WAIT_SECS + 30);
// last_seen is for the device list, where ten minutes is exact enough: an idle check then writes nothing at all.
const SEEN_EVERY_MS: i64 = 10 * 60 * 1000;
// About 2 MB of ciphertext per page: 500 rows at the 64 KB document limit would be 44 MB in one response.
const PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CT_B64: usize = 64 * 1024 * 4 / 3 + 8;
const FUTURE_MS: i64 = 24 * 3600 * 1000;
const CODE_TTL_MS: i64 = 10 * 60 * 1000;
/// Ciphertext one account may hold in total (base64 characters, which is what travels and what is stored).
const QUOTA_BYTES: i64 = 50 * 1024 * 1024;
/// Wrong sign-in codes that lock an address, and for how long: NET_FAILS from one client network lock that network
/// out of the address, LOCK_FAILS from everywhere together lock the address for everyone.
const NET_FAILS: u32 = 10;
const LOCK_FAILS: i64 = 50;
const LOCK_MS: i64 = 24 * 3600 * 1000;
const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(24 * 3600);
/// Browser origins the API answers: the desktop app's webview and the local browser preview.
/// SUNDIAL_ORIGINS="https://a,https://b" adds more.
const ORIGINS: [&str; 7] = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:8767", "http://127.0.0.1:8767", "http://localhost:8000", "http://127.0.0.1:8000"];

#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    hosted: bool,
    /// Fixed-window counters: key -> (window start, hits, window length). In memory, so a restart clears them.
    limits: Arc<Mutex<HashMap<String, (Instant, u32, Duration)>>>,
    resend_key: Option<String>,
    from: String,
    public_url: String,
    /// Base of the web app, for the code page's "Open in the browser" button. Empty hides the button.
    app_url: String,
    http: reqwest::Client,
    /// Requests that are waiting for an account to change (`wait` on /v1/sync): account -> the bell a write rings.
    waiters: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// The hashes of the tokens in SUNDIAL_TOKENS. The list is only read at startup, so erasing a static account
    /// has to put these back itself.
    static_tokens: Arc<Vec<String>>,
    /// Permits for reading a big /v1/sync body (see BIG_BODY).
    uploads: Arc<tokio::sync::Semaphore>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn rand_b64(n: usize) -> String {
    let bytes: Vec<u8> = (0..n).map(|_| rand::thread_rng().gen()).collect();
    B64.encode(bytes)
}
fn rand_token(prefix: &str, n: usize) -> String {
    let s: String = rand::thread_rng().sample_iter(&Alphanumeric).take(n).map(char::from).collect();
    format!("{prefix}{s}")
}
/// Tokens are stored as SHA-256 hex, so a copy of the database signs nobody in.
fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(token.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}
fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "unauthorized".to_string())
}
fn wrong_code() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "wrong or expired code".to_string())
}
fn locked() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, "too many attempts, try later".to_string())
}
fn mail_limited() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "too many sign-in emails from here right now, try again later".into())
}
fn mail_unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "email could not be sent right now, try again in a few minutes".to_string())
}
/// When a request last failed inside the server (ms since the epoch, 0 = never). /v1/health reports it for five
/// minutes, so the uptime check sees a server that answers but cannot do its work (a full disk, a locked database).
static LAST_INTERNAL_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!("internal: {e}");
    LAST_INTERNAL_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, account TEXT NOT NULL, device_id TEXT, device_name TEXT, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, hashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_fails(email TEXT PRIMARY KEY, fails INTEGER NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(account TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL,
  nonce TEXT NOT NULL, ct TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT, received_at INTEGER NOT NULL, PRIMARY KEY(account, id));
CREATE INDEX IF NOT EXISTS docs_seq ON docs(account, seq);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(key,value) VALUES('epoch',1);
";

fn has_column(db: &Connection, table: &str, col: &str) -> rusqlite::Result<bool> {
    let mut st = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = st.query(params![])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == col {
            return Ok(true);
        }
    }
    Ok(false)
}

fn open_db(path: &str, hosted: bool, tokens: &[String]) -> rusqlite::Result<Connection> {
    let mut db = Connection::open(path)?;
    let _ = db.pragma_update(None, "journal_mode", "WAL");
    db.pragma_update(None, "synchronous", "NORMAL")?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch(SCHEMA)?;
    // Databases from before 0.1.3: the tokens table gets its `hashed` flag (0 = the row still holds the token itself).
    if !has_column(&db, "tokens", "hashed")? {
        db.execute("ALTER TABLE tokens ADD COLUMN hashed INTEGER NOT NULL DEFAULT 0", params![])?;
    }
    // Static tokens are accepted in both modes (the operator's own devices, a household on a self-hosted box).
    let _ = hosted;
    let tx = db.transaction()?;
    let removed = seed_tokens(&tx, tokens)?;
    tx.commit()?;
    if removed > 0 {
        tracing::info!("{removed} static token(s) no longer in SUNDIAL_TOKENS: they stop working, their accounts and documents stay");
    }
    Ok(db)
}

/// Makes SUNDIAL_TOKENS and the database agree: every listed token opens its own account, and a static token that is
/// no longer listed opens nothing. Returns how many tokens were taken away.
fn seed_tokens(db: &Connection, tokens: &[String]) -> rusqlite::Result<usize> {
    let mut hashes: Vec<String> = Vec::new();
    for t in tokens {
        let h = token_hash(t);
        // a row written by an older version holds the token itself: rewrite it to the hash
        db.execute("UPDATE OR REPLACE tokens SET token=?1, hashed=1 WHERE token=?2 AND hashed=0", params![h, t])?;
        let acct = static_account(db, t, &h)?;
        db.execute(
            "INSERT OR IGNORE INTO accounts(id,email,salt,created_at) VALUES(?1,NULL,?2,?3)",
            params![acct, rand_b64(32), now_ms()],
        )?;
        db.execute(
            "INSERT OR IGNORE INTO tokens(token,account,created_at,hashed) VALUES(?1,?2,?3,1)",
            params![h, acct, now_ms()],
        )?;
        hashes.push(h);
    }
    // Taking a token off the list is how an operator revokes it. Only the token row goes: the account and its
    // documents stay, so listing the token again gives them back. Tokens from email sign-in belong to accounts with
    // an email and are not touched. This runs after the loop above on purpose: a new token must never find the
    // account of a token that is being removed in the same start looking unused.
    let mut gone = String::from("DELETE FROM tokens WHERE account IN (SELECT id FROM accounts WHERE email IS NULL)");
    if !hashes.is_empty() {
        gone.push_str(&format!(" AND token NOT IN ({})", vec!["?"; hashes.len()].join(",")));
    }
    db.execute(&gone, params_from_iter(hashes.iter()))
}

/// The account a static token opens. A token the database knows keeps its account, so an install from before 0.1.14
/// keeps its ids. A new token gets an id made from its hash. Older versions used the token's first 8 characters,
/// which put two tokens that start alike into one account and kept a piece of the secret in the database.
fn static_account(db: &Connection, token: &str, hash: &str) -> rusqlite::Result<String> {
    let known: Option<String> = db
        .query_row("SELECT account FROM tokens WHERE token=?1 AND hashed=1", params![hash], |r| r.get(0))
        .optional()?;
    if let Some(acct) = known {
        return Ok(acct);
    }
    // A token that was taken off the list and is listed again gets its account back. With an id made from the hash
    // that happens by itself. An old-style account is handed back only while no token opens it: otherwise a second
    // token with the same first 8 characters would be let into an account that is in use.
    let old = format!("acct_{}", token.chars().take(8).collect::<String>());
    let orphan: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND email IS NULL) AND NOT EXISTS(SELECT 1 FROM tokens WHERE account=?1)",
        params![old],
        |r| r.get(0),
    )?;
    Ok(if orphan { old } else { format!("acct_{}", &hash[..16]) })
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= 256)
}

/// The client address for rate limits. Behind the reverse proxy on the same box (Caddy replaces any incoming
/// X-Forwarded-For with the real client address) the first X-Forwarded-For value is the client. From any other
/// peer the header is ignored, so it cannot be spoofed on a server bound to a public address.
fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
    let from_proxy = match addr.ip() {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback(),
    };
    if from_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return ip.to_string();
        }
    }
    addr.ip().to_string()
}

fn account_for(db: &Connection, token: &str) -> rusqlite::Result<Option<String>> {
    let h = token_hash(token);
    let row: Option<(String, Option<i64>)> = db
        .query_row("SELECT account,last_seen FROM tokens WHERE token=?1 AND hashed=1", params![h], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let seen = row.as_ref().and_then(|r| r.1);
    let mut acct: Option<String> = row.map(|r| r.0);
    if acct.is_none() {
        // a row from before 0.1.3 still holds the token itself: accept it once and rewrite it to the hash
        acct = db
            .query_row("SELECT account FROM tokens WHERE token=?1 AND hashed=0", params![token], |r| r.get(0))
            .optional()?;
        if acct.is_some() {
            if let Err(e) = db.execute("UPDATE OR REPLACE tokens SET token=?1, hashed=1 WHERE token=?2 AND hashed=0", params![h, token]) {
                tracing::warn!("token rewrite failed: {e}");
            }
        }
    }
    let now = now_ms();
    if acct.is_some() && seen.map_or(true, |t| now - t > SEEN_EVERY_MS) {
        db.execute("UPDATE tokens SET last_seen=?1 WHERE token=?2", params![now, h])?;
    }
    Ok(acct)
}

fn salt_for(db: &Connection, account: &str) -> rusqlite::Result<String> {
    db.query_row("SELECT salt FROM accounts WHERE id=?1", params![account], |r| r.get(0))
}

/// The network a client address belongs to: the /24 of an IPv4 address, the /48 of an IPv6 one (what one line
/// usually gets). Wrong sign-in codes are counted per network, so a neighbouring address is not a fresh start.
fn client_net(ip: &str) -> String {
    let v4 = |a: std::net::Ipv4Addr| {
        let o = a.octets();
        format!("{}.{}.{}.0/24", o[0], o[1], o[2])
    };
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => v4(a),
        Ok(IpAddr::V6(a)) => match a.to_ipv4_mapped() {
            Some(a) => v4(a),
            None => {
                let s = a.segments();
                format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])
            }
        },
        // not an address (a proxy that passes something else along): it counts as itself
        Err(_) => ip.to_string(),
    }
}

/// Simple fixed-window rate limit: `max` hits per `window` for a key. A refused hit is not counted, so a hit that
/// is given back (unallow) makes room for exactly one more.
fn allow(app: &App, key: &str, max: u32, window: Duration) -> bool {
    let mut m = app.limits.lock().unwrap();
    let now = Instant::now();
    if m.len() > 2_000 {
        m.retain(|_, v| now.duration_since(v.0) < v.2);
    }
    let e = m.entry(key.to_string()).or_insert((now, 0, window));
    if now.duration_since(e.0) > e.2 {
        *e = (now, 0, window);
    }
    if e.1 >= max {
        return false;
    }
    e.1 += 1;
    true
}

/// Gives one hit back: what it was counted for did not happen.
fn unallow(app: &App, key: &str) {
    if let Some(e) = app.limits.lock().unwrap().get_mut(key) {
        e.1 = e.1.saturating_sub(1);
    }
}

/// Whether a key has used up `max` in its current window. Counts nothing.
fn over(app: &App, key: &str, max: u32) -> bool {
    app.limits.lock().unwrap().get(key).map_or(false, |e| e.1 >= max && e.0.elapsed() <= e.2)
}

async fn health(State(app): State<App>) -> (StatusCode, Json<Value>) {
    // ok means the database answers and nothing failed inside the server in the last five minutes
    let db_ok = match app.db.lock() {
        Ok(db) => db.query_row("SELECT value FROM meta WHERE key='epoch'", params![], |r| r.get::<_, i64>(0)).optional().is_ok(),
        Err(_) => false,
    };
    let last = LAST_INTERNAL_MS.load(std::sync::atomic::Ordering::Relaxed);
    let ok = db_ok && (last == 0 || now_ms() - last > 5 * 60 * 1000);
    let code = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(json!({ "ok": ok, "version": env!("CARGO_PKG_VERSION"), "mode": if app.hosted { "hosted" } else { "self" }, "protocol": PROTOCOL })))
}

#[derive(Deserialize)]
struct EmailReq {
    #[serde(default)]
    email: String,
}

async fn auth_request(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<EmailReq>,
) -> Result<StatusCode, ApiError> {
    if !app.hosted {
        return Err(ApiError(StatusCode::NOT_FOUND, "self-hosted server: use the token".into()));
    }
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Ok(StatusCode::NO_CONTENT); // never reveal anything about addresses
    }
    // Abuse limits: per client, per address, and a global cap that stays under the email provider's daily quota.
    // The client's own limits come first, so a client that is over them is refused before it can use up somebody
    // else's address. "code-try" is the one count that is never given back: it bounds how often one client can
    // make the server call the email provider while sending fails.
    let ip = client_ip(&headers, &addr);
    let (ip_hour, ip_day, address) = (format!("code-ip-h:{ip}"), format!("code-ip-d:{ip}"), format!("code:{email}"));
    let refused = if !allow(&app, &format!("code-try:{ip}"), 30, HOUR) {
        Some("ip/tries")
    } else if !allow(&app, &ip_hour, 5, HOUR) {
        Some("ip/hour")
    } else if !allow(&app, &ip_day, 20, DAY) {
        Some("ip/day")
    } else {
        None
    };
    if let Some(which) = refused {
        tracing::warn!("sign-in code request refused: {which} limit");
        return Err(mail_limited());
    }
    let address_ok = allow(&app, &address, 5, HOUR);
    let global_ok = address_ok && allow(&app, "code-global", 80, DAY);
    let code = {
        let db = app.db.lock().unwrap();
        let live: Option<String> = db
            .query_row("SELECT code FROM codes WHERE email=?1 AND expires>?2", params![email, now_ms()], |r| r.get(0))
            .optional()
            .map_err(internal)?;
        if !address_ok {
            // This address has had its emails for the hour. While the code in them still works it gets its ten
            // minutes again and the request is answered as sent, so asking for someone's address five times does
            // not keep them from signing in with the code they already hold.
            if live.is_some() {
                db.execute("UPDATE codes SET expires=?1 WHERE email=?2", params![now_ms() + CODE_TTL_MS, email]).map_err(internal)?;
                return Ok(StatusCode::NO_CONTENT);
            }
            tracing::warn!("sign-in code request refused: address limit");
            return Err(mail_limited());
        }
        if !global_ok {
            tracing::warn!("sign-in code request refused: global/day limit");
            return Err(mail_limited());
        }
        match live {
            // the code is still valid: send it again, so the first email keeps working too
            Some(c) => {
                db.execute("UPDATE codes SET expires=?1 WHERE email=?2", params![now_ms() + CODE_TTL_MS, email]).map_err(internal)?;
                c
            }
            None => {
                let c = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
                db.execute(
                    "INSERT OR REPLACE INTO codes(email,code,expires,tries) VALUES(?1,?2,?3,0)",
                    params![email, c, now_ms() + CODE_TTL_MS],
                )
                .map_err(internal)?;
                c
            }
        }
    };
    if !send_code(&app, &email, &code).await {
        // Nothing went out, so nothing is used up: an outage at the email provider must not lock out the person
        // who keeps trying, or eat the day's allowance.
        for key in [ip_hour.as_str(), ip_day.as_str(), address.as_str(), "code-global"] {
            unallow(&app, key);
        }
        return Err(mail_unavailable());
    }
    Ok(StatusCode::NO_CONTENT)
}

fn pretty_code(code: &str) -> String {
    if code.len() == 6 { format!("{} {}", &code[..3], &code[3..]) } else { code.to_string() }
}

/// The sign-in email: the code large and copyable, a button that opens the app (or the /signin page), plain-text fallback.
fn email_html(public_url: &str, code: &str) -> String {
    let link = format!("{public_url}/signin?code={code}");
    let shown = pretty_code(code);
    format!(r##"<!doctype html><html><body style="margin:0;padding:0;background:#0B0C0B;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#E9ECE2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0C0B;padding:36px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#121412;border:1px solid #262B24;border-radius:18px">
<tr><td style="padding:26px 30px 6px;font-family:'Courier New',Courier,monospace;font-size:12px;letter-spacing:.22em;color:#D1FF4A;font-weight:bold">&#9680;&nbsp; SUNDIAL</td></tr>
<tr><td style="padding:6px 30px 0;font-size:22px;font-weight:bold;color:#E9ECE2">Your sign-in code</td></tr>
<tr><td style="padding:18px 30px 6px"><div style="display:inline-block;background:#0B0C0B;border:1px solid #2A3027;border-radius:14px;padding:16px 24px;font-family:'Courier New',Courier,monospace;font-size:36px;line-height:1;letter-spacing:.22em;color:#D1FF4A;font-weight:bold">{shown}</div></td></tr>
<tr><td style="padding:10px 30px 4px;color:#9BA392;font-size:14px;line-height:1.55">Type it into Sundial within 10 minutes. The button below shows the code with a copy button and opens the app where that is supported.</td></tr>
<tr><td style="padding:14px 30px 26px"><a href="{link}" style="display:inline-block;background:#D1FF4A;color:#0B0D06;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;font-size:14px">Open Sundial</a></td></tr>
<tr><td style="padding:0 30px 26px;color:#7E8679;font-size:12px;line-height:1.55;border-top:1px solid #1F241B;padding-top:16px">If you didn&#8217;t ask for this, ignore it; nothing happens without the code.<br>Sundial Sync &middot; end-to-end encrypted &middot; hosted in Switzerland</td></tr>
</table></td></tr></table></body></html>"##)
}

/// Sends the code; true when the provider accepted it (or when there is no provider and it went to the log).
async fn send_code(app: &App, email: &str, code: &str) -> bool {
    let link = format!("{}/signin?code={}", app.public_url, code);
    let Some(key) = app.resend_key.as_ref() else {
        tracing::info!("[sign-in] {email}: code {code} ({link})");
        return true;
    };
    let body = json!({
        "from": app.from,
        "to": [email],
        "subject": format!("{} is your Sundial sign-in code", pretty_code(code)),
        "text": format!("Your Sundial sign-in code is {code}. It works for 10 minutes.\n\nOpen the code page (copy button, opens the app where supported): {link}\n\nIf you did not ask for this, ignore it."),
        "html": email_html(&app.public_url, code),
    });
    let r = app.http.post("https://api.resend.com/emails").bearer_auth(key).json(&body).send().await;
    match r {
        Ok(resp) if resp.status().is_success() => true,
        Ok(resp) => {
            tracing::warn!("resend returned {}", resp.status());
            false
        }
        Err(e) => {
            tracing::warn!("resend failed: {e}");
            false
        }
    }
}

#[derive(Deserialize)]
struct VerifyReq {
    #[serde(default)]
    email: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    device: Value,
}

/// Checks a sign-in code for an address: 429 while the address is locked, 401 for a wrong, missing or expired code.
///
/// Wrong codes are counted per client network (in memory): NET_FAILS from one network lock that network out of the
/// address for 24 hours. Someone typing junk codes for an address they know therefore locks out their own network,
/// not the owner signing in from elsewhere. LOCK_FAILS wrong codes from all networks together (in the database)
/// lock the address for everyone for 24 hours, which is what bounds guessing from many networks at once.
/// Only a wrong code for a code that still works is counted: with no code, or an expired one, there is nothing to
/// guess. A correct code is used up and clears the counts.
fn check_code(app: &App, db: &Connection, email: &str, typed: &str, ip: &str) -> Result<(), ApiError> {
    let now = now_ms();
    let net = format!("code-fail:{} {email}", client_net(ip));
    db.execute("DELETE FROM auth_fails WHERE since < ?1", params![now - LOCK_MS]).map_err(internal)?;
    let fails: Option<(i64, i64)> = db
        .query_row("SELECT fails,since FROM auth_fails WHERE email=?1", params![email], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(internal)?;
    if over(app, &net, NET_FAILS) {
        return Err(locked());
    }
    if let Some((f, since)) = fails {
        if f >= LOCK_FAILS && now - since < LOCK_MS {
            return Err(locked());
        }
    }
    let code: Option<String> = db
        .query_row("SELECT code FROM codes WHERE email=?1 AND expires>=?2", params![email, now], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    let Some(code) = code else {
        return Err(wrong_code());
    };
    let typed: String = typed.chars().filter(|c| c.is_ascii_digit()).collect();
    use subtle::ConstantTimeEq;
    if !bool::from(code.as_bytes().ct_eq(typed.as_bytes())) {
        allow(app, &net, NET_FAILS, DAY);
        let (f, since) = match fails {
            Some((f, since)) if now - since < LOCK_MS => (f + 1, since),
            _ => (1, now),
        };
        // the lock lasts 24 hours from the failure that triggered it
        let since = if f >= LOCK_FAILS { now } else { since };
        db.execute("INSERT OR REPLACE INTO auth_fails(email,fails,since) VALUES(?1,?2,?3)", params![email, f, since]).map_err(internal)?;
        let _ = db.execute("UPDATE codes SET tries=tries+1 WHERE email=?1", params![email]);
        return Err(wrong_code());
    }
    db.execute("DELETE FROM codes WHERE email=?1", params![email]).map_err(internal)?;
    db.execute("DELETE FROM auth_fails WHERE email=?1", params![email]).map_err(internal)?;
    app.limits.lock().unwrap().remove(&net);
    Ok(())
}

async fn auth_verify(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<VerifyReq>,
) -> Result<Json<Value>, ApiError> {
    if !app.hosted {
        return Err(ApiError(StatusCode::NOT_FOUND, "self-hosted server: use the token".into()));
    }
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Err(wrong_code());
    }
    let ip = client_ip(&headers, &addr);
    if !allow(&app, &format!("verify-ip:{ip}"), 30, HOUR) {
        return Err(locked());
    }
    let db = app.db.lock().unwrap();
    check_code(&app, &db, &email, &body.code, &ip)?;
    let account: String = match db
        .query_row("SELECT id FROM accounts WHERE email=?1", params![email], |r| r.get(0))
        .optional()
        .map_err(internal)?
    {
        Some(a) => a,
        None => {
            let a = rand_token("acct_", 16);
            db.execute(
                "INSERT INTO accounts(id,email,salt,created_at) VALUES(?1,?2,?3,?4)",
                params![a, email, rand_b64(32), now_ms()],
            )
            .map_err(internal)?;
            a
        }
    };
    let token = rand_token("st_", 43);
    db.execute(
        "INSERT INTO tokens(token,account,device_id,device_name,platform,created_at,hashed) VALUES(?1,?2,?3,?4,?5,?6,1)",
        params![
            token_hash(&token),
            account,
            body.device["id"].as_str(),
            body.device["name"].as_str(),
            body.device["platform"].as_str(),
            now_ms()
        ],
    )
    .map_err(internal)?;
    let salt = salt_for(&db, &account).map_err(internal)?;
    Ok(Json(json!({ "token": token, "account_id": account, "salt": salt, "plan": "beta" })))
}

/// Sign-out: forgets the caller's token. 204 whether or not the token was still known, so a repeat is harmless.
/// A static token is left alone: it is the operator's, it is only written at startup, and forgetting it here would
/// shut out every device that uses it until the server is restarted.
async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let db = app.db.lock().unwrap();
    db.execute(
        "DELETE FROM tokens WHERE ((token=?1 AND hashed=1) OR (token=?2 AND hashed=0))
           AND account NOT IN (SELECT id FROM accounts WHERE email IS NULL)",
        params![token_hash(&token), token],
    )
    .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn account(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    let salt = salt_for(&db, &acct).map_err(internal)?;
    // what the account holds: ciphertext bytes against the quota, and how many documents are live
    let (bytes, docs): (i64, i64) = db
        .query_row("SELECT COALESCE(SUM(LENGTH(ct)),0), COALESCE(SUM(deleted=0),0) FROM docs WHERE account=?1", params![acct], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(internal)?;
    Ok(Json(json!({ "account_id": acct, "salt": salt, "plan": "beta", "bytes": bytes, "quota": QUOTA_BYTES, "docs": docs })))
}

fn has_email(db: &Connection, acct: &str) -> rusqlite::Result<bool> {
    db.query_row("SELECT email IS NOT NULL FROM accounts WHERE id=?1", params![acct], |r| r.get(0))
}

/// The devices signed in to the caller's account: what each sign-in recorded (name, platform), when it last synced
/// (to about ten minutes) and which one is asking. `id` is a short handle for /v1/devices/revoke, not the token.
async fn devices(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    let me = token_hash(&token);
    let can_revoke = has_email(&db, &acct).map_err(internal)?;
    let mut out = Vec::new();
    {
        let mut st = db
            .prepare("SELECT token,device_id,device_name,platform,created_at,last_seen FROM tokens WHERE account=?1 AND hashed=1 ORDER BY created_at")
            .map_err(internal)?;
        let rows = st
            .query_map(params![acct], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(internal)?;
        for row in rows {
            let (t, device_id, name, platform, created_at, last_seen) = row.map_err(internal)?;
            let id: String = t.chars().take(16).collect();
            out.push(json!({ "id": id, "device_id": device_id, "name": name, "platform": platform, "created_at": created_at, "last_seen": last_seen, "current": t == me }));
        }
    }
    Ok(Json(json!({ "devices": out, "can_revoke": can_revoke })))
}

#[derive(Deserialize)]
struct RevokeReq {
    #[serde(default)]
    id: String,
}

/// Signs one device out of the account: its token stops working, and it shows "signed out" at its next sync. What
/// that device holds stays on it. Only for accounts with an email: a static token is the operator's to manage.
async fn device_revoke(State(app): State<App>, headers: HeaderMap, Json(body): Json<RevokeReq>) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    if body.id.len() != 16 || !body.id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad("unknown device"));
    }
    let acct = {
        let db = app.db.lock().unwrap();
        let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
        if !allow(&app, &format!("revoke:{acct}"), 30, HOUR) {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
        }
        if !has_email(&db, &acct).map_err(internal)? {
            return Err(bad("not available with a static token"));
        }
        let n = db
            .execute("DELETE FROM tokens WHERE account=?1 AND hashed=1 AND substr(token,1,16)=?2", params![acct, body.id])
            .map_err(internal)?;
        if n == 0 {
            return Err(ApiError(StatusCode::NOT_FOUND, "unknown device".into()));
        }
        acct
    };
    // a request that device has waiting ends now and finds its token gone
    wake(&app, &acct);
    Ok(StatusCode::NO_CONTENT)
}

/// The bell for an account's waiting requests. The map is swept of bells nobody holds once it grows.
fn waiter(app: &App, acct: &str) -> Arc<tokio::sync::Notify> {
    let mut m = app.waiters.lock().unwrap();
    if m.len() > 5_000 {
        m.retain(|_, n| Arc::strong_count(n) > 1);
    }
    m.entry(acct.to_string()).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone()
}

/// Something changed in this account: every request waiting on it answers now.
fn wake(app: &App, acct: &str) {
    if let Some(n) = app.waiters.lock().unwrap().get(acct) {
        n.notify_waiters();
    }
}

/// Deletes the account, every document and every token, all or nothing. A hosted account (one with an email) also
/// needs a fresh sign-in code for that address in the body, {"code":"123456"}, so a leaked token alone cannot wipe a
/// synced copy. The body is read as text: self-hosted clients send none.
/// An account opened by static tokens comes straight back empty, with a new salt and the same tokens: the server
/// only reads SUNDIAL_TOKENS when it starts, so without this the token would answer 401 until the next restart.
async fn delete_account(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: String,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let ip = client_ip(&headers, &addr);
    let mut db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    let row: Option<Option<String>> = db
        .query_row("SELECT email FROM accounts WHERE id=?1", params![acct], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    let is_static = matches!(row, Some(None));
    if app.hosted {
        if let Some(email) = row.flatten() {
            let code = match serde_json::from_str::<Value>(&body) {
                Ok(v) => match &v["code"] {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                },
                Err(_) => String::new(),
            };
            if code.trim().is_empty() {
                return Err(bad("a fresh sign-in code is required: {\"code\":\"123456\"}"));
            }
            if !allow(&app, &format!("verify-ip:{ip}"), 30, HOUR) {
                return Err(locked());
            }
            check_code(&app, &db, &email, &code, &ip)?;
        }
    }
    let tx = db.transaction().map_err(internal)?;
    // the listed static tokens that open this account, read before the rows go
    let mut keep: Vec<String> = Vec::new();
    if is_static {
        let mut st = tx.prepare("SELECT token FROM tokens WHERE account=?1 AND hashed=1").map_err(internal)?;
        let rows = st.query_map(params![acct], |r| r.get::<_, String>(0)).map_err(internal)?;
        for h in rows {
            let h = h.map_err(internal)?;
            if app.static_tokens.contains(&h) {
                keep.push(h);
            }
        }
    }
    tx.execute("DELETE FROM docs WHERE account=?1", params![acct]).map_err(internal)?;
    tx.execute("DELETE FROM tokens WHERE account=?1", params![acct]).map_err(internal)?;
    tx.execute("DELETE FROM accounts WHERE id=?1", params![acct]).map_err(internal)?;
    if !keep.is_empty() {
        let now = now_ms();
        tx.execute("INSERT INTO accounts(id,email,salt,created_at) VALUES(?1,NULL,?2,?3)", params![acct, rand_b64(32), now]).map_err(internal)?;
        for h in &keep {
            tx.execute("INSERT INTO tokens(token,account,created_at,hashed) VALUES(?1,?2,?3,1)", params![h, acct, now]).map_err(internal)?;
        }
    }
    tx.commit().map_err(internal)?;
    drop(db);
    // Requests the account's other devices have waiting end now: they find the token gone, or, with a static token,
    // an empty account at cursor 0, instead of learning it up to 25 seconds later.
    wake(&app, &acct);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DocIn {
    id: String,
    kind: String,
    updated_at: i64,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    ct: String,
}

#[derive(Deserialize)]
struct SyncReq {
    #[serde(default)]
    protocol: i64,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    cursor: i64,
    #[serde(default)]
    docs: Vec<DocIn>,
    /// Seconds to hold the request while nothing is newer than the cursor (0 = answer at once). Only read when no
    /// documents are pushed; capped at MAX_WAIT_SECS. The response's `wait: true` tells a client the server knows it.
    #[serde(default)]
    wait: u64,
    /// The account salt the device got when it signed in. When it is not this account's salt, the account was erased
    /// and begun again behind a static token, and the device still holds the old key: nothing is stored (409).
    #[serde(default)]
    salt: Option<String>,
}

// "pair" documents are plaintext ECDH handshake messages between two of the user's PCs (see the protocol doc);
// the server relays them like any other opaque bytes.
const KINDS: [&str; 6] = ["task", "note", "labels", "routines", "keycheck", "pair"];

/// Runs in front of /v1/sync, before its body is read: the server keeps megabytes in memory only for a token it
/// knows. Any other request gets its 401 here. Its body is still read, piece by piece and thrown away, because an
/// answer sent while a client is in the middle of an upload can get lost on the way, and a device that was signed
/// out has to see that 401.
async fn known_token(State(app): State<App>, req: Request, next: Next) -> Response {
    let known = match bearer(req.headers()) {
        Some(token) => {
            let db = app.db.lock().unwrap();
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM tokens WHERE (token=?1 AND hashed=1) OR (token=?2 AND hashed=0))",
                params![token_hash(&token), token],
                |r| r.get::<_, bool>(0),
            )
        }
        None => Ok(false),
    };
    match known {
        Ok(true) => {
            // a declared length up to BIG_BODY goes straight on; anything bigger, or of unknown length, takes a permit
            let declared = req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
            if declared.is_some_and(|n| n <= BIG_BODY) {
                return next.run(req).await;
            }
            let permit = match tokio::time::timeout(Duration::from_secs(10), app.uploads.clone().acquire_owned()).await {
                Ok(Ok(p)) => p,
                // every permit is busy: the device keeps its changes and tries again at its next sync
                _ => return ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy, try again in a moment".into()).into_response(),
            };
            let (parts, body) = req.into_parts();
            let bytes = match axum::body::to_bytes(body, SYNC_BODY).await {
                Ok(b) => b,
                Err(_) => return ApiError(StatusCode::PAYLOAD_TOO_LARGE, "request body too large".into()).into_response(),
            };
            // the whole body is here now: what follows is quick, so the permit goes back before the handler runs
            drop(permit);
            next.run(Request::from_parts(parts, axum::body::Body::from(bytes))).await
        }
        Ok(false) => {
            let mut body = req.into_body();
            let mut left = SYNC_BODY;
            while let Some(Ok(frame)) = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
                let n = frame.data_ref().map_or(0, |d| d.len());
                if n > left {
                    break;
                }
                left -= n;
            }
            unauthorized().into_response()
        }
        Err(e) => internal(e).into_response(),
    }
}

async fn sync(State(app): State<App>, headers: HeaderMap, Json(body): Json<SyncReq>) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    if body.protocol != PROTOCOL {
        return Err(bad("unsupported protocol"));
    }
    // the device id is stored with every document a device writes, so it is bounded like everything else
    if body.device_id.len() > 64 {
        return Err(bad("device id too long"));
    }
    // per device, not per token: a self-hosted household shares one token across its PCs. Keyed on the token's hash,
    // so the limiter never holds a raw token.
    if !allow(&app, &format!("sync:{}:{}", token_hash(&token), body.device_id), 60, Duration::from_secs(60)) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    let wait = body.wait.min(MAX_WAIT_SECS);
    let first = sync_once(&app, &token, &body, true)?;
    if first.pushed {
        wake(&app, &first.acct);
    }
    if wait == 0 || !first.idle {
        return Ok(Json(first.resp));
    }
    // Nothing is new and the device asked to be told when something is. The bell is taken and armed first, then the
    // account is read once more, so a write that landed in between is not slept through. Then the request is held
    // until another device writes or the time is up, and answers with whatever is there by then.
    let bell = waiter(&app, &first.acct);
    let rung = bell.notified();
    tokio::pin!(rung);
    rung.as_mut().enable();
    let again = sync_once(&app, &token, &body, false)?;
    if !again.idle {
        return Ok(Json(again.resp));
    }
    let _ = tokio::time::timeout(Duration::from_secs(wait), rung).await;
    Ok(Json(sync_once(&app, &token, &body, false)?.resp))
}

/// What one pass of the sync produced.
struct Synced {
    resp: Value,
    acct: String,
    /// at least one pushed document was stored
    pushed: bool,
    /// nothing was pushed, nothing came back and the cursor did not move: a request that asked to wait may wait
    idle: bool,
}

/// One pass: store what was pushed, hand back what is newer than the cursor. No awaits in here; the database lock is
/// held from start to end. `count` is false for the extra passes of a waiting request, which the limits count once.
fn sync_once(app: &App, token: &str, body: &SyncReq, count: bool) -> Result<Synced, ApiError> {
    let mut db = app.db.lock().unwrap();
    let acct = account_for(&db, token).map_err(internal)?.ok_or_else(unauthorized)?;
    if let Some(theirs) = &body.salt {
        let ours: String = db.query_row("SELECT salt FROM accounts WHERE id=?1", params![acct], |r| r.get(0)).map_err(internal)?;
        if &ours != theirs {
            return Err(ApiError(StatusCode::CONFLICT, "account was reset".into()));
        }
    }
    // a ceiling per account, so inventing device ids buys nothing (ten devices at their fastest stay far below it)
    if count && !allow(app, &format!("acct:{acct}"), 600, Duration::from_secs(60)) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    let now = now_ms();
    let mut pushed: Vec<String> = Vec::new();
    let mut rejected: Vec<Value> = Vec::new();
    let mut stale: Vec<String> = Vec::new();
    let tx = db.transaction().map_err(internal)?;
    // Ciphertext the account holds now; kept current while documents are accepted below.
    let mut used: i64 = if body.docs.is_empty() {
        0
    } else {
        tx.query_row("SELECT COALESCE(SUM(LENGTH(ct)),0) FROM docs WHERE account=?1", params![acct], |r| r.get(0))
            .map_err(internal)?
    };
    for d in &body.docs {
        let reason = if d.id.is_empty() || d.id.len() > 128 {
            Some("id")
        } else if !KINDS.contains(&d.kind.as_str()) {
            Some("kind")
        } else if d.ct.len() > MAX_CT_B64 || d.nonce.len() > 64 {
            Some("size")
        } else if d.updated_at > now + FUTURE_MS {
            Some("future")
        } else {
            None
        };
        if let Some(reason) = reason {
            let id: String = d.id.chars().take(128).collect();
            let kind: String = d.kind.chars().take(32).collect();
            rejected.push(json!({ "id": id, "kind": kind, "reason": reason }));
            continue;
        }
        // the keycheck lives at one id, is set exactly once and is never withdrawn or re-typed: a second first-time
        // setup loses (two PCs signing in at the same moment), and no token holder can lock new PCs out
        if d.kind == "keycheck" && d.id != "keycheck" {
            rejected.push(json!({ "id": d.id, "kind": d.kind, "reason": "id" }));
            continue;
        }
        let stored: Option<(i64, i64, String)> = tx
            .query_row("SELECT updated_at,LENGTH(ct),kind FROM docs WHERE account=?1 AND id=?2", params![acct, d.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(internal)?;
        let mut old_len = 0i64;
        if let Some((u, len, stored_kind)) = stored {
            if d.kind == "keycheck" || stored_kind == "keycheck" {
                rejected.push(json!({ "id": d.id, "kind": d.kind, "reason": "exists" }));
                continue;
            }
            if stored_kind != d.kind {
                rejected.push(json!({ "id": d.id, "kind": d.kind, "reason": "kind" }));
                continue;
            }
            if u > d.updated_at {
                // the stored version is newer: it goes back in this response, whatever the device's cursor says
                stale.push(d.id.clone());
                continue;
            }
            old_len = len;
        }
        let ct = if d.deleted { "" } else { d.ct.as_str() };
        let next = used - old_len + ct.len() as i64;
        if next > QUOTA_BYTES {
            rejected.push(json!({ "id": d.id, "kind": d.kind, "reason": "quota" }));
            continue;
        }
        used = next;
        tx.execute("UPDATE accounts SET seq=seq+1 WHERE id=?1", params![acct]).map_err(internal)?;
        let seq: i64 = tx.query_row("SELECT seq FROM accounts WHERE id=?1", params![acct], |r| r.get(0)).map_err(internal)?;
        tx.execute(
            "INSERT OR REPLACE INTO docs(account,id,kind,updated_at,deleted,nonce,ct,seq,device_id,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![acct, d.id, d.kind, d.updated_at, d.deleted as i64, d.nonce, ct, seq, body.device_id, now],
        )
        .map_err(internal)?;
        pushed.push(d.id.clone());
    }
    let mut out = Vec::new();
    let mut last_seq = body.cursor;
    let mut count = 0i64;
    let mut bytes = 0usize;
    let mut more = false;
    {
        let mut st = tx
            .prepare("SELECT id,kind,updated_at,deleted,nonce,ct,seq FROM docs WHERE account=?1 AND seq>?2 ORDER BY seq LIMIT ?3")
            .map_err(internal)?;
        let rows = st
            .query_map(params![acct, body.cursor, PAGE + 1], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(internal)?;
        for row in rows {
            let (id, kind, updated_at, deleted, nonce, ct, seq) = row.map_err(internal)?;
            // a page ends after PAGE rows or about PAGE_BYTES of ciphertext, whichever comes first; it always holds
            // at least one row, and the client asks again while `more` is true
            if count >= PAGE || bytes > PAGE_BYTES {
                more = true;
                break;
            }
            count += 1;
            bytes += ct.len();
            last_seq = seq;
            if pushed.contains(&id) {
                continue;
            }
            out.push(json!({ "id": id, "kind": kind, "updated_at": updated_at, "deleted": deleted != 0, "nonce": nonce, "ct": ct, "seq": seq }));
        }
    }
    // A push that lost to a newer stored version: the device may already be past that version's place in the history
    // (it pulled it, then edited with a clock that runs behind the writer's). Without this it would go on showing an
    // edit the server never took, and nobody would know. The stored version goes back so every device agrees.
    for id in stale.iter().take(200) {
        if bytes > 2 * PAGE_BYTES {
            break;
        }
        if out.iter().any(|v: &Value| v["id"].as_str() == Some(id.as_str())) {
            continue;
        }
        let row = tx
            .query_row("SELECT kind,updated_at,deleted,nonce,ct,seq FROM docs WHERE account=?1 AND id=?2", params![acct, id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?))
            })
            .optional()
            .map_err(internal)?;
        if let Some((kind, updated_at, deleted, nonce, ct, seq)) = row {
            bytes += ct.len();
            out.push(json!({ "id": id, "kind": kind, "updated_at": updated_at, "deleted": deleted != 0, "nonce": nonce, "ct": ct, "seq": seq }));
        }
    }
    if count == 0 {
        // Nothing newer: hand back the account's real position. After a restore from backup this is lower than the
        // cursor the client sent, which is the point; the client stores whatever comes back. No loop: `more` is false.
        last_seq = tx.query_row("SELECT seq FROM accounts WHERE id=?1", params![acct], |r| r.get(0)).map_err(internal)?;
    }
    let epoch: i64 = tx
        .query_row("SELECT value FROM meta WHERE key='epoch'", params![], |r| r.get(0))
        .optional()
        .map_err(internal)?
        .unwrap_or(1);
    tx.commit().map_err(internal)?;
    let idle = body.docs.is_empty() && out.is_empty() && !more && last_seq == body.cursor;
    // `now` is the server's clock, so a device can notice its own is off; `wait: true` says this server holds requests
    let resp = json!({ "protocol": PROTOCOL, "cursor": last_seq, "docs": out, "more": more, "epoch": epoch, "rejected": rejected, "now": now, "wait": true });
    Ok(Synced { resp, acct, pushed: !pushed.is_empty(), idle })
}

/// Landing page for the email button: shows the code large with a copy button, offers the app's deep link and,
/// for a phone or a browser, the web app with the code in its URL.
async fn signin_page(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> Html<String> {
    let code: String = q.get("code").map(|c| c.chars().filter(|ch| ch.is_ascii_digit()).take(6).collect()).unwrap_or_default();
    let shown = if code.len() == 6 { pretty_code(&code) } else { "no code".to_string() };
    let web_btn = if app.app_url.is_empty() || code.len() != 6 {
        String::new()
    } else {
        format!(r#"<a class="btn" href="{}/?code={code}">Open in the browser</a>"#, app.app_url)
    };
    Html(format!(r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sundial sign-in</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0C0B;color:#E9ECE2;font-family:'Segoe UI',Helvetica,Arial,sans-serif}}
.card{{width:min(440px,calc(100% - 32px));background:#121412;border:1px solid #262B24;border-radius:20px;padding:28px 30px;box-shadow:0 30px 80px -30px #000}}
.brand{{font-family:'Courier New',monospace;font-size:12px;letter-spacing:.22em;color:#D1FF4A;font-weight:bold}}h1{{font-size:22px;margin:10px 0 14px}}
.code{{display:inline-block;background:#0B0C0B;border:1px solid #2A3027;border-radius:14px;padding:16px 24px;font-family:'Courier New',monospace;font-size:38px;letter-spacing:.22em;color:#D1FF4A;font-weight:bold;user-select:all}}
p{{color:#9BA392;font-size:14px;line-height:1.55}}.row{{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}}
button,a.btn{{font:inherit;font-weight:bold;font-size:14px;border-radius:999px;padding:11px 20px;cursor:pointer;text-decoration:none;border:1px solid #2A3027;background:#1B2117;color:#E9ECE2}}
.primary{{background:#D1FF4A;color:#0B0D06;border-color:transparent}}small{{color:#7E8679;font-size:12px;display:block;margin-top:18px;line-height:1.5}}</style></head>
<body><div class="card"><div class="brand"><img src="data:image/png;base64,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" width="22" height="22" alt="" style="vertical-align:-6px;margin-right:9px">SUNDIAL</div><h1>Your sign-in code</h1><div class="code" id="c">{shown}</div>
<p>Type it into Sundial within 10 minutes, or copy it. Open Sundial is for the Windows app, Open in the browser for the web app.</p>
<div class="row"><button class="primary" id="cp">Copy code</button><a class="btn" href="sundial://signin?code={code}">Open Sundial</a>{web_btn}</div>
<small>If you didn&#8217;t ask for this, close this page; nothing happens without the code.</small></div>
<script>document.getElementById('cp').onclick=function(){{navigator.clipboard.writeText('{code}').then(function(){{document.getElementById('cp').textContent='Copied'}},function(){{}})}}</script></body></html>"##))
}

/// Resolves on Ctrl-C or, on Unix, on SIGTERM: what systemd, a reboot and `docker stop` send. Requests in flight finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let hosted = std::env::var("SUNDIAL_MODE").map(|m| m == "hosted").unwrap_or(false);
    let tokens: Vec<String> = std::env::var("SUNDIAL_TOKENS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !hosted && tokens.is_empty() {
        eprintln!("self-hosted mode needs SUNDIAL_TOKENS=\"some-long-secret\" (or SUNDIAL_MODE=hosted)");
        std::process::exit(2);
    }
    if hosted && std::env::var("RESEND_API_KEY").map(|s| s.is_empty()).unwrap_or(true) {
        tracing::warn!("hosted mode without RESEND_API_KEY: sign-in codes are printed to this log instead of emailed");
    }
    let db_path = std::env::var("SUNDIAL_DB").unwrap_or_else(|_| "sundial-sync.sqlite".into());
    let db = open_db(&db_path, hosted, &tokens).expect("open database");
    let app = App {
        static_tokens: Arc::new(tokens.iter().map(|t| token_hash(t)).collect()),
        db: Arc::new(Mutex::new(db)),
        hosted,
        limits: Arc::new(Mutex::new(HashMap::new())),
        resend_key: std::env::var("RESEND_API_KEY").ok().filter(|s| !s.is_empty()),
        from: std::env::var("SUNDIAL_FROM").unwrap_or_else(|_| "Sundial <sign-in@sundial.services>".into()),
        public_url: std::env::var("SUNDIAL_PUBLIC_URL").unwrap_or_else(|_| "https://sync.sundial.services".into()).trim_end_matches('/').to_string(),
        app_url: std::env::var("SUNDIAL_APP_URL").unwrap_or_else(|_| "https://app.sundial.services".into()).trim_end_matches('/').to_string(),
        http: reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client"),
        waiters: Arc::new(Mutex::new(HashMap::new())),
        uploads: Arc::new(tokio::sync::Semaphore::new(BIG_UPLOADS)),
    };
    let mut origins: Vec<HeaderValue> = ORIGINS.into_iter().map(HeaderValue::from_static).collect();
    for o in std::env::var("SUNDIAL_ORIGINS").unwrap_or_default().split(',').map(str::trim).filter(|s| !s.is_empty()) {
        match HeaderValue::from_str(o) {
            Ok(v) => origins.push(v),
            Err(_) => tracing::warn!("SUNDIAL_ORIGINS: ignoring {o:?}"),
        }
    }
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        // a browser asks permission before each kind of cross-site request; it may remember the answer for two hours
        .max_age(Duration::from_secs(7200));
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/auth/request", post(auth_request))
        .route("/v1/auth/verify", post(auth_verify))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/account", get(account).delete(delete_account))
        // the one route with room for documents; known_token runs first and lets only a known token use it
        .route(
            "/v1/sync",
            post(sync).layer(DefaultBodyLimit::max(SYNC_BODY)).layer(middleware::from_fn_with_state(app.clone(), known_token)),
        )
        .route("/v1/devices", get(devices))
        .route("/v1/devices/revoke", post(device_revoke))
        .route("/signin", get(signin_page))
        .layer(DefaultBodyLimit::max(SMALL_BODY))
        // inside the CORS layer, so the 408 it answers with can be read by the web app too
        .layer(TimeoutLayer::new(Duration::from_secs(REQUEST_SECS)))
        .layer(cors)
        .with_state(app);
    let bind: SocketAddr = std::env::var("SUNDIAL_BIND").unwrap_or_else(|_| "127.0.0.1:8768".into()).parse().expect("SUNDIAL_BIND");
    tracing::info!("Sundial Sync {} on http://{} mode={} db={}", env!("CARGO_PKG_VERSION"), bind, if hosted { "hosted" } else { "self" }, db_path);
    let listener = tokio::net::TcpListener::bind(bind).await.expect("bind");
    // Connect info is what lets the handlers see the peer address (and so trust X-Forwarded-For only from the proxy).
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server");
}
