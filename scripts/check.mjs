// `npm run demo:check`: is everything up? Checks the server, console and headset (self-signed
// HTTPS accepted) and the headset's proxy to the server. Sends no report, changes nothing.
import https from "node:https";
import { printUrls } from "./urls.mjs";

/** GET -> { statusCode, body } or { error }. https.get so the self-signed cert can be accepted. */
const get = (url) =>
  new Promise((resolve) => {
    if (url.startsWith("http:")) {
      return fetch(url, { signal: AbortSignal.timeout(5000) })
        .then(async (r) => resolve({ statusCode: r.status, body: await r.text() }))
        .catch((e) => resolve({ error: e.cause?.code ?? e.message }));
    }
    const req = https.get(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d)).on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ error: e.code ?? e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });

const headset = !process.argv.includes("--no-headset");
const checks = [
  ["server  /health", "http://localhost:8080/health", (r) => r.body],
  ["console :5173 ", "http://localhost:5173/", (r) => `HTTP ${r.statusCode}`],
  ...(headset
    ? [
        ["headset :8081 ", "https://localhost:8081/", (r) => `HTTP ${r.statusCode}`],
        ["headset proxy ", "https://localhost:8081/fs-api/health", (r) => r.body],
      ]
    : []),
];
let bad = 0;
for (const [label, url, show] of checks) {
  const r = await get(url);
  const ok = !r.error && r.statusCode === 200;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} ${r.error ? r.error : show(r)}`);
}
printUrls({ headset });
process.exitCode = bad ? 1 : 0; // not process.exit(): it can trip a libuv assert on Windows
