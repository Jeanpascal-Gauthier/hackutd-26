// Load before the app and agent modules, including when launched without CLI env-file flags.
// Resolve from this module so the launcher's working directory cannot select another .env.
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(new URL("../../.env", import.meta.url));
} catch (error) {
  // A missing .env is valid for the scripted demo or deployment with environment variables.
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}
