import { Ollama } from "ollama";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

export const ollamaClient = new Ollama({ host: OLLAMA_HOST });

export async function aiChat({
  model,
  messages,
  options = {},
}: {
  model: string;
  messages: { role: string; content: string }[];
  options?: Record<string, any>;
}): Promise<any> {
  return await ollamaClient.chat({ model, messages, ...options } as any) as any;
}

export async function aiGenerate({
  model,
  prompt,
  options = {},
}: {
  model: string;
  prompt: string;
  options?: Record<string, any>;
}) {
  return await ollamaClient.generate({ model, prompt, ...options } as any);
}

export async function aiEmbed({
  model,
  input,
  options = {},
}: {
  model: string;
  input: string | string[];
  options?: Record<string, any>;
}) {
  return await ollamaClient.embed({ model, input, ...options } as any);
}

export async function checkOllamaHealth(): Promise<{ ok: boolean; models: string[] }> {
  try {
    const list = await ollamaClient.list();
    return {
      ok: true,
      models: list.models.map((m: any) => m.name),
    };
  } catch {
    return { ok: false, models: [] };
  }
}

export function parseAIJson(raw: string): any {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in AI response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "llama3";

export function systemPrompt(): string {
  return (
    "You are ObservaIQ AI, an expert observability intelligence engine specialising in " +
    "enterprise APM data from AppDynamics and Dynatrace. " +
    "Always respond with valid JSON only — no markdown, no code blocks, no commentary outside the JSON object. " +
    "Follow the exact JSON schema requested. Do not expose credentials or PII in your response."
  );
}
