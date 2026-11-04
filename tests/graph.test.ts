import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import {
  Command,
  INTERRUPT,
  MemorySaver,
  isInterrupted,
} from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGraph,
  type ApprovalRequest,
} from "../src/agent/graph.js";
import { createTools } from "../src/agent/tools/index.js";

class ScriptedChatModel extends BaseChatModel {
  private readonly responses: AIMessage[];

  constructor(responses: AIMessage[]) {
    super({});
    this.responses = [...responses];
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(_tools: BindToolsInput[], _kwargs?: Partial<BaseChatModelCallOptions>) {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.responses.shift() ?? new AIMessage("Selesai.");
    return {
      generations: [{ text: message.text, message }],
    };
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ai-graph-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createAgent(responses: AIMessage[]) {
  const checkpointer = new MemorySaver();
  const model = new ScriptedChatModel(responses);
  const tools = createTools({
    workspaceDir: workspace,
    maxFileBytes: 200_000,
    maxOutputChars: 20_000,
    commandTimeoutMs: 10_000,
    maxIterations: 25,
  });

  return buildGraph({
    model,
    tools,
    workspaceDir: workspace,
    checkpointer,
  });
}

function getInterruptRequest(result: unknown): ApprovalRequest {
  if (!isInterrupted<ApprovalRequest>(result)) {
    throw new Error("Graph tidak menghasilkan interrupt.");
  }
  const request = result[INTERRUPT][0]?.value;
  if (!request) {
    throw new Error("Interrupt tidak memiliki value.");
  }
  return request;
}

describe("coding agent graph", () => {
  it("menjalankan tool read-only tanpa approval", async () => {
    await fs.writeFile(path.join(workspace, "catatan.txt"), "halo");

    const graph = createAgent([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_list",
            name: "list_files",
            args: { path: ".", depth: 1 },
          },
        ],
      }),
      new AIMessage("File catatan.txt ada."),
    ]);

    const result = await graph.invoke(
      { messages: [new HumanMessage("apa isi workspace?")] },
      { configurable: { thread_id: "read-only" } },
    );

    expect(isInterrupted(result)).toBe(false);

    const messages = (result as { messages: BaseMessage[] }).messages;
    const toolResult = messages.find((message) => ToolMessage.isInstance(message));
    expect(toolResult?.text).toContain("catatan.txt");
    expect(messages.at(-1)?.text).toContain("catatan.txt");
  });

  it("menahan write_file sampai user menyetujui", async () => {
    const graph = createAgent([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_write",
            name: "write_file",
            args: { path: "hello.txt", content: "halo dunia" },
          },
        ],
      }),
      new AIMessage("File dibuat."),
    ]);

    const config = { configurable: { thread_id: "approve-write" } };
    const paused = await graph.invoke(
      { messages: [new HumanMessage("buat hello.txt")] },
      config,
    );

    const request = getInterruptRequest(paused);
    expect(request.calls).toHaveLength(1);
    expect(request.calls[0]?.name).toBe("write_file");

    await expect(
      fs.stat(path.join(workspace, "hello.txt")),
    ).rejects.toThrow();

    const resumed = await graph.invoke(
      new Command({ resume: { approved: [request.calls[0]!.id] } }),
      config,
    );

    expect(isInterrupted(resumed)).toBe(false);
    const content = await fs.readFile(
      path.join(workspace, "hello.txt"),
      "utf8",
    );
    expect(content).toBe("halo dunia");

    const messages = (resumed as { messages: BaseMessage[] }).messages;
    expect(messages.at(-1)?.text).toContain("File dibuat");

    const toolResult = messages.find(
      (message) =>
        ToolMessage.isInstance(message) && message.name === "write_file",
    );
    expect(toolResult?.text).toContain("Membuat hello.txt");
    expect(toolResult?.text).not.toContain('"lc":1');
  });

  it("melaporkan tool yang ditolak ke model", async () => {
    const graph = createAgent([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_write_rejected",
            name: "write_file",
            args: { path: "ditolak.txt", content: "jangan" },
          },
        ],
      }),
      new AIMessage("Baik, saya tidak membuat file."),
    ]);

    const config = { configurable: { thread_id: "reject-write" } };
    const paused = await graph.invoke(
      { messages: [new HumanMessage("buat ditolak.txt")] },
      config,
    );

    const request = getInterruptRequest(paused);
    const resumed = await graph.invoke(
      new Command({ resume: { approved: [] } }),
      config,
    );

    expect(request.calls[0]?.name).toBe("write_file");
    await expect(
      fs.stat(path.join(workspace, "ditolak.txt")),
    ).rejects.toThrow();

    const messages = (resumed as { messages: BaseMessage[] }).messages;
    const toolResult = messages.find(
      (message) =>
        ToolMessage.isInstance(message) &&
        message.text.includes("ditolak oleh user"),
    );
    expect(toolResult).toBeDefined();
  });

  it("stream messages berhenti di interrupt dan bisa di-resume", async () => {
    const graph = createAgent([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_stream_write",
            name: "write_file",
            args: { path: "stream.txt", content: "stream" },
          },
        ],
      }),
      new AIMessage("Tidak jadi menulis."),
    ]);

    const config = { configurable: { thread_id: "stream-approval" } };
    const stream = await graph.stream(
      { messages: [new HumanMessage("buat stream.txt")] },
      { ...config, streamMode: "messages" },
    );

    for await (const _chunk of stream) {
      // Konsumsi stream sampai graph berhenti di interrupt.
    }

    const snapshot = await graph.getState(config);
    const interrupts = snapshot.tasks.flatMap((task) => task.interrupts);
    expect(interrupts.length).toBeGreaterThan(0);

    const request = interrupts[0]?.value as ApprovalRequest;
    expect(request.calls[0]?.name).toBe("write_file");

    await graph.invoke(new Command({ resume: { approved: [] } }), config);
    await expect(
      fs.stat(path.join(workspace, "stream.txt")),
    ).rejects.toThrow();
  });

  it("bisa resume lewat stream multi-mode seperti CLI", async () => {
    const graph = createAgent([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_stream_resume",
            name: "write_file",
            args: { path: "resume.txt", content: "resume berhasil" },
          },
        ],
      }),
      new AIMessage("Selesai menulis."),
    ]);

    const config = { configurable: { thread_id: "stream-resume" } };
    const firstStream = await graph.stream(
      { messages: [new HumanMessage("buat resume.txt")] },
      { ...config, streamMode: ["messages", "updates"] },
    );

    for await (const _chunk of firstStream) {
      // Konsumsi stream sampai interrupt.
    }

    const paused = await graph.getState(config);
    const request = paused.tasks
      .flatMap((task) => task.interrupts)[0]?.value as ApprovalRequest;
    expect(request.calls[0]?.name).toBe("write_file");

    const resumeStream = await graph.stream(
      new Command({ resume: { approved: [request.calls[0]!.id] } }),
      { ...config, streamMode: ["messages", "updates"] },
    );

    for await (const _chunk of resumeStream) {
      // Konsumsi stream resume sampai selesai.
    }

    const content = await fs.readFile(
      path.join(workspace, "resume.txt"),
      "utf8",
    );
    expect(content).toBe("resume berhasil");
  });

  it("menyimpan riwayat percakapan per thread", async () => {
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel([
      new AIMessage("Halo, saya ingat."),
    ]);
    const graph = buildGraph({
      model,
      tools: createTools({
        workspaceDir: workspace,
        maxFileBytes: 200_000,
        maxOutputChars: 20_000,
        commandTimeoutMs: 10_000,
        maxIterations: 25,
      }),
      workspaceDir: workspace,
      checkpointer,
    });

    const config = { configurable: { thread_id: "memory" } };
    await graph.invoke(
      { messages: [new HumanMessage("nama saya Budi")] },
      config,
    );

    const snapshot = await graph.getState(config);
    const messages = (snapshot.values as { messages: BaseMessage[] }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toContain("Budi");
  });
});
