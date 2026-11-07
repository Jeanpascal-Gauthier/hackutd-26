// Test fixture: an agent module that exports processReport.
export async function processReport({ text }: { text: string; caller: string }) {
  return { roomId: "7-break", confidence: 0.9, reply: `agent saw: ${text}` };
}
