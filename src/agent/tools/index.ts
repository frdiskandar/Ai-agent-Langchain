import type { StructuredToolInterface } from "@langchain/core/tools";
import { createFilesystemTools } from "./filesystem.js";
import { createSearchTools } from "./search.js";
import { createShellTools } from "./shell.js";
import type { ToolContext } from "./types.js";

export type { ToolContext } from "./types.js";
export { errorMessage } from "./types.js";

export const DANGEROUS_TOOLS = new Set([
  "write_file",
  "edit_file",
  "run_command",
]);

export function createTools(ctx: ToolContext): StructuredToolInterface[] {
  return [
    ...createFilesystemTools(ctx),
    ...createSearchTools(ctx),
    ...createShellTools(ctx),
  ];
}
