// Smoke test: can we reach Nemotron on NVIDIA's API, and does it call tools?
//
//   cp .env.example .env   # at the repo root; set NVIDIA_API_KEY
//   npm run smoke -w agent
//
// Exits 0 when the model returns a well-formed call to `locate_room`, 1 otherwise.

import type OpenAI from "openai";
import { createNvidiaClient, NVIDIA_BASE_URL, NVIDIA_FAST, NVIDIA_MODEL } from "../core/nvidia.ts";

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "locate_room",
      description: "Look up the building room id that matches a caller's description of where they are.",
      parameters: {
        type: "object",
        properties: {
          floor: { type: "integer", description: "Floor number, if the caller gave one." },
          description: { type: "string", description: "The place the caller described, e.g. 'break room'." },
        },
        required: ["description"],
      },
    },
  },
];

async function main() {
  const client = createNvidiaClient();
  console.log(`model:    ${NVIDIA_MODEL}`);
  console.log(`base URL: ${NVIDIA_BASE_URL}`);

  const started = Date.now();
  const res = await client.chat.completions.create({
    model: NVIDIA_MODEL,
    messages: [
      {
        role: "system",
        content: "You are a 911 fire dispatch assistant. Always use the locate_room tool to find the caller's room before answering.",
      },
      { role: "user", content: "theres smoke coming out of the break room on 7, near the microwaves" },
    ],
    tools,
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 1024,
    ...NVIDIA_FAST,
  });
  const ms = Date.now() - started;

  const choice = res.choices[0];
  const msg = choice?.message;
  // NVIDIA returns reasoning in a non-standard field when reasoning is on.
  const reasoning = (msg as { reasoning_content?: string } | undefined)?.reasoning_content;

  console.log(`latency:  ${ms} ms`);
  console.log(`finish:   ${choice?.finish_reason}`);
  if (res.usage) console.log(`tokens:   ${res.usage.prompt_tokens} in / ${res.usage.completion_tokens} out`);
  if (reasoning) console.log(`reasoning: ${reasoning.slice(0, 400)}${reasoning.length > 400 ? "…" : ""}`);
  if (msg?.content) console.log(`content:  ${msg.content}`);

  const call = msg?.tool_calls?.find((c) => c.type === "function");
  if (!call || call.type !== "function") {
    console.error("\nFAIL: model did not return a tool call.");
    process.exit(1);
  }

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    console.error(`\nFAIL: tool call arguments are not valid JSON: ${call.function.arguments}`);
    process.exit(1);
  }

  console.log(`\ntool call: ${call.function.name}(${JSON.stringify(args)})  id=${call.id}`);
  if (call.function.name !== "locate_room") {
    console.error("FAIL: unexpected tool name.");
    process.exit(1);
  }
  console.log("PASS: Nemotron returned a tool call.");
}

main().catch((err: unknown) => {
  const e = err as { status?: number; message?: string };
  console.error(`\nFAIL: ${e.status ? `HTTP ${e.status}: ` : ""}${e.message ?? String(err)}`);
  process.exit(1);
});
