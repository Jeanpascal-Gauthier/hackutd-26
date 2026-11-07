import OpenAI from "openai";

export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
export const NVIDIA_MODEL = process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";

/** OpenAI-compatible client pointed at NVIDIA's API catalog. */
export function createNvidiaClient(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not set. Copy .env.example to .env at the repo root and fill it in.");
  }
  return new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL });
}
