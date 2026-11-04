import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig, LlmProvider } from "../config.js";

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmStatus {
  provider: LlmProvider;
  models: string[];
  modelAvailable: boolean;
}

export function providerLabel(provider: LlmProvider): string {
  return provider === "lmstudio" ? "LM Studio" : "Ollama";
}

export function createModel(config: AppConfig): BaseChatModel {
  if (config.provider === "lmstudio") {
    return new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      temperature: 0,
      streaming: true,
      // LM Studio belum tentu mendukung stream_options dan Responses API.
      streamUsage: false,
      useResponsesApi: false,
      maxRetries: 1,
      configuration: {
        baseURL: config.baseUrl,
      },
    });
  }

  return new ChatOllama({
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: 0,
    numCtx: 8_192,
    streaming: true,
  });
}

function normalizeOllamaModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

function formatModelList(models: string[], emptyMessage: string): string {
  return models.length > 0
    ? models.map((name) => `  - ${name}`).join("\n")
    : `  ${emptyMessage}`;
}

async function checkOllama(config: AppConfig): Promise<LlmStatus> {
  let response: Response;

  try {
    response = await fetch(`${config.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new LlmError(
      [
        `Tidak bisa terhubung ke Ollama di ${config.baseUrl}.`,
        "Pastikan Ollama sudah berjalan, lalu cek dengan:",
        `  curl ${config.baseUrl}/api/tags`,
      ].join("\n"),
    );
  }

  if (!response.ok) {
    throw new LlmError(
      `Ollama mengembalikan HTTP ${response.status} dari ${config.baseUrl}/api/tags`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    models?: Array<{ name?: string; model?: string }>;
  } | null;

  if (!payload || !Array.isArray(payload.models)) {
    throw new LlmError(
      [
        `Respons dari ${config.baseUrl}/api/tags bukan format Ollama yang valid.`,
        "Pastikan OLLAMA_BASE_URL menunjuk ke server Ollama, bukan LM Studio.",
      ].join("\n"),
    );
  }

  const models = payload.models
    .map((entry) => entry.name ?? entry.model)
    .filter((name): name is string => Boolean(name));

  const wanted = normalizeOllamaModelName(config.model);
  const modelAvailable = models.some(
    (name) => normalizeOllamaModelName(name) === wanted,
  );

  if (!modelAvailable) {
    throw new LlmError(
      [
        `Model "${config.model}" belum tersedia di Ollama.`,
        "Model yang tersedia:",
        formatModelList(models, "(belum ada model yang di-pull)"),
        "",
        `Pull model tersebut dengan: ollama pull ${config.model}`,
      ].join("\n"),
    );
  }

  return { provider: "ollama", models, modelAvailable };
}

async function checkLmStudio(config: AppConfig): Promise<LlmStatus> {
  let response: Response;

  try {
    response = await fetch(`${config.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new LlmError(
      [
        `Tidak bisa terhubung ke LM Studio di ${config.baseUrl}.`,
        "Pastikan server LM Studio sudah berjalan (tab Developer → Start Server),",
        "lalu cek dengan:",
        `  curl ${config.baseUrl}/models`,
      ].join("\n"),
    );
  }

  if (!response.ok) {
    throw new LlmError(
      `LM Studio mengembalikan HTTP ${response.status} dari ${config.baseUrl}/models`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: string }>;
    error?: string;
  } | null;

  if (payload?.error) {
    throw new LlmError(
      [
        `LM Studio menolak request ke ${config.baseUrl}/models: ${payload.error}`,
        "Pastikan LMSTUDIO_BASE_URL menunjuk ke endpoint OpenAI LM Studio,",
        "misalnya http://127.0.0.1:1234/v1.",
      ].join("\n"),
    );
  }

  if (!payload || !Array.isArray(payload.data)) {
    throw new LlmError(
      [
        `Respons dari ${config.baseUrl}/models bukan format OpenAI-compatible.`,
        "Pastikan LMSTUDIO_BASE_URL menunjuk ke endpoint OpenAI LM Studio,",
        "misalnya http://127.0.0.1:1234/v1 (bukan port Ollama 11434).",
      ].join("\n"),
    );
  }

  const models = payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id));

  const modelAvailable = models.includes(config.model);

  if (!modelAvailable) {
    throw new LlmError(
      [
        `Model "${config.model}" tidak tersedia di LM Studio.`,
        "Model yang tersedia:",
        formatModelList(models, "(belum ada model yang di-load)"),
        "",
        "Load model tersebut di LM Studio, atau set LMSTUDIO_MODEL ke salah",
        "satu id di atas.",
      ].join("\n"),
    );
  }

  return { provider: "lmstudio", models, modelAvailable };
}

export async function checkLlm(config: AppConfig): Promise<LlmStatus> {
  if (config.provider === "lmstudio") {
    return checkLmStudio(config);
  }
  return checkOllama(config);
}
