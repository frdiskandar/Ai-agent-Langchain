import { randomUUID } from "node:crypto";
import type { Interface } from "node:readline/promises";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command, type StateSnapshot } from "@langchain/langgraph";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodingAgentGraph,
} from "../agent/graph.js";
import { providerLabel } from "../agent/model.js";
import { errorMessage } from "../agent/tools/index.js";
import type { AppConfig } from "../config.js";
import { previewText, style } from "../utils/output.js";
import { promptApproval } from "./approval.js";

function newThreadId(): string {
  return `thread-${randomUUID()}`;
}

type AgentCommand = Command<
  ApprovalDecision,
  { messages?: BaseMessage[]; approvals?: Record<string, boolean> },
  "agent" | "approval" | "tools"
>;

function getMessages(snapshot: StateSnapshot): BaseMessage[] {
  const values = snapshot.values as { messages?: unknown } | null | undefined;
  return Array.isArray(values?.messages)
    ? (values.messages as BaseMessage[])
    : [];
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; calls?: unknown };
  return candidate.type === "tool_approval" && Array.isArray(candidate.calls);
}

function getApprovalRequest(snapshot: StateSnapshot): ApprovalRequest | null {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      if (isApprovalRequest(item.value)) {
        return item.value;
      }
    }
  }
  return null;
}

function printNewActivity(messages: BaseMessage[]): void {
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        console.log(
          `${style.magenta("→ tool")} ${style.bold(call.name)} ${style.dim(
            previewText(JSON.stringify(call.args), 300),
          )}`,
        );
      }
      continue;
    }

    if (ToolMessage.isInstance(message)) {
      console.log(
        `${style.green("← hasil")} ${style.bold(
          message.name ?? "tool",
        )}: ${style.dim(previewText(message.text, 300))}`,
      );
    }
  }
}

function printUpdates(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  for (const [nodeName, update] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (
      nodeName === "__interrupt__" ||
      !update ||
      typeof update !== "object"
    ) {
      continue;
    }

    const messages = (update as { messages?: unknown }).messages;
    if (Array.isArray(messages)) {
      printNewActivity(messages as BaseMessage[]);
    }
  }
}

function printHistory(messages: BaseMessage[]): void {
  if (messages.length === 0) {
    console.log(style.dim("(belum ada riwayat untuk thread ini)"));
    return;
  }

  for (const message of messages.slice(-20)) {
    const type = message.getType();
    const role =
      type === "human" ? "you" : type === "ai" ? "agent" : type;
    const calls = AIMessage.isInstance(message)
      ? (message.tool_calls ?? [])
      : [];
    const summary = message.text
      ? previewText(message.text, 200)
      : calls.length > 0
        ? calls.map((call) => `${call.name}(...)`).join(", ")
        : "(kosong)";

    console.log(`${style.cyan(role)}: ${summary}`);
  }
}

async function runTurn(
  graph: CodingAgentGraph,
  runtimeConfig: RunnableConfig,
  rl: Interface,
  initialInput: { messages: BaseMessage[] },
): Promise<void> {
  let input: { messages: BaseMessage[] } | AgentCommand = initialInput;

  while (true) {
    const beforeSnapshot = await graph
      .getState(runtimeConfig)
      .catch(() => null);
    const beforeCount = beforeSnapshot
      ? getMessages(beforeSnapshot).length
      : 0;

    process.stdout.write(`\n${style.cyan("agent")} `);

    let wroteText = false;
    let sawUpdates = false;
    const stream = await graph.stream(input, {
      ...runtimeConfig,
      streamMode: ["messages", "updates"],
    });

    for await (const item of stream) {
      const [mode, payload] = item as unknown as [string, unknown];

      if (mode === "updates") {
        sawUpdates = true;
        printUpdates(payload);
        continue;
      }

      if (mode !== "messages") {
        continue;
      }

      const [chunk, metadata] = payload as [
        BaseMessage,
        Record<string, unknown>,
      ];
      const node = metadata.langgraph_node;
      if (node && node !== "agent") {
        continue;
      }
      const text = chunk.text;
      if (text) {
        process.stdout.write(text);
        wroteText = true;
      }
    }

    const snapshot = await graph.getState(runtimeConfig);

    if (!wroteText) {
      const messages = getMessages(snapshot);
      const lastMessage = messages.at(-1);
      if (
        AIMessage.isInstance(lastMessage) &&
        (lastMessage.tool_calls?.length ?? 0) === 0 &&
        lastMessage.text
      ) {
        process.stdout.write(lastMessage.text);
      }
    }

    process.stdout.write("\n");

    if (!sawUpdates) {
      printNewActivity(getMessages(snapshot).slice(beforeCount));
    }

    const request = getApprovalRequest(snapshot);
    if (!request) {
      return;
    }

    const decision = await promptApproval(rl, request);
    const command: AgentCommand = new Command({ resume: decision });
    input = command;
  }
}

function printHelp(): void {
  console.log(
    [
      "",
      style.bold("Perintah:"),
      "  /help          tampilkan bantuan",
      "  /new           mulai thread percakapan baru",
      "  /thread        tampilkan thread id aktif",
      "  /thread <id>   lanjutkan thread tertentu",
      "  /history       tampilkan 20 pesan terakhir",
      "  /exit          keluar",
      "",
      "Tool read-only langsung dijalankan. write_file, edit_file, dan",
      "run_command akan meminta persetujuan y/N sebelum dieksekusi.",
    ].join("\n"),
  );
}

export interface StartReplOptions {
  config: AppConfig;
  graph: CodingAgentGraph;
  rl: Interface;
}

export async function startRepl({
  config,
  graph,
  rl,
}: StartReplOptions): Promise<void> {
  let threadId = newThreadId();

  console.log(`\n${style.bold("Agentic AI · Coding Agent")}`);
  console.log(
    `${style.dim("Provider  ")} ${providerLabel(config.provider)}`,
  );
  console.log(`${style.dim("Model     ")} ${config.model}`);
  console.log(`${style.dim("Endpoint  ")} ${config.baseUrl}`);
  console.log(`${style.dim("Workspace ")} ${config.workspaceDir}`);
  console.log(`${style.dim("Memory    ")} ${config.sqlitePath}`);
  console.log(`${style.dim("Thread    ")} ${threadId}`);
  console.log(
    style.dim("\nKetik /help untuk daftar perintah. /exit untuk keluar."),
  );

  while (true) {
    let input: string;
    try {
      input = await rl.question(`\n${style.cyan("you")} `);
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed === "/exit" || trimmed === "/quit") {
      break;
    }

    if (trimmed === "/help") {
      printHelp();
      continue;
    }

    if (trimmed === "/new") {
      threadId = newThreadId();
      console.log(`${style.green("Thread baru:")} ${threadId}`);
      continue;
    }

    if (trimmed === "/thread") {
      console.log(`${style.dim("Thread aktif:")} ${threadId}`);
      continue;
    }

    if (trimmed.startsWith("/thread ")) {
      const nextThreadId = trimmed.slice("/thread ".length).trim();
      if (nextThreadId) {
        threadId = nextThreadId;
        console.log(`${style.green("Pindah ke thread:")} ${threadId}`);
      } else {
        console.log(style.yellow("Format: /thread <id>"));
      }
      continue;
    }

    if (trimmed === "/history") {
      try {
        const snapshot = await graph.getState({
          configurable: { thread_id: threadId },
        });
        printHistory(getMessages(snapshot));
      } catch {
        console.log(style.dim("(belum ada riwayat untuk thread ini)"));
      }
      continue;
    }

    if (trimmed.startsWith("/")) {
      console.log(style.red(`Perintah tidak dikenal: ${trimmed}`));
      console.log(style.dim("Ketik /help untuk daftar perintah."));
      continue;
    }

    const runtimeConfig: RunnableConfig = {
      configurable: { thread_id: threadId },
      recursionLimit: config.maxIterations * 2 + 5,
    };

    try {
      await runTurn(graph, runtimeConfig, rl, {
        messages: [new HumanMessage(trimmed)],
      });
    } catch (error) {
      console.error(`\n${style.red(`Error: ${errorMessage(error)}`)}`);
    }
  }

  console.log(style.dim("\nSampai jumpa."));
}
