// Runs one command for scripts/demo.mjs so that it can't take the whole demo down:
// optionally waits before starting, retries if it exits with an error, and after the last try
// stays idle (printing why) instead of exiting, because demo.mjs stops everything when any
// process exits.
//
//   node scripts/keep-alive.mjs [--delay ms] [--tries n] [--name label] -- <command...>
//
// Used for the headset: its IWSDK dev plugin asks powershell.exe for the process start time with
// a 1.5 s timeout, which Windows PowerShell can miss when several dev servers start at once
// ("RuntimeOwnerError: Cannot establish this process birth identity"). A later start, or a retry,
// gets through.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep < 0 || sep === args.length - 1) {
  console.error("usage: node scripts/keep-alive.mjs [--delay ms] [--tries n] [--name label] -- <command...>");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i < sep ? args[i + 1] : fallback;
};
const delay = Number(opt("--delay", "0"));
const tries = Math.max(1, Number(opt("--tries", "3")));
const name = opt("--name", "process");
const command = args.slice(sep + 1).join(" ");

let child;
let stopping = false;
const stop = () => {
  stopping = true;
  if (child && child.exitCode === null) child.kill();
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 3000).unref(); // in case the child ignores it
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (delay > 0) {
  console.log(`[keep-alive] starting ${name} in ${Math.round(delay / 1000)} s (after the other servers)`);
  await sleep(delay);
}

for (let attempt = 1; attempt <= tries && !stopping; attempt++) {
  // shell: true so `npm run ...` resolves to npm.cmd on Windows.
  child = spawn(command, { stdio: "inherit", shell: true, env: process.env });
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0)));
  if (stopping) break;
  if (code === 0) {
    console.log(`[keep-alive] ${name} exited`);
    break;
  }
  if (attempt < tries) {
    console.error(`[keep-alive] ${name} exited with code ${code}; retrying (${attempt + 1}/${tries}) in 3 s`);
    await sleep(3000);
  } else {
    console.error(
      `[keep-alive] ${name} failed ${tries} times; it is OFF. Everything else keeps running.\n` +
        `[keep-alive]   Start it by hand in a second terminal: cd headset && npm run dev:runtime`,
    );
  }
}

// Stay alive (idle) so demo.mjs doesn't treat this as a crash and stop the other servers.
if (!stopping) await new Promise(() => setInterval(() => {}, 1 << 30));
