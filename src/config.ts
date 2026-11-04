import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

loadEnv({ quiet: true });

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
};

const lowercase = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return value;
};

const EnvSchema = z.object({
  LLM_PROVIDER: z.preprocess(
    lowercase,
    z.enum(["ollama", "lmstudio"]).default("ollama"),
  ),
  OLLAMA_BASE_URL: z
    .string()
    .trim()
    .min(1)
    .default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z
    .preprocess(emptyToUndefined, z.string().trim().min(1).optional())
    .default("qwen2.5-coder:7b"),
  LMSTUDIO_BASE_URL: z
    .string()
    .trim()
    .min(1)
    .default("http://127.0.0.1:1234/v1"),
  LMSTUDIO_MODEL: z
    .preprocess(emptyToUndefined, z.string().trim().min(1).optional())
    .default("qwen2.5-7b-instruct"),
  LMSTUDIO_API_KEY: z
    .preprocess(emptyToUndefined, z.string().trim().min(1).optional())
    .default("lm-studio"),
  WORKSPACE_DIR: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).optional(),
  ),
  SQLITE_PATH: z
    .preprocess(emptyToUndefined, z.string().trim().min(1).optional())
    .default("./data/checkpoints.sqlite"),
  MAX_ITERATIONS: z.coerce.number().int().min(1).max(200).default(25),
  COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(30_000),
  MAX_OUTPUT_CHARS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(500_000)
    .default(20_000),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(5_000_000)
    .default(200_000),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type LlmProvider = "ollama" | "lmstudio";

export interface AppConfig {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  workspaceDir: string;
  sqlitePath: string;
  maxIterations: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
}

export interface ConfigOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
  workspaceDir?: string;
  sqlitePath?: string;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "env";
      return `${key}: ${issue.message}`;
    })
    .join("; ");
}

function parseProvider(value: string | undefined, fallback: LlmProvider): LlmProvider {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ollama" || normalized === "lmstudio") {
    return normalized;
  }

  throw new ConfigError(
    `Provider "${value}" tidak dikenal. Gunakan "ollama" atau "lmstudio".`,
  );
}

/**
 * LM Studio memakai OpenAI-compatible API. Jika user hanya memberi host:port,
 * tambahkan "/v1" agar base URL menunjuk ke root API yang benar.
 */
function normalizeLmStudioBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`LMSTUDIO_BASE_URL tidak valid: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `LMSTUDIO_BASE_URL harus memakai http:// atau https://: ${value}`,
    );
  }

  url.hash = "";
  url.search = "";

  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "" || pathname === "/") {
    pathname = "/v1";
  }

  return `${url.origin}${pathname}`;
}

function normalizeOllamaBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigError(
      `Konfigurasi environment tidak valid: ${formatIssues(parsed.error)}`,
    );
  }

  const env = parsed.data;
  const provider = parseProvider(overrides.provider, env.LLM_PROVIDER);

  const workspaceInput = overrides.workspaceDir ?? env.WORKSPACE_DIR;

  if (!workspaceInput) {
    throw new ConfigError(
      [
        "Workspace belum ditentukan.",
        "Isi WORKSPACE_DIR di .env atau jalankan:",
        "  pnpm dev --dir /path/ke/repo",
      ].join("\n"),
    );
  }

  const workspaceDir = path.resolve(workspaceInput);

  let workspaceStat: fs.Stats;
  try {
    workspaceStat = fs.statSync(workspaceDir);
  } catch {
    throw new ConfigError(`Workspace tidak ditemukan: ${workspaceDir}`);
  }

  if (!workspaceStat.isDirectory()) {
    throw new ConfigError(`Workspace bukan direktori: ${workspaceDir}`);
  }

  let realWorkspaceDir: string;
  try {
    realWorkspaceDir = fs.realpathSync(workspaceDir);
  } catch {
    throw new ConfigError(`Tidak bisa membaca workspace: ${workspaceDir}`);
  }

  const baseUrl =
    provider === "lmstudio"
      ? normalizeLmStudioBaseUrl(
          overrides.baseUrl ?? env.LMSTUDIO_BASE_URL,
        )
      : normalizeOllamaBaseUrl(overrides.baseUrl ?? env.OLLAMA_BASE_URL);

  const model =
    overrides.model ??
    (provider === "lmstudio" ? env.LMSTUDIO_MODEL : env.OLLAMA_MODEL);

  const sqlitePath = path.resolve(overrides.sqlitePath ?? env.SQLITE_PATH);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  return {
    provider,
    baseUrl,
    model,
    apiKey: env.LMSTUDIO_API_KEY,
    workspaceDir: realWorkspaceDir,
    sqlitePath,
    maxIterations: env.MAX_ITERATIONS,
    commandTimeoutMs: env.COMMAND_TIMEOUT_MS,
    maxOutputChars: env.MAX_OUTPUT_CHARS,
    maxFileBytes: env.MAX_FILE_BYTES,
  };
}
