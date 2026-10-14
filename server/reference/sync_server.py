"""Reference Sundial Sync server (protocol v1), standard library only.

For local testing and as the executable spec of docs/SYNC-PROTOCOL.md. The production server is the Rust one
in ../src; both must behave identically. Self-hosted mode out of the box:

    python sync_server.py --port 8768 --db sundial-sync.sqlite --token my-secret-token

Hosted mode (sign-in codes are printed to the console instead of emailed):

    python sync_server.py --hosted
"""
import argparse, base64, json, os, secrets, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = 1
VERSION = "0.1.0-ref"
PAGE = 500
MAX_CT = 64 * 1024
FUTURE_MS = 24 * 3600 * 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, account TEXT NOT NULL, device_id TEXT, device_name TEXT, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS docs(account TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL,
  nonce TEXT NOT NULL, ct TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT, received_at INTEGER NOT NULL, PRIMARY KEY(account, id));
CREATE INDEX IF NOT EXISTS docs_seq ON docs(account, seq);
"""

lock = threading.Lock()

def b64rand(n): return base64.b64encode(secrets.token_bytes(n)).decode()
def now_ms(): return int(time.time() * 1000)

class Store:
    def __init__(self, path, hosted, tokens):
        self.hosted, self.tokens = hosted, tokens
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        if not hosted:
            # self-hosted: every configured token is its own account (so a household can share one server)
            for t in tokens:
                self.db.execute("INSERT OR IGNORE INTO accounts(id,email,salt,created_at) VALUES(?,?,?,?)", ("acct_" + t[:8], None, b64rand(32), now_ms()))
                self.db.execute("INSERT OR IGNORE INTO tokens(token,account,created_at) VALUES(?,?,?)", (t, "acct_" + t[:8], now_ms()))
            self.db.commit()

    def account_for(self, token):
        row = self.db.execute("SELECT account FROM tokens WHERE token=?", (token,)).fetchone()
        if row: self.db.execute("UPDATE tokens SET last_seen=? WHERE token=?", (now_ms(), token))
        return row[0] if row else None

    def salt(self, account):
        return self.db.execute("SELECT salt FROM accounts WHERE id=?", (account,)).fetchone()[0]

    def request_code(self, email):
        code = "%06d" % secrets.randbelow(1_000_000)
        self.db.execute("INSERT OR REPLACE INTO codes(email,code,expires,tries) VALUES(?,?,?,0)", (email, code, now_ms() + 600_000))
        self.db.commit()
        print(f"[sign-in] {email}: code {code}  (link: sundial://signin?email={email}&code={code})", flush=True)

    def verify(self, email, code, device):
        row = self.db.execute("SELECT code,expires,tries FROM codes WHERE email=?", (email,)).fetchone()
        if not row or row[1] < now_ms() or row[2] >= 5: return None
        if not secrets.compare_digest(row[0], str(code)):
            self.db.execute("UPDATE codes SET tries=tries+1 WHERE email=?", (email,)); self.db.commit(); return None
        self.db.execute("DELETE FROM codes WHERE email=?", (email,))
        acct = self.db.execute("SELECT id FROM accounts WHERE email=?", (email,)).fetchone()
        if acct: account = acct[0]
        else:
            account = "acct_" + secrets.token_hex(8)
            self.db.execute("INSERT INTO accounts(id,email,salt,created_at) VALUES(?,?,?,?)", (account, email, b64rand(32), now_ms()))
        token = "st_" + secrets.token_urlsafe(32)
        self.db.execute("INSERT INTO tokens(token,account,device_id,device_name,platform,created_at) VALUES(?,?,?,?,?,?)",
                        (token, account, device.get("id"), device.get("name"), device.get("platform"), now_ms()))
        self.db.commit()
        return {"token": token, "account_id": account, "salt": self.salt(account)}

    def sync(self, account, device_id, cursor, docs):
        pushed = set()
        t = now_ms()
        for d in docs:
            if not isinstance(d, dict): continue
            did, kind = str(d.get("id", "")), str(d.get("kind", ""))
            up = int(d.get("updated_at", 0)); deleted = bool(d.get("deleted")); nonce = str(d.get("nonce", "")); ct = str(d.get("ct", ""))
            if not did or kind not in ("task", "note", "labels", "routines", "keycheck") or len(ct) > MAX_CT * 4 // 3 + 4 or up > t + FUTURE_MS: continue
            cur = self.db.execute("SELECT updated_at FROM docs WHERE account=? AND id=?", (account, did)).fetchone()
            if cur and cur[0] > up: continue
            self.db.execute("UPDATE accounts SET seq=seq+1 WHERE id=?", (account,))
            seq = self.db.execute("SELECT seq FROM accounts WHERE id=?", (account,)).fetchone()[0]
            self.db.execute("INSERT OR REPLACE INTO docs(account,id,kind,updated_at,deleted,nonce,ct,seq,device_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (account, did, kind, up, 1 if deleted else 0, nonce, "" if deleted else ct, seq, device_id, t))
            pushed.add(did)
        rows = self.db.execute("SELECT id,kind,updated_at,deleted,nonce,ct,seq FROM docs WHERE account=? AND seq>? ORDER BY seq LIMIT ?",
                               (account, int(cursor), PAGE + 1)).fetchall()
        more = len(rows) > PAGE
        rows = rows[:PAGE]
        out = [{"id": r[0], "kind": r[1], "updated_at": r[2], "deleted": bool(r[3]), "nonce": r[4], "ct": r[5], "seq": r[6]} for r in rows if r[0] not in pushed]
        new_cursor = rows[-1][6] if rows else self.db.execute("SELECT seq FROM accounts WHERE id=?", (account,)).fetchone()[0]
        if not rows: new_cursor = max(int(cursor), new_cursor)
        self.db.commit()
        return {"protocol": PROTOCOL, "cursor": new_cursor, "docs": out, "more": more}

    def delete_account(self, account):
        self.db.execute("DELETE FROM docs WHERE account=?", (account,)); self.db.execute("DELETE FROM tokens WHERE account=?", (account,))
        self.db.execute("DELETE FROM accounts WHERE id=?", (account,)); self.db.commit()

class Handler(BaseHTTPRequestHandler):
    store: Store = None
    def log_message(self, fmt, *args):  # no request bodies, no full IPs
        ip = self.client_address[0]; ip = ".".join(ip.split(".")[:3]) + ".0" if "." in ip else ip
        sys.stderr.write("%s %s %s\n" % (ip, self.command, self.path.split("?")[0]))
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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
    def _auth(self):
        h = self.headers.get("Authorization", "")
        return self.store.account_for(h[7:].strip()) if h.startswith("Bearer ") else None
    def do_OPTIONS(self): self._json(204)
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/v1/health": return self._json(200, {"ok": True, "version": VERSION, "mode": "hosted" if self.store.hosted else "self", "protocol": PROTOCOL})
        if p == "/v1/account":
            with lock:
                a = self._auth()
                if not a: return self._json(401, {"error": "unauthorized"})
                return self._json(200, {"account_id": a, "salt": self.store.salt(a)})
        self._json(404, {"error": "not found"})
    def do_DELETE(self):
        if self.path.split("?")[0] != "/v1/account": return self._json(404, {"error": "not found"})
        with lock:
            a = self._auth()
            if not a: return self._json(401, {"error": "unauthorized"})
            self.store.delete_account(a); self._json(204)
    def do_POST(self):
        p = self.path.split("?")[0]
        try: body = self._body()
        except Exception: return self._json(400, {"error": "bad json"})
        with lock:
            if p == "/v1/auth/request":
                if not self.store.hosted: return self._json(404, {"error": "self-hosted server: use the token"})
                email = str(body.get("email", "")).strip().lower()
                if "@" in email: self.store.request_code(email)
                return self._json(204)
            if p == "/v1/auth/verify":
                if not self.store.hosted: return self._json(404, {"error": "self-hosted server: use the token"})
                r = self.store.verify(str(body.get("email", "")).strip().lower(), body.get("code", ""), body.get("device") or {})
                return self._json(200, r) if r else self._json(401, {"error": "wrong or expired code"})
            if p == "/v1/sync":
                a = self._auth()
                if not a: return self._json(401, {"error": "unauthorized"})
                if int(body.get("protocol", 0)) != PROTOCOL: return self._json(400, {"error": "unsupported protocol"})
                return self._json(200, self.store.sync(a, str(body.get("device_id", "")), body.get("cursor", 0), body.get("docs") or []))
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
