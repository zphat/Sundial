//! Sundial Sync server, protocol v1 (see ../../docs/SYNC-PROTOCOL.md).
//! A single binary with a single SQLite file. It stores encrypted documents per account and hands back
//! everything newer than a cursor. It never sees a task: ciphertext in, ciphertext out.
//!
//! Modes (env SUNDIAL_MODE):
//!   self   (default) — tokens from SUNDIAL_TOKENS="a,b"; each token is its own account. No email.
//!   hosted           — email sign-in codes; sent through Resend when RESEND_API_KEY + SUNDIAL_FROM are set,
//!                      otherwise printed to the log (development).

use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower_http::cors::{Any, CorsLayer};

const PROTOCOL: i64 = 1;
const PAGE: i64 = 500;
const MAX_CT_B64: usize = 64 * 1024 * 4 / 3 + 8;
const FUTURE_MS: i64 = 24 * 3600 * 1000;
const CODE_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    hosted: bool,
    limits: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
    resend_key: Option<String>,
    from: String,
    public_url: String,
    http: reqwest::Client,
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
fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!("internal: {e}");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, account TEXT NOT NULL, device_id TEXT, device_name TEXT, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS docs(account TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL,
  nonce TEXT NOT NULL, ct TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT, received_at INTEGER NOT NULL, PRIMARY KEY(account, id));
CREATE INDEX IF NOT EXISTS docs_seq ON docs(account, seq);
";

fn open_db(path: &str, hosted: bool, tokens: &[String]) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    let _ = db.pragma_update(None, "journal_mode", "WAL");
    db.pragma_update(None, "synchronous", "NORMAL")?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch(SCHEMA)?;
    // Static tokens are accepted in both modes (the operator's own devices, a household on a self-hosted box).
    let _ = hosted;
    {
        for t in tokens {
            let acct = format!("acct_{}", &t.chars().take(8).collect::<String>());
            db.execute(
                "INSERT OR IGNORE INTO accounts(id,email,salt,created_at) VALUES(?1,NULL,?2,?3)",
                params![acct, rand_b64(32), now_ms()],
            )?;
            db.execute(
                "INSERT OR IGNORE INTO tokens(token,account,created_at) VALUES(?1,?2,?3)",
                params![t, acct, now_ms()],
            )?;
        }
    }
    Ok(db)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn account_for(db: &Connection, token: &str) -> rusqlite::Result<Option<String>> {
    let acct: Option<String> = db
        .query_row("SELECT account FROM tokens WHERE token=?1", params![token], |r| r.get(0))
        .optional()?;
    if acct.is_some() {
        db.execute("UPDATE tokens SET last_seen=?1 WHERE token=?2", params![now_ms(), token])?;
    }
    Ok(acct)
}

fn salt_for(db: &Connection, account: &str) -> rusqlite::Result<String> {
    db.query_row("SELECT salt FROM accounts WHERE id=?1", params![account], |r| r.get(0))
}

/// Simple fixed-window rate limit: `max` hits per `window` for a key.
fn allow(app: &App, key: &str, max: u32, window: Duration) -> bool {
    let mut m = app.limits.lock().unwrap();
    let now = Instant::now();
    let e = m.entry(key.to_string()).or_insert((now, 0));
    if now.duration_since(e.0) > window {
        *e = (now, 0);
    }
    e.1 += 1;
    if m.len() > 50_000 {
        m.retain(|_, v| now.duration_since(v.0) < window);
    }
    m.get(key).map(|v| v.1 <= max).unwrap_or(true)
}

async fn health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "mode": if app.hosted { "hosted" } else { "self" }, "protocol": PROTOCOL }))
}

#[derive(Deserialize)]
struct EmailReq {
    email: String,
}

async fn auth_request(State(app): State<App>, Json(body): Json<EmailReq>) -> Result<StatusCode, ApiError> {
    if !app.hosted {
        return Err(ApiError(StatusCode::NOT_FOUND, "self-hosted server: use the token".into()));
    }
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Ok(StatusCode::NO_CONTENT); // never reveal anything about addresses
    }
    if !allow(&app, &format!("code:{email}"), 5, Duration::from_secs(3600)) {
        return Ok(StatusCode::NO_CONTENT);
    }
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    {
        let db = app.db.lock().unwrap();
        db.execute(
            "INSERT OR REPLACE INTO codes(email,code,expires,tries) VALUES(?1,?2,?3,0)",
            params![email, code, now_ms() + CODE_TTL_MS],
        )
        .map_err(internal)?;
    }
    send_code(&app, &email, &code).await;
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

async fn send_code(app: &App, email: &str, code: &str) {
    let link = format!("{}/signin?code={}", app.public_url, code);
    let Some(key) = app.resend_key.as_ref() else {
        tracing::info!("[sign-in] {email}: code {code} ({link})");
        return;
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
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!("resend returned {}", resp.status()),
        Err(e) => tracing::warn!("resend failed: {e}"),
    }
}

#[derive(Deserialize)]
struct VerifyReq {
    email: String,
    code: String,
    #[serde(default)]
    device: Value,
}

async fn auth_verify(State(app): State<App>, Json(body): Json<VerifyReq>) -> Result<Json<Value>, ApiError> {
    if !app.hosted {
        return Err(ApiError(StatusCode::NOT_FOUND, "self-hosted server: use the token".into()));
    }
    let email = body.email.trim().to_lowercase();
    let db = app.db.lock().unwrap();
    let row: Option<(String, i64, i64)> = db
        .query_row("SELECT code,expires,tries FROM codes WHERE email=?1", params![email], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(internal)?;
    let Some((code, expires, tries)) = row else { return Err(unauthorized()) };
    if expires < now_ms() || tries >= 5 {
        return Err(unauthorized());
    }
    let ok: bool = {
        use subtle::ConstantTimeEq;
        let typed: String = body.code.chars().filter(|c| c.is_ascii_digit()).collect();
        bool::from(code.as_bytes().ct_eq(typed.as_bytes()))
    };
    if !ok {
        db.execute("UPDATE codes SET tries=tries+1 WHERE email=?1", params![email]).map_err(internal)?;
        return Err(unauthorized());
    }
    db.execute("DELETE FROM codes WHERE email=?1", params![email]).map_err(internal)?;
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
        "INSERT INTO tokens(token,account,device_id,device_name,platform,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            token,
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

async fn account(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    let salt = salt_for(&db, &acct).map_err(internal)?;
    Ok(Json(json!({ "account_id": acct, "salt": salt, "plan": "beta" })))
}

async fn delete_account(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    let db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    db.execute("DELETE FROM docs WHERE account=?1", params![acct]).map_err(internal)?;
    db.execute("DELETE FROM tokens WHERE account=?1", params![acct]).map_err(internal)?;
    db.execute("DELETE FROM accounts WHERE id=?1", params![acct]).map_err(internal)?;
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
}

const KINDS: [&str; 5] = ["task", "note", "labels", "routines", "keycheck"];

async fn sync(State(app): State<App>, headers: HeaderMap, Json(body): Json<SyncReq>) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    if body.protocol != PROTOCOL {
        return Err(bad("unsupported protocol"));
    }
    if !allow(&app, &format!("sync:{token}"), 60, Duration::from_secs(60)) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    let mut db = app.db.lock().unwrap();
    let acct = account_for(&db, &token).map_err(internal)?.ok_or_else(unauthorized)?;
    let now = now_ms();
    let mut pushed: Vec<String> = Vec::new();
    let tx = db.transaction().map_err(internal)?;
    for d in &body.docs {
        if d.id.is_empty() || d.id.len() > 128 || !KINDS.contains(&d.kind.as_str()) || d.ct.len() > MAX_CT_B64 || d.updated_at > now + FUTURE_MS {
            continue;
        }
        let stored: Option<i64> = tx
            .query_row("SELECT updated_at FROM docs WHERE account=?1 AND id=?2", params![acct, d.id], |r| r.get(0))
            .optional()
            .map_err(internal)?;
        if let Some(u) = stored {
            if u > d.updated_at {
                continue; // the stored version is newer; it will come back in the pull
            }
        }
        tx.execute("UPDATE accounts SET seq=seq+1 WHERE id=?1", params![acct]).map_err(internal)?;
        let seq: i64 = tx.query_row("SELECT seq FROM accounts WHERE id=?1", params![acct], |r| r.get(0)).map_err(internal)?;
        tx.execute(
            "INSERT OR REPLACE INTO docs(account,id,kind,updated_at,deleted,nonce,ct,seq,device_id,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![acct, d.id, d.kind, d.updated_at, d.deleted as i64, d.nonce, if d.deleted { "" } else { d.ct.as_str() }, seq, body.device_id, now],
        )
        .map_err(internal)?;
        pushed.push(d.id.clone());
    }
    let mut out = Vec::new();
    let mut last_seq = body.cursor;
    let mut count = 0i64;
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
            count += 1;
            if count > PAGE {
                break;
            }
            last_seq = seq;
            if pushed.contains(&id) {
                continue;
            }
            out.push(json!({ "id": id, "kind": kind, "updated_at": updated_at, "deleted": deleted != 0, "nonce": nonce, "ct": ct, "seq": seq }));
        }
    }
    let more = count > PAGE;
    if count == 0 {
        let seq: i64 = tx.query_row("SELECT seq FROM accounts WHERE id=?1", params![acct], |r| r.get(0)).map_err(internal)?;
        last_seq = body.cursor.max(seq);
    }
    tx.commit().map_err(internal)?;
    Ok(Json(json!({ "protocol": PROTOCOL, "cursor": last_seq, "docs": out, "more": more })))
}

/// Landing page for the email button: shows the code large with a copy button and tries the app's deep link.
async fn signin_page(Query(q): Query<HashMap<String, String>>) -> Html<String> {
    let code: String = q.get("code").map(|c| c.chars().filter(|ch| ch.is_ascii_digit()).take(6).collect()).unwrap_or_default();
    let shown = if code.len() == 6 { pretty_code(&code) } else { "no code".to_string() };
    Html(format!(r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sundial sign-in</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0C0B;color:#E9ECE2;font-family:'Segoe UI',Helvetica,Arial,sans-serif}}
.card{{width:min(440px,calc(100% - 32px));background:#121412;border:1px solid #262B24;border-radius:20px;padding:28px 30px;box-shadow:0 30px 80px -30px #000}}
.brand{{font-family:'Courier New',monospace;font-size:12px;letter-spacing:.22em;color:#D1FF4A;font-weight:bold}}h1{{font-size:22px;margin:10px 0 14px}}
.code{{display:inline-block;background:#0B0C0B;border:1px solid #2A3027;border-radius:14px;padding:16px 24px;font-family:'Courier New',monospace;font-size:38px;letter-spacing:.22em;color:#D1FF4A;font-weight:bold;user-select:all}}
p{{color:#9BA392;font-size:14px;line-height:1.55}}.row{{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}}
button,a.btn{{font:inherit;font-weight:bold;font-size:14px;border-radius:999px;padding:11px 20px;cursor:pointer;text-decoration:none;border:1px solid #2A3027;background:#1B2117;color:#E9ECE2}}
.primary{{background:#D1FF4A;color:#0B0D06;border-color:transparent}}small{{color:#7E8679;font-size:12px;display:block;margin-top:18px;line-height:1.5}}</style></head>
<body><div class="card"><div class="brand">&#9680;&nbsp; SUNDIAL</div><h1>Your sign-in code</h1><div class="code" id="c">{shown}</div>
<p>Type it into Sundial within 10 minutes, or copy it.</p>
<div class="row"><button class="primary" id="cp">Copy code</button><a class="btn" href="sundial://signin?code={code}">Open Sundial</a></div>
<small>If you didn&#8217;t ask for this, close this page; nothing happens without the code.</small></div>
<script>document.getElementById('cp').onclick=function(){{navigator.clipboard.writeText('{code}').then(function(){{document.getElementById('cp').textContent='Copied'}},function(){{}})}}</script></body></html>"##))
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
        db: Arc::new(Mutex::new(db)),
        hosted,
        limits: Arc::new(Mutex::new(HashMap::new())),
        resend_key: std::env::var("RESEND_API_KEY").ok().filter(|s| !s.is_empty()),
        from: std::env::var("SUNDIAL_FROM").unwrap_or_else(|_| "Sundial <sign-in@sundial.services>".into()),
        public_url: std::env::var("SUNDIAL_PUBLIC_URL").unwrap_or_else(|_| "https://sync.sundial.services".into()).trim_end_matches('/').to_string(),
        http: reqwest::Client::new(),
    };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/auth/request", post(auth_request))
        .route("/v1/auth/verify", post(auth_verify))
        .route("/v1/account", get(account).delete(delete_account))
        .route("/v1/sync", post(sync))
        .route("/signin", get(signin_page))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(cors)
        .with_state(app);
    let bind: SocketAddr = std::env::var("SUNDIAL_BIND").unwrap_or_else(|_| "127.0.0.1:8768".into()).parse().expect("SUNDIAL_BIND");
    tracing::info!("Sundial Sync {} on http://{} mode={} db={}", env!("CARGO_PKG_VERSION"), bind, if hosted { "hosted" } else { "self" }, db_path);
    let listener = tokio::net::TcpListener::bind(bind).await.expect("bind");
    axum::serve(listener, router)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await
        .expect("server");
}
