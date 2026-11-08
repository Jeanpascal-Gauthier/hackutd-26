// Test fixture: an agent module that exports processReport and resetConversations.
export async function processReport({ text }: { text: string; caller: string }) {
  return { roomId: "7-break", confidence: 0.9, reply: `agent saw: ${text}` };
}

export let resets = 0;
export function resetConversations() {
  resets++;
}
