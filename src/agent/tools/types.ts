export interface ToolContext {
  workspaceDir: string;
  maxFileBytes: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  maxIterations: number;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
