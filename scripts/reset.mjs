// `npm run demo:reset`: clear the incident between judges (works in any shell, unlike curl in
// Windows PowerShell). Live mode: POST /live/reset. Mock mode: also restarts the scripted calls.
const SERVER = process.env.SERVER_URL ?? "http://localhost:8080";
const post = (p) => fetch(`${SERVER}${p}`, { method: "POST" }).then((r) => r.json());
try {
  const health = await fetch(`${SERVER}/health`).then((r) => r.json());
  console.log("reset:", JSON.stringify(await post("/live/reset")));
  if (health.mock) console.log("mock replay:", JSON.stringify(await post("/mock/replay")));
} catch (err) {
  console.error(`Could not reach the server at ${SERVER}: ${err.cause?.code ?? err.message}. Is \`npm run demo\` running?`);
  process.exitCode = 1;
}
