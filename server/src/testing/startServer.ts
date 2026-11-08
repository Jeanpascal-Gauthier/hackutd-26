// Starts `src/index.ts` in a child process for the verify scripts, the same way on every OS.
// It runs the current Node binary with tsx loaded (`node --import tsx`), so there is no npx,
// no .cmd shim and no shell: spawn works on Windows, and kill() stops the server itself.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The verify port: VERIFY_PORT if set (so two runs can share a machine), else `fallback`. */
export const verifyPort = (fallback: number) => Number(process.env.VERIFY_PORT || fallback);

/**
 * Starts the server on `port` with extra `env` and waits until GET /health answers.
 * The child is killed when this process exits or gets Ctrl-C / SIGTERM.
 */
export async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const base = `http://localhost:${port}`;
  if (await healthy(base)) throw new Error(`port ${port} is already in use; set VERIFY_PORT to another port`);

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const stop = () => void child.kill();
  process.once("exit", stop);
  process.once("SIGINT", () => (stop(), process.exit(130)));
  process.once("SIGTERM", () => (stop(), process.exit(143)));

  let exited = false;
  child.once("exit", () => (exited = true));
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
    if (exited) throw new Error(`server exited before it was ready:\n${stderr}`);
    if (await healthy(base)) return child;
  }
  stop();
  throw new Error(`server did not answer ${base}/health within 10 s:\n${stderr}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthy(base: string) {
  try {
    return (await fetch(base + "/health")).ok;
  } catch {
    return false; // not up yet
  }
}
