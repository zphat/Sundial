// Drives a page of the test copy (tools/selftest/run.sh) over WebView2's DevTools port. Needs deno.
//   deno run -A tools/selftest/cdp.js <port> list
//   deno run -A tools/selftest/cdp.js <port> <url-part | =exact-url> <file-with-js> [listen-ms]
// The file is run as the body of an async function inside the page; what it returns is printed as JSON, followed by
// every console message, log entry (Content-Security-Policy violations land here) and exception seen while it ran
// and for listen-ms after. The main page is "=http://tauri.localhost/"; the corner toast is "toast.html".
const [port, filter, file, listenMs] = Deno.args;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (filter === "list" || !file) {
  for (const t of list) console.log(t.type, "|", t.title, "|", t.url);
  Deno.exit(0);
}
// "=url" asks for that exact address (the main page, not toast.html beside it)
const target = list.find((t) => t.type === "page" && (filter.startsWith("=") ? t.url === filter.slice(1) : t.url.includes(filter)));
if (!target) {
  console.log("NO TARGET matching", filter, "among", list.map((t) => t.url));
  Deno.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
const seen = [];
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled") {
    seen.push("console." + m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 400));
  } else if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    seen.push("log." + e.level + " [" + e.source + "]: " + String(e.text).slice(0, 500) + (e.url ? " @ " + e.url : ""));
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    seen.push("exception: " + (d.exception?.description || d.text).slice(0, 400));
  }
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
await send("Runtime.enable");
await send("Log.enable");
const body = await Deno.readTextFile(file);
const r = await send("Runtime.evaluate", {
  expression: `(async()=>{${body}\n})()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: false,
});
const res = r.result || {};
if (res.exceptionDetails) console.log("EVAL EXCEPTION:", res.exceptionDetails.exception?.description || res.exceptionDetails.text);
else console.log("RESULT:", JSON.stringify(res.result?.value, null, 1));
await new Promise((x) => setTimeout(x, Number(listenMs || 300)));
console.log("SEEN (" + seen.length + "):");
for (const s of seen) console.log("  " + s);
ws.close();
Deno.exit(0);
