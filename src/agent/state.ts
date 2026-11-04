import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export const AgentState = new StateSchema({
  messages: MessagesValue,
  /**
   * Keputusan approval per tool call id.
   * Diisi oleh node approval lalu dikosongkan lagi oleh node tools.
   */
  approvals: z.record(z.string(), z.boolean()).default(() => ({})),
});

export type AgentStateValue = typeof AgentState.State;
