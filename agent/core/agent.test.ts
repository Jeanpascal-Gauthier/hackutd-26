// No network, no NVIDIA API: processReport with a fake chat model and a fake ServerApi; the
// active-building fetch, the system prompt and the caller reply.
//   npm test -w agent
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import type { Building, BuildingLookup, IncidentState } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { syntheticBuilding } from "../fixtures/synthetic.ts";
import { loadActiveBuilding, processReport, replyFor, resetConversations, systemPrompt } from "./agent.ts";
import { FIND_BUILDING_REPLY } from "./tools/findBuilding.ts";
import type { AgentContext, ServerApi } from "./tools/types.ts";

const demo = sharedBuilding as Building;

beforeEach(() => resetConversations());

const stateWith = (extra: Partial<IncidentState> = {}): IncidentState => ({ simMinute: 0, rooms: [], reports: [], occupants: [], ...extra });

/** A fake server: GET /state says which building (id + version) is active; GET /building returns it. */
function fakeServer(opts: { building?: Building; version?: number; lookup?: BuildingLookup; stateFails?: boolean; buildingFails?: boolean } = {}) {
  const calls = { getState: 0, getBuilding: 0, lookupAddress: [] as string[] };
  const current = { building: opts.building ?? demo, version: opts.version ?? 1, stateFails: opts.stateFails, buildingFails: opts.buildingFails };
  const server: ServerApi = {
    async getState() {
      calls.getState++;
      if (current.stateFails) throw new Error("connect ECONNREFUSED");
      const p = current.building.profile;
      return stateWith({
        building: { id: p?.id ?? "demo", name: p?.name ?? "demo", version: current.version, layoutEstimated: p?.layoutEstimated ?? false },
        ...(opts.lookup ? { buildingLookup: opts.lookup } : {}),
      });
    },
    async getBuilding() {
      calls.getBuilding++;
      if (current.buildingFails) throw new Error("GET /building failed: HTTP 500");
      return { building: current.building, occupants: [], sprinklers: {} };
    },
    forecast: () => Promise.reject(new Error("no forecast in this test")),
    async lookupAddress(address, caller) {
      calls.lookupAddress.push(address);
      return { query: address, caller, status: "searching", candidates: [], time: 1 };
    },
  };
  return { server, calls, current };
}

type Call = { name: string; args: Record<string, unknown> };

/** A fake chat model: turn i returns tool calls turns[i] (none = done). Records each request. */
function fakeLlm(turns: Call[][]) {
  const requests: { messages: { role: string; content?: unknown }[] }[] = [];
  let i = 0;
  const llm = {
    chat: {
      completions: {
        create: async (req: { messages: unknown[] }) => {
          requests.push(structuredClone(req) as (typeof requests)[number]);
          const calls = turns[i++] ?? [];
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: calls.length ? null : "done",
                  tool_calls: calls.map((c, j) => ({ id: `t${i}-${j}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { llm, requests };
}

// ---- The active building ----

test("loadActiveBuilding: fetches the active building once per id + version", async () => {
  const tower = syntheticBuilding();
  const { server, calls, current } = fakeServer({ building: tower });
  const ctx: AgentContext = { building: demo, server };
  const first = await loadActiveBuilding(ctx);
  assert.equal(first.source, "server");
  assert.equal(first.building.profile?.name, "Campbell Tower");
  assert.equal((await loadActiveBuilding(ctx)).source, "cache");
  assert.equal(calls.getBuilding, 1);
  current.version = 2; // the operator confirmed another building
  current.building = syntheticBuilding({ name: "Other Tower", floors: 2 });
  const changed = await loadActiveBuilding(ctx);
  assert.equal(changed.source, "server");
  assert.equal(changed.building.profile?.name, "Other Tower");
  assert.equal(calls.getBuilding, 2);
});

test("loadActiveBuilding: server unreachable -> the bundled demo building, or the last one it gave", async () => {
  const down = fakeServer({ stateFails: true });
  const fallback = await loadActiveBuilding({ building: demo, server: down.server });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.building, demo);
  assert.match(fallback.note ?? "", /GET \/state failed/);

  const { server, current } = fakeServer({ building: syntheticBuilding() });
  const ctx: AgentContext = { building: demo, server };
  await loadActiveBuilding(ctx);
  current.stateFails = true;
  const stale = await loadActiveBuilding(ctx);
  assert.equal(stale.source, "fallback");
  assert.equal(stale.building.profile?.name, "Campbell Tower");
});

test("loadActiveBuilding: GET /building fails -> demo building, lookup still passed on", async () => {
  const lookup: BuildingLookup = { query: "1313 Broadway", status: "needs_confirmation", candidates: [], time: 1 };
  const { server } = fakeServer({ buildingFails: true, lookup });
  const r = await loadActiveBuilding({ building: demo, server });
  assert.equal(r.source, "fallback");
  assert.equal(r.building, demo);
  assert.equal(r.lookup?.status, "needs_confirmation");
});

// ---- The prompt ----

test("systemPrompt names the active building, its use and floors; no fixed 12-floor building", () => {
  const p = systemPrompt(syntheticBuilding({ floors: 4 }));
  assert.match(p, /Active building: Campbell Tower, 800 W Campbell Rd, Richardson, TX 75080\. An office building with 4 floors \(floors 1-4\)/);
  assert.match(p, /estimated/);
  assert.doesNotMatch(p, /12-floor/);
  const d = systemPrompt(demo);
  assert.match(d, /Active building: FireSight demo building\. An office building with 12 floors \(floors 1-12\)\./);
  assert.doesNotMatch(d, /estimated/);
  assert.match(d, /find_building/);
});

test("systemPrompt includes the lookup status while one is in progress or failed", () => {
  const searching = systemPrompt(demo, { query: "1313 Broadway", status: "searching", candidates: [], time: 1 });
  assert.match(searching, /address lookup for "1313 Broadway" is in progress \(searching\)/);
  assert.match(searching, /or the address being looked up/);
  const failed = systemPrompt(demo, { query: "nowhere", status: "failed", error: "no match", candidates: [], time: 1 });
  assert.match(failed, /lookup, for "nowhere", failed: no match/);
  assert.doesNotMatch(systemPrompt(demo, { query: "x", status: "active", candidates: [], time: 1 }), /address lookup for|lookup, for/);
});

// ---- The reply ----

test("replyFor: fixed wording while the building is confirmed; none once the room is known", () => {
  const lookup: BuildingLookup = { query: "x", status: "searching", candidates: [], time: 1 };
  assert.equal(replyFor({ lookup, located: { confidence: 0.85, roomId: "7-break", floor: 7 } }), FIND_BUILDING_REPLY);
  assert.equal(FIND_BUILDING_REPLY, "Help is on the way. We are confirming the building now. Do not use the elevator.");
  assert.equal(replyFor({ located: { confidence: 0.85, roomId: "7-break", floor: 7 } }), undefined);
  assert.match(replyFor({}) ?? "", /Which floor/);
});

// ---- processReport, end to end with fakes ----

test("processReport: find_building starts a lookup -> stop, fixed reply, no room", async () => {
  const { server, calls } = fakeServer();
  const { llm, requests } = fakeLlm([
    [
      { name: "find_building", args: { address: "800 W Campbell Rd, Richardson" } },
      { name: "locate_room", args: { floor: 3, place: "kitchen" } },
    ],
    [{ name: "merge_reports", args: {} }],
  ]);
  const r = await processReport(
    { text: "Fire in the kitchen on the 3rd floor at 800 W Campbell Rd, Richardson", caller: "+15550100" },
    { building: demo, server, llm },
  );
  assert.equal(requests.length, 1, "no second model turn after the lookup starts");
  assert.deepEqual(calls.lookupAddress, ["800 W Campbell Rd, Richardson"]);
  assert.equal(r.reply, FIND_BUILDING_REPLY);
  assert.equal(r.roomId, undefined);
  assert.equal(r.confidence, 0);
  assert.equal(r.buildingLookup?.query, "800 W Campbell Rd, Richardson");
  assert.deepEqual(r.trail?.map((s) => s.tool), ["find_building", "locate_room"]);
  assert.deepEqual(r.trail?.[1]?.output, { skipped: "waiting for the operator to confirm the building" });
});

test("processReport: the tools and the prompt use the server's active building", async () => {
  const tower = syntheticBuilding({
    floors: 3,
    rooms: [
      ["apt-2a", "Apartment 2A", "residential", 10, 8],
      ["apt-2b", "Apartment 2B", "residential", 10, 8],
    ],
    use: "residential",
    name: "Elm Court",
  });
  const { server } = fakeServer({ building: tower });
  const { llm, requests } = fakeLlm([[{ name: "locate_room", args: { floor: 2, place: "apartment 2B" } }], []]);
  const r = await processReport({ text: "smoke coming out of apartment 2B on floor 2", caller: "+1" }, { building: demo, server, llm });
  assert.equal(r.roomId, "2-apt-2b");
  assert.equal(r.reply, undefined); // confident: the server texts the recommendation
  const system = String(requests[0]?.messages[0]?.content);
  assert.match(system, /Active building: Elm Court, .* residential building with 3 floors/);
});

test("processReport: a held report re-run after confirmation is not listed as its own earlier message", async () => {
  const { server } = fakeServer();
  const text = "smoke on the 7th floor break room";
  const first = fakeLlm([[]]);
  await processReport({ text, caller: "+2" }, { building: demo, server, llm: first.llm });
  const again = fakeLlm([[]]);
  await processReport({ text, caller: "+2" }, { building: demo, server, llm: again.llm });
  assert.doesNotMatch(String(again.requests[0]?.messages[1]?.content), /Earlier messages/);
});
