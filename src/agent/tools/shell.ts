import { tool } from "@langchain/core/tools";
import { execa } from "execa";
import { z } from "zod";
import {
  relativeToWorkspace,
  resolveWorkspacePath,
} from "../../utils/paths.js";
import { truncateText } from "../../utils/output.js";
import type { ToolContext } from "./types.js";

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /(^|[\s;&|])(sudo|su|doas)\b/i,
  /\b(shutdown|reboot|poweroff|halt|mkfs|fdisk|parted)\b/i,
  /\bdd\s+if=/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\/\*|~|\$HOME)(\s|$)/i,
  /:\(\)\s*\{/,
  /\bchmod\s+-R\s+777\s+\//i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
];

function assertSafeCommand(command: string): void {
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command diblokir oleh pengaman: "${command}". Jalankan manual jika benar-benar diperlukan.`,
      );
    }
  }
}

const COMMAND_ENV = {
  ...process.env,
  GIT_PAGER: "cat",
  PAGER: "cat",
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
};

export function createShellTools(ctx: ToolContext) {
  const runCommand = tool(
    async ({
      command,
      cwd = ".",
      timeoutMs,
    }: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
    }) => {
      assertSafeCommand(command);

      const workingDirectory = await resolveWorkspacePath(
        ctx.workspaceDir,
        cwd,
      );
      const timeout = Math.min(
        timeoutMs ?? ctx.commandTimeoutMs,
        ctx.commandTimeoutMs,
      );

      const result = await execa(command, {
        shell: true,
        cwd: workingDirectory,
        reject: false,
        timeout,
        all: true,
        stdin: "ignore",
        maxBuffer: 10 * 1024 * 1024,
        env: COMMAND_ENV,
      });

      const output = (result.all ?? "").trim();
      const header = `$ ${command} (cwd: ${relativeToWorkspace(
        ctx.workspaceDir,
        workingDirectory,
      )})`;
      const status = result.timedOut
        ? `Timeout setelah ${timeout} ms.`
        : `Exit code: ${result.exitCode ?? "unknown"}`;

      return truncateText(
        `${header}\n${status}\n\n${output || "(tanpa output)"}`,
        ctx.maxOutputChars,
        "output command dipotong",
      );
    },
    {
      name: "run_command",
      description:
        "Run a non-interactive shell command inside the workspace with a timeout. Requires user approval.",
      schema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional().default("."),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
    },
  );

  const gitStatus = tool(
    async () => {
      const result = await execa("git", ["status", "--short", "--branch"], {
        cwd: ctx.workspaceDir,
        reject: false,
        timeout: 20_000,
        all: true,
        stdin: "ignore",
        maxBuffer: 5 * 1024 * 1024,
        env: COMMAND_ENV,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Bukan git repository atau git gagal: ${
            result.stderr || result.stdout
          }`,
        );
      }

      return result.stdout.trim() || "Working tree bersih.";
    },
    {
      name: "git_status",
      description:
        "Show short git status and current branch for the workspace. Read-only.",
      schema: z.object({}),
    },
  );

  const gitDiff = tool(
    async ({
      staged = false,
      path: inputPath,
    }: {
      staged?: boolean;
      path?: string;
    }) => {
      const args = ["diff"];

      if (staged) {
        args.push("--staged");
      }

      if (inputPath) {
        const absolute = await resolveWorkspacePath(
          ctx.workspaceDir,
          inputPath,
          { allowMissing: true },
        );
        args.push("--", relativeToWorkspace(ctx.workspaceDir, absolute));
      }

      const result = await execa("git", args, {
        cwd: ctx.workspaceDir,
        reject: false,
        timeout: 20_000,
        all: true,
        stdin: "ignore",
        maxBuffer: 10 * 1024 * 1024,
        env: COMMAND_ENV,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `git diff gagal: ${result.stderr || result.stdout}`,
        );
      }

      const output = result.stdout.trim();
      if (!output) {
        return "Tidak ada perubahan.";
      }

      return truncateText(output, ctx.maxOutputChars, "diff dipotong");
    },
    {
      name: "git_diff",
      description:
        "Show git diff for the workspace or a specific path. Read-only.",
      schema: z.object({
        staged: z.boolean().optional().default(false),
        path: z.string().optional(),
      }),
    },
  );

  return [runCommand, gitStatus, gitDiff] as const;
}
