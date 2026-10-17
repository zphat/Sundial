"""Reference Sundial Sync server (protocol v1), standard library only.

For local testing and as the executable spec of docs/SYNC-PROTOCOL.md. The production server is the Rust one
in ../src; both behave the same on the wire (this one skips the per-IP limits and has no email provider, so the
503 "email could not be sent" case never happens here). Self-hosted mode out of the box:

    python sync_server.py --port 8768 --db sundial-sync.sqlite --token my-secret-token

Hosted mode (sign-in codes are printed to the console instead of emailed):

    python sync_server.py --hosted
"""
import argparse, base64, hashlib, json, os, secrets, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = 1
VERSION = "0.1.3-ref"
PAGE = 500
MAX_CT = 64 * 1024
FUTURE_MS = 24 * 3600 * 1000
QUOTA = 50 * 1024 * 1024                      # ciphertext one account may hold in total
LOCK_FAILS, LOCK_MS = 10, 24 * 3600 * 1000    # wrong codes that lock an address, and for how long
KINDS = ("task", "note", "labels", "routines", "keycheck", "pair")
# Browsers: only the desktop app's webview and the local preview may call the API. SUNDIAL_ORIGINS=a,b adds more.
ORIGINS = {"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:8767", "http://127.0.0.1:8767", "http://localhost:8000", "http://127.0.0.1:8000"}
ORIGINS |= {o.strip() for o in os.environ.get("SUNDIAL_ORIGINS", "").split(",") if o.strip()}

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, account TEXT NOT NULL, device_id TEXT, device_name TEXT, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, hashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_fails(email TEXT PRIMARY KEY, fails INTEGER NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(account TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL,
  nonce TEXT NOT NULL, ct TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT, received_at INTEGER NOT NULL, PRIMARY KEY(account, id));
CREATE INDEX IF NOT EXISTS docs_seq ON docs(account, seq);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(key,value) VALUES('epoch',1);
"""

lock = threading.Lock()

class ApiErr(Exception):
    """An error the client sees: HTTP status plus the message in {"error": ...}."""
    def __init__(self, code, msg): super().__init__(msg); self.code, self.msg = code, msg

def b64rand(n): return base64.b64encode(secrets.token_bytes(n)).decode()
def now_ms(): return int(time.time() * 1000)
def thash(t): return hashlib.sha256(t.encode()).hexdigest()   # tokens are stored hashed; the DB signs nobody in

class Store:
    def __init__(self, path, hosted, tokens):
        self.hosted, self.tokens = hosted, tokens
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        if "hashed" not in [r[1] for r in self.db.execute("PRAGMA table_info(tokens)")]:   # databases from before 0.1.3
            self.db.execute("ALTER TABLE tokens ADD COLUMN hashed INTEGER NOT NULL DEFAULT 0")
        # every configured token is its own account (so a household can share one server); accepted in both modes
        for t in tokens:
            acct = "acct_" + t[:8]
            self.db.execute("INSERT OR IGNORE INTO accounts(id,email,salt,created_at) VALUES(?,?,?,?)", (acct, None, b64rand(32), now_ms()))
            self.db.execute("UPDATE OR REPLACE tokens SET token=?, hashed=1 WHERE token=? AND hashed=0", (thash(t), t))  # pre-0.1.3 row
            self.db.execute("INSERT OR IGNORE INTO tokens(token,account,created_at,hashed) VALUES(?,?,?,1)", (thash(t), acct, now_ms()))
        self.db.commit()

    def account_for(self, token):
        h = thash(token)
        row = self.db.execute("SELECT account FROM tokens WHERE token=? AND hashed=1", (h,)).fetchone()
        if not row:   # a row from before 0.1.3 holds the token itself: accept it once and rewrite it to the hash
            row = self.db.execute("SELECT account FROM tokens WHERE token=? AND hashed=0", (token,)).fetchone()
            if row: self.db.execute("UPDATE OR REPLACE tokens SET token=?, hashed=1 WHERE token=? AND hashed=0", (h, token))
        if row: self.db.execute("UPDATE tokens SET last_seen=? WHERE token=?", (now_ms(), h)); self.db.commit()
        return row[0] if row else None

    def logout(self, token):
        self.db.execute("DELETE FROM tokens WHERE (token=? AND hashed=1) OR (token=? AND hashed=0)", (thash(token), token)); self.db.commit()

    def salt(self, account):
        return self.db.execute("SELECT salt FROM accounts WHERE id=?", (account,)).fetchone()[0]

    def email_of(self, account):
        row = self.db.execute("SELECT email FROM accounts WHERE id=?", (account,)).fetchone()
        return row[0] if row else None

    def request_code(self, email):
        row = self.db.execute("SELECT code,expires FROM codes WHERE email=?", (email,)).fetchone()
        if row and row[1] > now_ms():   # still valid: the same code goes out again with a fresh 10 minutes, the first email keeps working
            code = row[0]; self.db.execute("UPDATE codes SET expires=? WHERE email=?", (now_ms() + 600_000, email)); self.db.commit()
        else:
            code = "%06d" % secrets.randbelow(1_000_000)
            self.db.execute("INSERT OR REPLACE INTO codes(email,code,expires,tries) VALUES(?,?,?,0)", (email, code, now_ms() + 600_000)); self.db.commit()
        print(f"[sign-in] {email}: code {code}  (link: sundial://signin?email={email}&code={code})", flush=True)

    def check_code(self, email, typed):
        """401 for a wrong, missing or expired code; 429 while the address is locked (10 failures lock it for 24 h)."""
        now = now_ms()
        self.db.execute("DELETE FROM auth_fails WHERE since < ?", (now - LOCK_MS,))
        fails = self.db.execute("SELECT fails,since FROM auth_fails WHERE email=?", (email,)).fetchone()
        if fails and fails[0] >= LOCK_FAILS and now - fails[1] < LOCK_MS: raise ApiErr(429, "too many attempts, try later")
        row = self.db.execute("SELECT code,expires FROM codes WHERE email=?", (email,)).fetchone()
        typed = "".join(c for c in str(typed) if c in "0123456789")
        ok = bool(row) and row[1] >= now and secrets.compare_digest(row[0], typed)
        if not ok:
            if not row: self.db.commit(); raise ApiErr(401, "wrong or expired code")   # nothing to guess: no failure counted, nobody can lock a stranger out
            f, since = (fails[0] + 1, fails[1]) if fails and now - fails[1] < LOCK_MS else (1, now)
            if f >= LOCK_FAILS: since = now   # the lock lasts 24 h from the failure that triggered it
            self.db.execute("INSERT OR REPLACE INTO auth_fails(email,fails,since) VALUES(?,?,?)", (email, f, since))
            self.db.execute("UPDATE codes SET tries=tries+1 WHERE email=?", (email,))
            self.db.commit(); raise ApiErr(401, "wrong or expired code")
        self.db.execute("DELETE FROM codes WHERE email=?", (email,)); self.db.execute("DELETE FROM auth_fails WHERE email=?", (email,))

    def verify(self, email, code, device):
        if "@" not in email or len(email) > 254: raise ApiErr(401, "wrong or expired code")
        self.check_code(email, code)
        acct = self.db.execute("SELECT id FROM accounts WHERE email=?", (email,)).fetchone()
        if acct: account = acct[0]
        else:
            account = "acct_" + secrets.token_hex(8)
            self.db.execute("INSERT INTO accounts(id,email,salt,created_at) VALUES(?,?,?,?)", (account, email, b64rand(32), now_ms()))
        token = "st_" + secrets.token_urlsafe(32)
        self.db.execute("INSERT INTO tokens(token,account,device_id,device_name,platform,created_at,hashed) VALUES(?,?,?,?,?,?,1)",
                        (thash(token), account, device.get("id"), device.get("name"), device.get("platform"), now_ms()))
        self.db.commit()
        return {"token": token, "account_id": account, "salt": self.salt(account), "plan": "beta"}

    def sync(self, account, device_id, cursor, docs):
        pushed, rejected = set(), []
        t = now_ms()
        used = self.db.execute("SELECT COALESCE(SUM(LENGTH(ct)),0) FROM docs WHERE account=?", (account,)).fetchone()[0] if docs else 0
        for d in docs:
            if not isinstance(d, dict): continue
            did, kind = str(d.get("id", "")), str(d.get("kind", ""))
            up = int(d.get("updated_at", 0)); deleted = bool(d.get("deleted")); nonce = str(d.get("nonce", "")); ct = str(d.get("ct", ""))
            reason = ("id" if not did or len(did) > 128 else "kind" if kind not in KINDS else "size" if len(ct) > MAX_CT * 4 // 3 + 8
                      else "future" if up > t + FUTURE_MS else None)
            if reason: rejected.append({"id": did[:128], "kind": kind[:32], "reason": reason}); continue
            cur = self.db.execute("SELECT updated_at, LENGTH(ct) FROM docs WHERE account=? AND id=?", (account, did)).fetchone()
            if cur and kind == "keycheck" and not deleted: rejected.append({"id": did, "kind": kind, "reason": "exists"}); continue   # the key is set once
            if cur and cur[0] > up: continue   # the stored version is newer; it comes back in the pull
            if deleted: ct = ""
            nxt = used - (cur[1] if cur else 0) + len(ct)
            if nxt > QUOTA: rejected.append({"id": did, "kind": kind, "reason": "quota"}); continue
            used = nxt
            self.db.execute("UPDATE accounts SET seq=seq+1 WHERE id=?", (account,))
            seq = self.db.execute("SELECT seq FROM accounts WHERE id=?", (account,)).fetchone()[0]
            self.db.execute("INSERT OR REPLACE INTO docs(account,id,kind,updated_at,deleted,nonce,ct,seq,device_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (account, did, kind, up, 1 if deleted else 0, nonce, ct, seq, device_id, t))
            pushed.add(did)
        rows = self.db.execute("SELECT id,kind,updated_at,deleted,nonce,ct,seq FROM docs WHERE account=? AND seq>? ORDER BY seq LIMIT ?",
                               (account, int(cursor), PAGE + 1)).fetchall()
        more = len(rows) > PAGE
        rows = rows[:PAGE]
        out = [{"id": r[0], "kind": r[1], "updated_at": r[2], "deleted": bool(r[3]), "nonce": r[4], "ct": r[5], "seq": r[6]} for r in rows if r[0] not in pushed]
        # nothing newer: the account's real position, even when that is below the cursor sent (restore from backup)
        new_cursor = rows[-1][6] if rows else self.db.execute("SELECT seq FROM accounts WHERE id=?", (account,)).fetchone()[0]
        epoch = self.db.execute("SELECT value FROM meta WHERE key='epoch'").fetchone()[0]
        self.db.commit()
        return {"protocol": PROTOCOL, "cursor": new_cursor, "docs": out, "more": more, "epoch": epoch, "rejected": rejected}

    def delete_account(self, account):
        self.db.execute("DELETE FROM docs WHERE account=?", (account,)); self.db.execute("DELETE FROM tokens WHERE account=?", (account,))
        self.db.execute("DELETE FROM accounts WHERE id=?", (account,)); self.db.commit()

class Handler(BaseHTTPRequestHandler):
    store: Store = None
    def log_message(self, fmt, *args):  # no request bodies, no full IPs
        ip = self.client_address[0]; ip = ".".join(ip.split(".")[:3]) + ".0" if "." in ip else ip
        sys.stderr.write("%s %s %s\n" % (ip, self.command, self.path.split("?")[0]))
    def _cors(self):
        o = self.headers.get("Origin", "")
        if o in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", o); self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "authorization, content-type"); self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    def _json(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code); self._cors()
        if body: self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body: self.wfile.write(body)
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 8 * 1024 * 1024: raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")
    def _token(self):
        h = self.headers.get("Authorization", "")
        return h[7:].strip() if h.startswith("Bearer ") else ""
    def _auth(self):
        t = self._token()
        return self.store.account_for(t) if t else None
    def do_OPTIONS(self): self._json(204)
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/v1/health": return self._json(200, {"ok": True, "version": VERSION, "mode": "hosted" if self.store.hosted else "self", "protocol": PROTOCOL})
        if p == "/v1/account":
            with lock:
                a = self._auth()
                if not a: return self._json(401, {"error": "unauthorized"})
                return self._json(200, {"account_id": a, "salt": self.store.salt(a), "plan": "beta"})
        self._json(404, {"error": "not found"})
    def do_DELETE(self):
        if self.path.split("?")[0] != "/v1/account": return self._json(404, {"error": "not found"})
        try: body = self._body()
        except Exception: body = {}
        with lock:
            try:
                a = self._auth()
                if not a: return self._json(401, {"error": "unauthorized"})
                email = self.store.email_of(a)
                if self.store.hosted and email:   # a hosted account also needs a fresh sign-in code for its address
                    code = str(body.get("code", "")) if isinstance(body, dict) else ""
                    if not code.strip(): return self._json(400, {"error": 'a fresh sign-in code is required: {"code":"123456"}'})
                    self.store.check_code(email, code)
                self.store.delete_account(a); self._json(204)
            except ApiErr as e: self._json(e.code, {"error": e.msg})
    def do_POST(self):
        p = self.path.split("?")[0]
        try: body = self._body()
        except Exception: return self._json(400, {"error": "bad json"})
        if not isinstance(body, dict): body = {}
        with lock:
            try:
                if p == "/v1/auth/request":
                    if not self.store.hosted: return self._json(404, {"error": "self-hosted server: use the token"})
                    email = str(body.get("email", "")).strip().lower()
                    if "@" in email and len(email) <= 254: self.store.request_code(email)
                    return self._json(204)   # a malformed address is 204 too: nothing is revealed about addresses
                if p == "/v1/auth/verify":
                    if not self.store.hosted: return self._json(404, {"error": "self-hosted server: use the token"})
                    return self._json(200, self.store.verify(str(body.get("email", "")).strip().lower(), body.get("code", ""), body.get("device") or {}))
                if p == "/v1/auth/logout":
                    t = self._token()
                    if not t: return self._json(401, {"error": "unauthorized"})
                    self.store.logout(t); return self._json(204)
                if p == "/v1/sync":
                    a = self._auth()
                    if not a: return self._json(401, {"error": "unauthorized"})
                    if int(body.get("protocol", 0)) != PROTOCOL: return self._json(400, {"error": "unsupported protocol"})
                    return self._json(200, self.store.sync(a, str(body.get("device_id", "")), body.get("cursor", 0), body.get("docs") or []))
            except ApiErr as e: return self._json(e.code, {"error": e.msg})
        self._json(404, {"error": "not found"})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("SUNDIAL_PORT", 8768)))
    ap.add_argument("--bind", default=os.environ.get("SUNDIAL_BIND", "127.0.0.1"))
    ap.add_argument("--db", default=os.environ.get("SUNDIAL_DB", "sundial-sync.sqlite"))
    ap.add_argument("--hosted", action="store_true", help="email sign-in mode (codes print to the console here)")
    ap.add_argument("--token", action="append", default=None, help="self-hosted token (repeatable); or SUNDIAL_TOKENS=a,b")
    a = ap.parse_args()
    tokens = a.token or [t for t in os.environ.get("SUNDIAL_TOKENS", "").split(",") if t] or ["dev-token"]
    Handler.store = Store(a.db, a.hosted, tokens)
    print(f"Sundial Sync reference server on http://{a.bind}:{a.port}  mode={'hosted' if a.hosted else 'self'}  db={a.db}", flush=True)
    if not a.hosted: print("tokens:", ", ".join(tokens), flush=True)
    ThreadingHTTPServer((a.bind, a.port), Handler).serve_forever()

if __name__ == "__main__":
    main()
