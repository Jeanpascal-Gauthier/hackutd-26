// Test fixture: an agent module that exports processReport, resetConversations, defaultContext
// and estimateOccupancy.
export const defaultContext = { building: { rooms: [], links: [], verticals: [] }, server: "fixture" };
export let lastContext: unknown;

export async function processReport({ text }: { text: string; caller: string }, ctx: unknown = defaultContext) {
  lastContext = ctx;
  return { roomId: "7-break", confidence: 0.9, reply: `agent saw: ${text}` };
}

export let resets = 0;
export function resetConversations() {
  resets++;
}

export function estimateOccupancy(building: { rooms: { id: string }[] }, at: number) {
  const room = building.rooms[0]?.id ?? "none";
  return { occupants: [{ room, count: 3, flags: [], estimated: true }], total: 3, byFloor: { "1": 3 }, localTime: new Date(at).toISOString(), basis: ["fixture"] };
}
