// Registers a person's phone (or email) on the Photon 2.0 project's shared iMessage line pool, so
// they can text FireSight. Photon 2.0 shared lines are per person: each handle is assigned to one
// of the pool's numbers (using a seat), and that person texts the assigned number.
// Used by `npm run photon:assign` (assign-cli.ts) and the QR form's "Text us on iMessage" step.
//
// CONTRACT (shared by the CLI and the form). Signatures and types are fixed.
import { createHash } from "node:crypto";
import { Photon } from "@photon-ai/api";

/** One shared-line assignment, as FireSight uses it. */
export interface Assignment {
  /** The registered handle, normalized (E.164 phone like +14155550123, or an email). */
  handle: string;
  /** The iMessage number this person should text. */
  assignedPhoneNumber: string;
  assignmentId: string;
  platform: string; // "imessage"
  createdAt: string;
  /** True when the handle already had an active assignment and it was returned instead of creating one. */
  reused: boolean;
}

export type AssignResult =
  | { ok: true; assignment: Assignment }
  | { ok: false; error: string; code?: string; status?: number };

/**
 * The SDK calls used (subset of @photon-ai/api 0.5.0 `projects.platforms.imessage.assignments`),
 * so tests can pass a fake. NOTE: create's idempotency key is `headers.idempotencyKey` (camelCase),
 * unlike sendMessage's `"idempotency-key"`.
 */
export interface AssignmentsApi {
  projects: {
    platforms: {
      imessage: {
        assignments: {
          create(input: {
            path: { id: string };
            headers: { idempotencyKey: string };
            body: { handle: string; firstName?: string; lastName?: string; email?: string };
          }): Promise<Omit<Assignment, "reused"> & { releasedAt?: string }>;
          list(input: {
            path: { id: string };
            query?: { includeReleased?: string; pageSize?: number; pageToken?: string };
          }): Promise<{ assignments: (Omit<Assignment, "reused"> & { releasedAt?: string })[]; nextPageToken?: string }>;
        };
      };
    };
  };
}

/**
 * Normalizes what a person typed into a handle Photon accepts: an E.164 phone number
 * ("(415) 555-0123" or "415-555-0123" -> "+14155550123"; 10 digits default to +1; "+44..." kept),
 * or a lowercase email. Returns undefined when it is neither.
 */
export function normalizeHandle(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (!s || s.length > 254) return undefined;

  if (s.includes("@")) {
    const email = s.toLowerCase();
    // One @, no spaces, a dot inside the domain (not at its start or end).
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : undefined;
  }

  const compact = s.replace(/[\s\-.() ]/g, "");
  if (!/^\+?\d+$/.test(compact)) return undefined; // letters, extensions, stray symbols
  const plus = compact.startsWith("+");
  const digits = plus ? compact.slice(1) : compact;
  if (plus) {
    if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return undefined;
    if (digits.startsWith("1") && !isNanp(digits)) return undefined; // +1 must be +1 NXX NXX XXXX
    return `+${digits}`;
  }
  if (digits.length === 10) return isNanp(`1${digits}`) ? `+1${digits}` : undefined;
  if (digits.length === 11 && digits.startsWith("1")) return isNanp(digits) ? `+${digits}` : undefined;
  return undefined; // other lengths need an explicit +country code
}

/** "1" + 10 digits, with an area code that doesn't start with 0 or 1. */
function isNanp(digits: string): boolean {
  return /^1[2-9]\d{9}$/.test(digits);
}

/** A handle for people to read: "+14155550100" -> "+1 (415) 555-0100"; anything else unchanged. */
export function formatHandle(handle: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(handle);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : handle;
}

type RawAssignment = Omit<Assignment, "reused"> & { releasedAt?: string };

const KEY_PREFIX = "firesight-assign:";
const MAX_PAGES = 50;
const MAX_CREATE_ATTEMPTS = 3;

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

function toAssignment(raw: RawAssignment, reused: boolean): Assignment {
  return {
    handle: raw.handle,
    assignedPhoneNumber: raw.assignedPhoneNumber,
    assignmentId: raw.assignmentId,
    platform: raw.platform ?? "imessage",
    createdAt: raw.createdAt,
    reused,
  };
}

/** Same person? Compares normalized forms so "+1 415..." from the API matches "+1415...". */
function sameHandle(a: string, b: string): boolean {
  return (normalizeHandle(a) ?? a.trim().toLowerCase()) === (normalizeHandle(b) ?? b.trim().toLowerCase());
}

/** Every active (not released) assignment on the project, following nextPageToken. Throws API errors. */
async function listActive(api: AssignmentsApi, projectId: string): Promise<RawAssignment[]> {
  const out: RawAssignment[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.projects.platforms.imessage.assignments.list({
      path: { id: projectId },
      ...(pageToken ? { query: { pageToken } } : {}),
    });
    for (const a of res?.assignments ?? []) if (a && !a.releasedAt) out.push(a);
    pageToken = res?.nextPageToken || undefined;
    if (!pageToken || seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
  }
  return out;
}

export type ListResult = { ok: true; assignments: Assignment[] } | { ok: false; error: string; code?: string; status?: number };

/** Active assignments on the project (read-only; for `photon:assign --list`). Never throws. */
export async function listAssignments(api: AssignmentsApi, projectId: string): Promise<ListResult> {
  try {
    return { ok: true, assignments: (await listActive(api, projectId)).map((a) => toAssignment(a, true)) };
  } catch (err) {
    return describeError(err);
  }
}

/** The fields read from an SDK error (ApiError: status + body.code; TransportError: cause). */
interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  body?: { code?: string; detail?: string; issues?: { path?: string; message?: string }[] };
  cause?: unknown;
}

function errorCode(err: unknown): string | undefined {
  const e = (err ?? {}) as ErrorLike;
  const code = e.body && typeof e.body === "object" ? e.body.code : undefined;
  return typeof code === "string" ? code : typeof e.code === "string" ? e.code : undefined;
}

const DASHBOARD = "https://app.beta.photon.codes";

/** An SDK (or network) error as a failed result whose message says what to do about it. */
function describeError(err: unknown, handle?: string): { ok: false; error: string; code?: string; status?: number } {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = errorCode(err);
  const rawDetail = e.body?.detail ?? e.message ?? String(err);
  const detail = /^Photon API returned HTTP \d+$/.test(rawDetail) ? "" : rawDetail; // the SDK's filler, same as the tag
  const tag = [status && `HTTP ${status}`, code].filter(Boolean).join(" ");
  const why = (text: string) => ({
    ok: false as const,
    error: `${text}${tag ? ` (${tag}${detail && !text.includes(detail) ? `: ${detail}` : ""})` : ""}`,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
  });

  switch (code) {
    case "SHARED_LINE_CAP_EXCEEDED":
      return why(`No shared-line seats left on this Photon project. Release an assignment you no longer need, or add seats at ${DASHBOARD}`);
    case "SHARED_LINE_POOL_EXHAUSTED":
      return why("Photon's shared iMessage pool has no free numbers right now. Try again later, or ask Photon support");
    case "IMESSAGE_MODE_DEDICATED":
      return why("This project uses a dedicated iMessage line, not shared lines: people text the dedicated number directly, no registration needed");
    case "BILLING_NOT_PROVISIONED":
    case "BILLING_ENTITLEMENTS_PENDING":
      return why(`iMessage shared lines are not enabled on this Photon project yet (billing/plan not active). Enable iMessage for the project at ${DASHBOARD}`);
    case "PROJECT_CLOSING":
      return why("This Photon project is being closed, so it can't take new registrations. Check PHOTON_PROJECT_ID");
    case "RESOURCE_MISMATCH":
      return why("PHOTON_API_KEY belongs to a different project than PHOTON_PROJECT_ID. Use a key created on this project's API keys page");
    case "INSUFFICIENT_SCOPE":
      return why("PHOTON_API_KEY lacks permission for shared lines: it needs platforms:read and platforms:write");
    case "VALIDATION_FAILED": {
      const issues = (e.body?.issues ?? []).map((i) => i?.message).filter(Boolean).join("; ");
      return why(`Photon rejected ${handle ? `"${handle}"` : "the request"}${issues ? ` (${issues})` : ""}. Use a phone number like +14155550123 or an email address`);
    }
    case "IDEMPOTENCY_REQUEST_IN_PROGRESS":
      return why("Another registration for this person is still in progress. Try again in a few seconds");
    case "RATE_LIMITED":
      return why("Too many requests to Photon. Wait a moment and try again");
  }
  if (status === 401) return why("Photon rejected PHOTON_API_KEY. Check it is a valid project API key (pho_sk_...) for this project");
  if (status === 403) return why("PHOTON_API_KEY is not allowed to manage shared lines. Check it has platforms:read and platforms:write and belongs to PHOTON_PROJECT_ID");
  if (status === 404) return why("Photon could not find this project. Check PHOTON_PROJECT_ID (pho_prj_..., from Settings)");
  if (status === 422) return why(`Photon rejected ${handle ? `"${handle}"` : "the request"}. Use a phone number like +14155550123 or an email address`);
  if (status === 429) return why("Too many requests to Photon. Wait a moment and try again");
  if (status !== undefined && status >= 500) return why("Photon is having trouble right now. Try again in a minute");
  if (e.name === "ResponseValidationError") return why("Photon answered with a response this SDK version doesn't understand. Try again, or update @photon-ai/api");
  if (status === undefined) {
    // TransportError -> TypeError("fetch failed") -> Error { code: "ENOTFOUND" }: report the innermost.
    let reason = e.message ?? String(err);
    for (let c = e.cause as { message?: string; code?: unknown; cause?: unknown } | undefined, i = 0; c && i < 5; c = c.cause as typeof c, i++) {
      reason = typeof c.code === "string" ? `${c.code}${c.message ? `: ${c.message}` : ""}` : (c.message ?? reason);
    }
    return { ok: false, error: `Could not reach Photon (${reason}). Check the internet connection and try again`, ...(code ? { code } : {}) };
  }
  return why("Photon could not register this person");
}

/**
 * Assigns `handle` (already normalized) to a shared iMessage line. If it already has an active
 * (not released) assignment, returns that one with reused: true and creates nothing. Never throws:
 * API errors come back as { ok: false, error, code?, status? } with a message a person can act on.
 */
export async function assignHandle(
  api: AssignmentsApi,
  projectId: string,
  handle: string,
  person?: { firstName?: string; lastName?: string; email?: string },
): Promise<AssignResult> {
  const normalized = normalizeHandle(handle);
  if (!normalized) {
    return { ok: false, code: "INVALID_HANDLE", error: `"${handle}" is not a phone number or email. Use a phone like +14155550123 or an email` };
  }
  const assignments = api.projects.platforms.imessage.assignments;
  const findActive = async () => (await listActive(api, projectId)).find((a) => sameHandle(a.handle, normalized));

  try {
    const existing = await findActive();
    if (existing) return { ok: true, assignment: toAssignment(existing, true) };

    const body: { handle: string; firstName?: string; lastName?: string; email?: string } = { handle: normalized };
    for (const field of ["firstName", "lastName", "email"] as const) {
      const value = person?.[field]?.trim();
      if (value) body[field] = value;
    }

    // Deterministic key: a retried request (double-click, form resubmit, network retry) replays the
    // first create instead of taking a second seat. Fallback keys below are deterministic too.
    const primaryKey = `${KEY_PREFIX}${normalized}`;
    let key = primaryKey;
    const tried = new Set<string>();
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS && !tried.has(key); attempt++) {
      tried.add(key);
      try {
        const created = await assignments.create({ path: { id: projectId }, headers: { idempotencyKey: key }, body });
        if (!created?.releasedAt) return { ok: true, assignment: toAssignment(created, false) };
        // A replay of an earlier create whose assignment has since been released: create anew.
        key = `${primaryKey}:after:${created.assignmentId}`;
      } catch (err) {
        const code = errorCode(err);
        if (code === "ASSIGNMENT_EXISTS" || code === "IDEMPOTENCY_KEY_REUSED") {
          // Someone registered this handle meanwhile (or listing lagged): return theirs.
          const found = await findActive().catch(() => undefined);
          if (found) return { ok: true, assignment: toAssignment(found, true) };
        }
        if (code === "IDEMPOTENCY_KEY_REUSED") key = `${primaryKey}:${shortHash(JSON.stringify(body))}`;
        else if (code === "IDEMPOTENCY_KEY_INVALID") key = `firesight-assign-${shortHash(normalized)}`;
        else return describeError(err, normalized);
        if (tried.has(key)) return describeError(err, normalized);
      }
    }
    return { ok: false, error: `Photon kept returning released assignments for ${normalized}. Try again, or check the assignments in ${DASHBOARD}` };
  } catch (err) {
    return describeError(err, normalized);
  }
}

/** API client and project id from PHOTON_PROJECT_ID + PHOTON_API_KEY, or undefined if either is missing. */
export function assignApiFromEnv(env: NodeJS.ProcessEnv = process.env): { api: AssignmentsApi; projectId: string } | undefined {
  const projectId = env.PHOTON_PROJECT_ID?.trim();
  const apiKey = env.PHOTON_API_KEY?.trim();
  if (!projectId || !apiKey) return undefined;
  const api = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } }) as unknown as AssignmentsApi;
  return { api, projectId };
}
