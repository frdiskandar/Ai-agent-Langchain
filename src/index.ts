#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { buildGraph } from "./agent/graph.js";
import {
  checkLlm,
  createModel,
  LlmError,
  providerLabel,
} from "./agent/model.js";
import { createTools } from "./agent/tools/index.js";
import { startRepl } from "./cli/repl.js";
import { ConfigError, loadConfig } from "./config.js";
import { closeCheckpointer, createCheckpointer } from "./memory/sqlite.js";
import { style } from "./utils/output.js";

interface CliOptions {
  workspaceDir?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  sqlitePath?: string;
  help: boolean;
  version: boolean;
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", short: "d" },
      workspace: { type: "string", short: "C" },
      provider: { type: "string", short: "p" },
      "base-url": { type: "string" },
      model: { type: "string", short: "m" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  });

  return {
    workspaceDir: values.dir ?? values.workspace,
    provider: values.provider,
    baseUrl: values["base-url"],
    model: values.model,
    sqlitePath: values.db,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function printUsage(): void {
  console.log(
    [
      style.bold(
        "Agentic AI — coding agent dengan LangGraph + Ollama/LM Studio + SQLite",
      ),
      "",
      "Usage:",
      "  pnpm dev --dir /path/ke/repo [options]",
      "",
      "Options:",
      "  -d, --dir <path>        Workspace/repo target",
      "  -C, --workspace <path>  Alias untuk --dir",
      "  -p, --provider <name>   ollama | lmstudio (default: ollama)",
      "      --base-url <url>    Override base URL provider",
      "  -m, --model <name>      Nama model (default tergantung provider)",
      "      --db <path>         Path SQLite (default: ./data/checkpoints.sqlite)",
      "  -h, --help              Tampilkan bantuan",
      "  -v, --version           Tampilkan versi",
      "",
      "Environment:",
      "  LLM_PROVIDER            ollama | lmstudio (default: ollama)",
      "  WORKSPACE_DIR           Alternatif untuk --dir",
      "  OLLAMA_BASE_URL         Default: http://127.0.0.1:11434",
      "  OLLAMA_MODEL            Default: qwen2.5-coder:7b",
      "  LMSTUDIO_BASE_URL       Default: http://127.0.0.1:1234/v1",
      "  LMSTUDIO_MODEL          Default: qwen2.5-7b-instruct",
      "  LMSTUDIO_API_KEY        Default: lm-studio",
      "",
      "Examples:",
      "  pnpm dev --dir ~/code/projek/lain",
      "  pnpm dev --dir . --model qwen2.5-coder:7b",
      "  pnpm dev --dir . --provider lmstudio --model qwen2.5-7b-instruct",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs();
  } catch (error) {
    console.error(style.red(error instanceof Error ? error.message : String(error)));
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (options.version) {
    console.log("agentic-ai 1.0.0");
    return;
  }

  const config = loadConfig({
    workspaceDir: options.workspaceDir,
    provider: options.provider,
    baseUrl: options.baseUrl,
    model: options.model,
    sqlitePath: options.sqlitePath,
  });

  const llmStatus = await checkLlm(config);
  console.log(
    style.dim(
      `${providerLabel(llmStatus.provider)} siap · ${
        llmStatus.models.length
      } model tersedia · ${config.model}`,
    ),
  );

  const checkpointer = createCheckpointer(config.sqlitePath);
  const tools = createTools({
    workspaceDir: config.workspaceDir,
    maxFileBytes: config.maxFileBytes,
    maxOutputChars: config.maxOutputChars,
    commandTimeoutMs: config.commandTimeoutMs,
    maxIterations: config.maxIterations,
  });

  const model = createModel(config);
  const graph = buildGraph({
    model,
    tools,
    workspaceDir: config.workspaceDir,
    checkpointer,
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    closeCheckpointer(checkpointer);
    rl.close();
  };

  process.once("SIGINT", () => {
    console.log(style.dim("\nDibatalkan."));
    cleanup();
    process.exit(0);
  });

  try {
    await startRepl({ config, graph, rl });
  } finally {
    cleanup();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof LlmError) {
    console.error(`\n${style.red(error.message)}`);
  } else {
    console.error(`\n${style.red("Error tak terduga:")}`);
    console.error(error);
  }
  process.exitCode = 1;
});
