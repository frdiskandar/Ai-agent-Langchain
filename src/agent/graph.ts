import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  SystemMessage,
  ToolMessage,
  type ToolCall,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { z } from "zod";
import { buildSystemPrompt } from "./prompt.js";
import { AgentState } from "./state.js";
import { DANGEROUS_TOOLS, errorMessage } from "./tools/index.js";

export interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ApprovalRequest {
  type: "tool_approval";
  calls: PendingToolCall[];
}

export interface ApprovalDecision {
  approved: string[];
}

export interface BuildGraphOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  workspaceDir: string;
  checkpointer: BaseCheckpointSaver;
}

const ApprovalDecisionSchema = z.object({
  approved: z.array(z.string()),
});

function getLastToolCalls(messages: BaseMessage[]): ToolCall[] {
  const lastMessage = messages.at(-1);
  if (!AIMessage.isInstance(lastMessage)) {
    return [];
  }
  return lastMessage.tool_calls ?? [];
}

function toolCallId(call: ToolCall, index: number): string {
  return call.id ?? `${call.name}_${index}`;
}

export function buildGraph({
  model,
  tools,
  workspaceDir,
  checkpointer,
}: BuildGraphOptions) {
  if (!model.bindTools) {
    throw new Error("Model tidak mendukung tool calling.");
  }

  const modelWithTools = model.bindTools(tools);
  const toolsByName = new Map(tools.map((entry) => [entry.name, entry] as const));
  const systemPrompt = buildSystemPrompt(workspaceDir);

  const agent: typeof AgentState.Node = async (state) => {
    const response = await modelWithTools.invoke([
      new SystemMessage(systemPrompt),
      ...state.messages,
    ]);
    return { messages: [response] };
  };

  const approval: typeof AgentState.Node = async (state) => {
    const calls = getLastToolCalls(state.messages);
    const dangerousCalls = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => DANGEROUS_TOOLS.has(call.name));

    if (dangerousCalls.length === 0) {
      return { approvals: {} };
    }

    const request: ApprovalRequest = {
      type: "tool_approval",
      calls: dangerousCalls.map(({ call, index }) => ({
        id: toolCallId(call, index),
        name: call.name,
        args: call.args as Record<string, unknown>,
      })),
    };

    const decision = interrupt<ApprovalRequest, ApprovalDecision>(request, {
      responseSchema: ApprovalDecisionSchema,
    });
    const approved = new Set(decision?.approved ?? []);

    const approvals: Record<string, boolean> = {};
    calls.forEach((call, index) => {
      const id = toolCallId(call, index);
      approvals[id] = !DANGEROUS_TOOLS.has(call.name) || approved.has(id);
    });

    return { approvals };
  };

  const toolsNode: typeof AgentState.Node = async (state) => {
    const calls = getLastToolCalls(state.messages);
    const results: ToolMessage[] = [];

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (!call) {
        continue;
      }

      const id = toolCallId(call, index);
      const selectedTool = toolsByName.get(call.name);

      if (!selectedTool) {
        results.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content: `Tool "${call.name}" tidak ditemukan. Gunakan tool yang tersedia saja.`,
          }),
        );
        continue;
      }

      if (state.approvals[id] === false) {
        results.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content:
              'Aksi ditolak oleh user. Jangan ulangi aksi yang sama tanpa alasan baru; lanjutkan dengan pendekatan lain atau tanyakan kebutuhan user.',
          }),
        );
        continue;
      }

      try {
        const result = await selectedTool.invoke({
          ...call,
          id,
          type: "tool_call",
        });

        if (ToolMessage.isInstance(result)) {
          results.push(result);
          continue;
        }

        const content =
          typeof result === "string"
            ? result
            : (JSON.stringify(result) ?? String(result));

        results.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content,
          }),
        );
      } catch (error) {
        results.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content: `Error saat menjalankan ${call.name}: ${errorMessage(error)}`,
          }),
        );
      }
    }

    return { messages: results, approvals: {} };
  };

  const routeAfterAgent = (
    state: typeof AgentState.State,
  ): "approval" | "tools" | typeof END => {
    const calls = getLastToolCalls(state.messages);
    if (calls.length === 0) {
      return END;
    }
    if (calls.some((call) => DANGEROUS_TOOLS.has(call.name))) {
      return "approval";
    }
    return "tools";
  };

  return new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["approval", "tools", END])
    .addEdge("approval", "tools")
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

export type CodingAgentGraph = ReturnType<typeof buildGraph>;
