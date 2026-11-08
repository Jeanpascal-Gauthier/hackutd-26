// No network: shared-line registration with a fake @photon-ai/api client (a real create uses a paid seat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, TransportError } from "@photon-ai/api";
import { CreateSharedLineAssignmentInputSchema, ListSharedLineAssignmentsInputSchema } from "@photon-ai/api/schemas";
import { assignApiFromEnv, assignHandle, formatHandle, listAssignments, normalizeHandle, type AssignmentsApi } from "./assign.ts";

const PROJECT = "pho_prj_test";
type Raw = Awaited<ReturnType<AssignmentsApi["projects"]["platforms"]["imessage"]["assignments"]["list"]>>["assignments"][number];
type CreateInput = Parameters<AssignmentsApi["projects"]["platforms"]["imessage"]["assignments"]["create"]>[0];
type ListInput = Parameters<AssignmentsApi["projects"]["platforms"]["imessage"]["assignments"]["list"]>[0];

function row(handle: string, n: string, over: Partial<Raw> = {}): Raw {
  return { handle, assignedPhoneNumber: n, assignmentId: `asg_${handle}`, platform: "imessage", createdAt: "2026-11-07T20:00:00Z", ...over };
}

/** A fake client: `pages` are returned in order by list; `create` is the create behavior. */
function fakeApi(pages: Raw[][], create?: (input: CreateInput) => Promise<Raw>) {
  const lists: ListInput[] = [];
  const creates: CreateInput[] = [];
  const api: AssignmentsApi = {
    projects: {
      platforms: {
        imessage: {
          assignments: {
            list: async (input) => {
              lists.push(input);
              const i = input.query?.pageToken ? Number(input.query.pageToken) : 0;
              return { assignments: pages[i] ?? [], ...(i + 1 < pages.length ? { nextPageToken: String(i + 1) } : {}) };
            },
            create: async (input) => {
              creates.push(input);
              if (!create) throw new Error("create should not be called");
              return create(input);
            },
          },
        },
      },
    },
  };
  return { api, lists, creates };
}

const apiError = (status: number, code?: string, detail?: string, extra: Record<string, unknown> = {}) =>
  new ApiError(detail ?? `Photon API returned HTTP ${status}`, {
    status,
    headers: new Headers(),
    body: { ...(code ? { code } : {}), ...(detail ? { detail } : {}), status, ...extra },
  });

test("normalizeHandle: US numbers in any common format become +1 E.164", () => {
  for (const s of ["(415) 555-0123", "415-555-0123", "415.555.0123", "4155550123", " 415 555 0123 ", "1 415 555 0123", "14155550123", "+1 (415) 555-0123", "+14155550123"]) {
    assert.equal(normalizeHandle(s), "+14155550123", s);
  }
});

test("normalizeHandle: international numbers keep their country code", () => {
  assert.equal(normalizeHandle("+44 7700 900123"), "+447700900123");
  assert.equal(normalizeHandle("+33 6 12 34 56 78"), "+33612345678");
  assert.equal(normalizeHandle("+52 55 1234 5678"), "+525512345678");
});

test("normalizeHandle: emails are lowercased", () => {
  assert.equal(normalizeHandle("  Ada.Lovelace@iCloud.COM "), "ada.lovelace@icloud.com");
  assert.equal(normalizeHandle("a+fire@sub.example.org"), "a+fire@sub.example.org");
});

test("normalizeHandle: junk is rejected", () => {
  for (const s of [
    "", "   ", "hello", "555-0123", "12345", "415555012", "41555501234", "24155550123", "0155550123", "1155550123",
    "+1 415 555 012", "+123", "+1234567890123456", "+0 123 456 789", "415-555-CALL", "415 555 0123 x12", "#4155550123",
    "a@b", "@example.com", "a@@b.com", "a@b@c.com", "ada lovelace@icloud.com", "ada@.com", "ada@icloud.", "ada@icloud..com",
  ]) {
    assert.equal(normalizeHandle(s), undefined, JSON.stringify(s));
  }
});

test("formatHandle: +1 numbers are readable, others unchanged", () => {
  assert.equal(formatHandle("+14155550100"), "+1 (415) 555-0100");
  assert.equal(formatHandle("+447700900123"), "+447700900123");
  assert.equal(formatHandle("ada@icloud.com"), "ada@icloud.com");
});

test("assignHandle: an active assignment for the same handle is reused, nothing created", async () => {
  const { api, creates } = fakeApi([[row("+15550000001", "+14155550100"), row("+14155550123", "+14155550199")]]);
  const res = await assignHandle(api, PROJECT, "(415) 555-0123");
  assert.deepEqual(res, {
    ok: true,
    assignment: { handle: "+14155550123", assignedPhoneNumber: "+14155550199", assignmentId: "asg_+14155550123", platform: "imessage", createdAt: "2026-11-07T20:00:00Z", reused: true },
  });
  assert.equal(creates.length, 0);
});

test("assignHandle: emails match case-insensitively", async () => {
  const { api, creates } = fakeApi([[row("ada@icloud.com", "+14155550100")]]);
  const res = await assignHandle(api, PROJECT, "Ada@iCloud.com");
  assert.ok(res.ok && res.assignment.reused);
  assert.equal(creates.length, 0);
});

test("assignHandle: released assignments are ignored, and a new one is created", async () => {
  const { api, creates } = fakeApi([[row("+14155550123", "+14155550100", { releasedAt: "2026-11-07T21:00:00Z" })]], async (input) =>
    row(input.body.handle, "+14155550111", { assignmentId: "asg_new" }),
  );
  const res = await assignHandle(api, PROJECT, "+14155550123");
  assert.ok(res.ok);
  assert.equal(res.assignment.reused, false);
  assert.equal(res.assignment.assignedPhoneNumber, "+14155550111");
  assert.equal(creates.length, 1);
});

test("assignHandle: follows nextPageToken to find an existing assignment", async () => {
  const { api, lists, creates } = fakeApi([[row("+15550000001", "+14155550100")], [row("+15550000002", "+14155550100")], [row("+14155550123", "+14155550177")]]);
  const res = await assignHandle(api, PROJECT, "+14155550123");
  assert.ok(res.ok && res.assignment.reused && res.assignment.assignedPhoneNumber === "+14155550177");
  assert.deepEqual(lists.map((l) => l.query?.pageToken), [undefined, "1", "2"]);
  assert.equal(creates.length, 0);
});

test("assignHandle: creates with a deterministic idempotency key and the person's names", async () => {
  const { api, creates } = fakeApi([[]], async (input) => row(input.body.handle, "+14155550100", { assignmentId: "asg_1", projectId: PROJECT, updatedAt: "x" } as Partial<Raw>));
  const res = await assignHandle(api, PROJECT, "+14155550123", { firstName: " Ada ", lastName: "Lovelace", email: "" });
  assert.deepEqual(res, {
    ok: true,
    assignment: { handle: "+14155550123", assignedPhoneNumber: "+14155550100", assignmentId: "asg_1", platform: "imessage", createdAt: "2026-11-07T20:00:00Z", reused: false },
  });
  assert.deepEqual(creates, [
    { path: { id: PROJECT }, headers: { idempotencyKey: "firesight-assign:+14155550123" }, body: { handle: "+14155550123", firstName: "Ada", lastName: "Lovelace" } },
  ]);
  // The same person again (a retry, typed differently) uses the same key.
  const retry = fakeApi([[]], async (i) => row(i.body.handle, "+14155550100"));
  await assignHandle(retry.api, PROJECT, "415-555-0123");
  assert.equal(retry.creates[0].headers.idempotencyKey, creates[0].headers.idempotencyKey);
});

test("the exact create and list requests are valid for the SDK's schemas", async () => {
  const { api, lists, creates } = fakeApi([[row("+15550000001", "+1")], []], async (i) => row(i.body.handle, "+14155550100"));
  await assignHandle(api, PROJECT, "+14155550123", { firstName: "Ada", lastName: "Lovelace" });
  await assignHandle(fakeApi([[]], async (i) => row(i.body.handle, "+1")).api, PROJECT, "ada@icloud.com");
  assert.equal(lists.length, 2);
  for (const l of lists) assert.ok(ListSharedLineAssignmentsInputSchema.safeParse(l).success, JSON.stringify(l));
  assert.equal(creates.length, 1);
  const parsed = CreateSharedLineAssignmentInputSchema.safeParse(creates[0]);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  // And the schemas do catch a wrong shape (e.g. sendMessage's "idempotency-key" spelling).
  assert.equal(CreateSharedLineAssignmentInputSchema.safeParse({ ...creates[0], headers: { "idempotency-key": "k" } }).success, false);
});

test("assignHandle: an invalid handle fails without calling the API", async () => {
  const { api, lists } = fakeApi([[]]);
  const res = await assignHandle(api, PROJECT, "not a phone");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.code === "INVALID_HANDLE");
  assert.equal(lists.length, 0);
});

test("assignHandle: errors come back as ok:false with an actionable message, never thrown", async () => {
  const cases: { err: unknown; on: "list" | "create"; status?: number; code?: string; says: RegExp }[] = [
    { err: apiError(401, "NOT_AUTHENTICATED", "Not authenticated"), on: "list", status: 401, code: "NOT_AUTHENTICATED", says: /PHOTON_API_KEY/ },
    { err: apiError(403, "FORBIDDEN"), on: "list", status: 403, says: /platforms:read and platforms:write/ },
    { err: apiError(403, "INSUFFICIENT_SCOPE"), on: "create", status: 403, says: /platforms:read and platforms:write/ },
    { err: apiError(409, "SHARED_LINE_CAP_EXCEEDED", "cap reached"), on: "create", status: 409, code: "SHARED_LINE_CAP_EXCEEDED", says: /No shared-line seats left/ },
    { err: apiError(503, "SHARED_LINE_POOL_EXHAUSTED"), on: "create", status: 503, says: /pool has no free numbers/ },
    { err: apiError(409, "IMESSAGE_MODE_DEDICATED"), on: "create", status: 409, says: /dedicated iMessage line/ },
    { err: apiError(503, "BILLING_NOT_PROVISIONED"), on: "create", status: 503, says: /not enabled/ },
    {
      err: apiError(422, "VALIDATION_FAILED", "Request validation failed", { issues: [{ path: "/handle", message: "must be E.164 or an email", location: "body", code: "x" }] }),
      on: "create", status: 422, code: "VALIDATION_FAILED", says: /rejected "\+14155550123" \(must be E.164 or an email\)/,
    },
    { err: apiError(500), on: "create", status: 500, says: /trouble/ },
    { err: new TransportError("Photon request failed", { cause: new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }) }), on: "list", says: /Could not reach Photon \(ENOTFOUND/ },
    { err: new TypeError("fetch failed"), on: "create", says: /Could not reach Photon/ },
  ];
  for (const c of cases) {
    const { api } = fakeApi([[]], async () => {
      throw c.err;
    });
    if (c.on === "list") api.projects.platforms.imessage.assignments.list = async () => Promise.reject(c.err);
    const res = await assignHandle(api, PROJECT, "+14155550123");
    assert.equal(res.ok, false, String(c.err));
    if (res.ok) continue;
    assert.match(res.error, c.says);
    assert.equal(res.status, c.status);
    if (c.code) assert.equal(res.code, c.code);
  }
});

test("assignHandle: ASSIGNMENT_EXISTS (a race) returns the assignment that won", async () => {
  let listed = 0;
  const { api, creates } = fakeApi([[]], async () => {
    throw apiError(409, "ASSIGNMENT_EXISTS");
  });
  api.projects.platforms.imessage.assignments.list = async () => ({ assignments: listed++ ? [row("+14155550123", "+14155550142")] : [] });
  const res = await assignHandle(api, PROJECT, "+14155550123");
  assert.ok(res.ok && res.assignment.reused && res.assignment.assignedPhoneNumber === "+14155550142");
  assert.equal(creates.length, 1);
});

test("assignHandle: a key replaying a since-released assignment, or a reused key, retries with a new deterministic key", async () => {
  const keys: string[] = [];
  const { api } = fakeApi([[]], async (input) => {
    keys.push(input.headers.idempotencyKey);
    if (keys.length === 1) return row(input.body.handle, "+1", { assignmentId: "asg_old", releasedAt: "2026-11-07T21:00:00Z" });
    if (keys.length === 2) throw apiError(422, "IDEMPOTENCY_KEY_REUSED");
    return row(input.body.handle, "+14155550100", { assignmentId: "asg_new" });
  });
  const res = await assignHandle(api, PROJECT, "+14155550123", { firstName: "Ada" });
  assert.ok(res.ok && !res.assignment.reused && res.assignment.assignmentId === "asg_new");
  assert.equal(keys.length, 3);
  assert.equal(keys[0], "firesight-assign:+14155550123");
  assert.equal(keys[1], "firesight-assign:+14155550123:after:asg_old");
  assert.match(keys[2], /^firesight-assign:\+14155550123:[0-9a-f]{24}$/);
  assert.equal(new Set(keys).size, 3);
});

test("assignHandle: a create that keeps failing the same way gives up", async () => {
  const { api, creates } = fakeApi([[]], async () => {
    throw apiError(422, "IDEMPOTENCY_KEY_REUSED");
  });
  const res = await assignHandle(api, PROJECT, "+14155550123");
  assert.equal(res.ok, false);
  assert.ok(creates.length <= 3);
});

test("listAssignments: active only, across pages; errors don't throw", async () => {
  const { api } = fakeApi([[row("+15550000001", "+14155550100")], [row("+15550000002", "+14155550100", { releasedAt: "x" }), row("b@x.com", "+14155550101")]]);
  const res = await listAssignments(api, PROJECT);
  assert.ok(res.ok);
  assert.deepEqual(res.assignments.map((a) => a.handle), ["+15550000001", "b@x.com"]);

  const bad = fakeApi([[]]).api;
  bad.projects.platforms.imessage.assignments.list = async () => Promise.reject(apiError(401, "NOT_AUTHENTICATED"));
  const failed = await listAssignments(bad, PROJECT);
  assert.ok(!failed.ok && failed.status === 401);
});

test("assignApiFromEnv: needs both variables", () => {
  assert.equal(assignApiFromEnv({}), undefined);
  assert.equal(assignApiFromEnv({ PHOTON_PROJECT_ID: "pho_prj_x" }), undefined);
  assert.equal(assignApiFromEnv({ PHOTON_API_KEY: "pho_sk_x" }), undefined);
  assert.equal(assignApiFromEnv({ PHOTON_PROJECT_ID: " ", PHOTON_API_KEY: "pho_sk_x" }), undefined);
  const client = assignApiFromEnv({ PHOTON_PROJECT_ID: "pho_prj_x", PHOTON_API_KEY: "pho_sk_x" });
  assert.equal(client?.projectId, "pho_prj_x");
  assert.equal(typeof client?.api.projects.platforms.imessage.assignments.create, "function");
  assert.equal(typeof client?.api.projects.platforms.imessage.assignments.list, "function");
});
