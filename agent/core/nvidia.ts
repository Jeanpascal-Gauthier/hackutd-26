import OpenAI from "openai";

export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
export const NVIDIA_MODEL = process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b";

/**
 * Spread into every chat.completions.create call. Turns off Nemotron's
 * "thinking" pass: ~0.5 s instead of 1-2 s per call, same tool calls.
 * (NVIDIA-specific body field; the OpenAI SDK passes it through.)
 */
export const NVIDIA_FAST = {
  chat_template_kwargs: { enable_thinking: false },
};

/** OpenAI-compatible client pointed at NVIDIA's API catalog. */
export function createNvidiaClient(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not set. Copy .env.example to .env at the repo root and fill it in.");
  }
  return new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL });
}
