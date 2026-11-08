// Registers a person on FireSight's shared iMessage line (Photon 2.0), so they can text reports.
//
//   npm run photon:assign -- "+1 415 555 0123" --first Ada --last Lovelace   # uses one seat (reused if already registered)
//   npm run photon:assign -- someone@icloud.com
//   npm run photon:assign -- --list                                          # read-only: who is registered
//
// (From agent/: npm run photon:assign -w agent -- ...) Needs PHOTON_PROJECT_ID + PHOTON_API_KEY in the root .env.
import { parseArgs } from "node:util";
import { assignApiFromEnv, assignHandle, formatHandle, listAssignments, normalizeHandle } from "./assign.ts";

const USAGE = `Usage:
  npm run photon:assign -- <phone-or-email> [--first Name] [--last Name]
  npm run photon:assign -- --list`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      first: { type: "string" },
      last: { type: "string" },
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  fail(`${(err as Error).message}\n${USAGE}`);
}
const { values, positionals } = args;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.list && positionals.length === 0) fail(USAGE);
if (positionals.length > 1) fail(`One person at a time (got ${positionals.length} handles: quote a phone number with spaces).\n${USAGE}`);

// Check the input before the credentials, so a typo is reported even without a .env.
const handle = values.list ? undefined : normalizeHandle(positionals[0]);
if (!values.list && !handle) {
  fail(`"${positionals[0]}" is not a phone number or email.\n  Use a US number like 415-555-0123, +44 7700 900123 with its country code, or an email address.`);
}

const client = assignApiFromEnv();
if (!client) {
  fail(
    "[photon:assign] Set these in the root .env (next to package.json):\n" +
      "  PHOTON_PROJECT_ID=pho_prj_...  from Settings at https://app.beta.photon.codes\n" +
      "  PHOTON_API_KEY=pho_sk_...      from the project's API keys page -> New API key (shown once; needs platforms:read + platforms:write)",
  );
}
const { api, projectId } = client;

// After a request, set exitCode and let Node finish instead of process.exit(): exiting while
// fetch's sockets are closing trips a libuv assertion on Windows.
async function main(): Promise<number> {
  if (values.list) {
    const res = await listAssignments(api, projectId);
    if (!res.ok) {
      console.error(`[photon:assign] Could not list assignments: ${res.error}`);
      return 1;
    }
    if (res.assignments.length === 0) {
      console.log(`No one is registered on project ${projectId}'s shared iMessage line yet.`);
      return 0;
    }
    console.log(`${res.assignments.length} active assignment(s) on project ${projectId}:`);
    const width = Math.max(...res.assignments.map((a) => formatHandle(a.handle).length));
    for (const a of res.assignments) {
      console.log(`  ${formatHandle(a.handle).padEnd(width)}  ->  ${formatHandle(a.assignedPhoneNumber)}   (${a.platform}, since ${a.createdAt})`);
    }
    return 0;
  }

  const res = await assignHandle(api, projectId, handle!, { firstName: values.first, lastName: values.last });
  if (!res.ok) {
    console.error(`[photon:assign] Could not register ${formatHandle(handle!)}: ${res.error}`);
    return 1;
  }
  const a = res.assignment;
  console.log(
    a.reused
      ? `${formatHandle(a.handle)} was already registered (no new seat used).`
      : `Registered ${formatHandle(a.handle)} on FireSight's shared iMessage line (used 1 seat).`,
  );
  console.log(`\nTell them: "Text FireSight on iMessage at ${formatHandle(a.assignedPhoneNumber)}"`);
  console.log(
    a.handle.includes("@")
      ? `  (from the Apple ID ${a.handle}: that is the handle registered)`
      : `  (from ${formatHandle(a.handle)}: that is the number registered)`,
  );
  return 0;
}

process.exitCode = await main();
