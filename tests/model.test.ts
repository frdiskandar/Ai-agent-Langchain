import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLlm,
  createModel,
  LlmError,
  providerLabel,
} from "../src/agent/model.js";
import { loadConfig, type AppConfig } from "../src/config.js";

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
  requests: string[];
}

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<TestServer> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    handler(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server test tidak punya port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function jsonResponse(response: http.ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "test-model",
    apiKey: "lm-studio",
    workspaceDir: os.tmpdir(),
    sqlitePath: path.join(os.tmpdir(), "agentic-ai-test.sqlite"),
    maxIterations: 25,
    commandTimeoutMs: 30_000,
    maxOutputChars: 20_000,
    maxFileBytes: 200_000,
    ...overrides,
  };
}

let activeServer: TestServer | null = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe("LM Studio provider", () => {
  it("membaca model dari endpoint OpenAI /v1/models", async () => {
    activeServer = await startServer((request, response) => {
      if (request.url === "/v1/models") {
        jsonResponse(response, {
          object: "list",
          data: [{ id: "test-model" }, { id: "model-lain" }],
        });
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });

    const status = await checkLlm(
      makeConfig({ baseUrl: `${activeServer.baseUrl}/v1` }),
    );

    expect(status.provider).toBe("lmstudio");
    expect(status.modelAvailable).toBe(true);
    expect(status.models).toEqual(["test-model", "model-lain"]);
    expect(activeServer.requests).toContain("GET /v1/models");
  });

  it("memberi pesan jelas jika model belum di-load", async () => {
    activeServer = await startServer((_request, response) => {
      jsonResponse(response, {
        object: "list",
        data: [{ id: "model-lain" }],
      });
    });

    await expect(
      checkLlm(makeConfig({ baseUrl: `${activeServer.baseUrl}/v1` })),
    ).rejects.toThrow(/tidak tersedia di LM Studio[\s\S]*model-lain/);
  });

  it("mendeteksi respons error dari LM Studio", async () => {
    activeServer = await startServer((_request, response) => {
      jsonResponse(response, {
        error: "Unexpected endpoint or method. (GET /api/tags)",
      });
    });

    await expect(
      checkLlm(makeConfig({ baseUrl: `${activeServer.baseUrl}/api` })),
    ).rejects.toThrow(/Unexpected endpoint/);
  });

  it("memberi pesan koneksi jika server tidak berjalan", async () => {
    await expect(
      checkLlm(
        makeConfig({
          baseUrl: "http://127.0.0.1:1/v1",
        }),
      ),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("membuat ChatOpenAI untuk LM Studio", () => {
    const model = createModel(makeConfig());
    expect(model).toBeInstanceOf(ChatOpenAI);
  });
});

describe("Ollama provider", () => {
  it("memvalidasi model lewat /api/tags", async () => {
    activeServer = await startServer((request, response) => {
      if (request.url === "/api/tags") {
        jsonResponse(response, {
          models: [
            { name: "qwen2.5-coder:7b" },
            { name: "llama3:latest" },
          ],
        });
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });

    const status = await checkLlm(
      makeConfig({
        provider: "ollama",
        baseUrl: activeServer.baseUrl,
        model: "qwen2.5-coder:7b",
      }),
    );

    expect(status.provider).toBe("ollama");
    expect(status.modelAvailable).toBe(true);
    expect(activeServer.requests).toContain("GET /api/tags");
  });

  it("membuat ChatOllama untuk provider Ollama", () => {
    const model = createModel(
      makeConfig({ provider: "ollama", model: "qwen2.5-coder:7b" }),
    );
    expect(model).toBeInstanceOf(ChatOllama);
  });

  it("memberi label provider yang benar", () => {
    expect(providerLabel("ollama")).toBe("Ollama");
    expect(providerLabel("lmstudio")).toBe("LM Studio");
  });
});

describe("konfigurasi provider", () => {
  it("menambahkan /v1 pada base URL LM Studio tanpa path", () => {
    const config = loadConfig({
      provider: "lmstudio",
      baseUrl: "http://127.0.0.1:1234",
      workspaceDir: os.tmpdir(),
      sqlitePath: path.join(os.tmpdir(), "agentic-ai-config-test.sqlite"),
    });

    expect(config.provider).toBe("lmstudio");
    expect(config.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("menolak provider yang tidak dikenal", () => {
    expect(() =>
      loadConfig({
        provider: "openai",
        workspaceDir: os.tmpdir(),
        sqlitePath: path.join(os.tmpdir(), "agentic-ai-config-test.sqlite"),
      }),
    ).toThrow(/Provider "openai" tidak dikenal/);
  });
});
