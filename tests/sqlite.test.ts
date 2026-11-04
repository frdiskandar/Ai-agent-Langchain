import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  END,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCheckpointer, createCheckpointer } from "../src/memory/sqlite.js";

const State = new StateSchema({
  messages: MessagesValue,
});

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ai-sqlite-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function buildEchoGraph(checkpointer: ReturnType<typeof createCheckpointer>) {
  return new StateGraph(State)
    .addNode("echo", () => ({ messages: [new AIMessage("halo kembali")] }))
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile({ checkpointer });
}

describe("SQLite checkpointer", () => {
  it("menyimpan riwayat dan membacanya lagi setelah dibuka ulang", async () => {
    const dbPath = path.join(workspace, "checkpoints.sqlite");
    const config = { configurable: { thread_id: "persisten" } };

    const firstSaver = createCheckpointer(dbPath);
    const firstGraph = buildEchoGraph(firstSaver);

    await firstGraph.invoke(
      { messages: [new HumanMessage("halo")] },
      config,
    );
    closeCheckpointer(firstSaver);

    const secondSaver = createCheckpointer(dbPath);
    const secondGraph = buildEchoGraph(secondSaver);

    const snapshot = await secondGraph.getState(config);
    const messages = (snapshot.values as { messages: BaseMessage[] }).messages;

    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toContain("halo");
    expect(messages[1]?.text).toContain("halo kembali");

    closeCheckpointer(secondSaver);
  });
});
