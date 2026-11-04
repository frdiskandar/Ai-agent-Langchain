import { tool } from "@langchain/core/tools";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  relativeToWorkspace,
  resolveWorkspacePath,
} from "../../utils/paths.js";
import { truncateText } from "../../utils/output.js";
import type { ToolContext } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".ssh",
  "dist",
  ".next",
  "coverage",
]);

interface SearchOptions {
  workspaceDir: string;
  pattern: string;
  searchPath: string;
  glob?: string;
  caseSensitive: boolean;
  maxResults: number;
}

function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(
      `Regex tidak valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function searchWithRipgrep(options: SearchOptions): Promise<string> {
  const relativePath = relativeToWorkspace(
    options.workspaceDir,
    options.searchPath,
  );

  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--with-filename",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!.git/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!.ssh/**",
  ];

  if (!options.caseSensitive) {
    args.push("--ignore-case");
  }
  if (options.glob) {
    args.push("--glob", options.glob);
  }

  args.push("--", options.pattern, relativePath);

  const result = await execa("rg", args, {
    cwd: options.workspaceDir,
    reject: false,
    timeout: 20_000,
    all: true,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });

  if (result.exitCode === 1) {
    return "Tidak ada hasil.";
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "ripgrep gagal.");
  }

  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return "Tidak ada hasil.";
  }

  const limited = lines.slice(0, options.maxResults);
  const suffix =
    lines.length > options.maxResults
      ? `\n... (${lines.length - options.maxResults} hasil lainnya tidak ditampilkan)`
      : "";

  return truncateText(`${limited.join("\n")}${suffix}`, 20_000, "hasil dipotong");
}

async function searchWithJs(options: SearchOptions): Promise<string> {
  const regex = compilePattern(options.pattern, options.caseSensitive);
  const results: string[] = [];
  const stat = await fs.stat(options.searchPath);

  const inspectFile = async (absolute: string) => {
    if (results.length >= options.maxResults) {
      return;
    }

    const fileStat = await fs.stat(absolute).catch(() => null);
    if (!fileStat || !fileStat.isFile() || fileStat.size > 1_000_000) {
      return;
    }

    const content = await fs.readFile(absolute, "utf8").catch(() => "");
    if (content.includes("\u0000")) {
      return;
    }

    const relative = relativeToWorkspace(options.workspaceDir, absolute);
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      if (results.length >= options.maxResults) {
        return;
      }
      const line = lines[index] ?? "";
      regex.lastIndex = 0;
      if (regex.test(line)) {
        results.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    }
  };

  const walk = async (absolute: string) => {
    if (results.length >= options.maxResults) {
      return;
    }

    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (results.length >= options.maxResults) {
        return;
      }
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      // Hindari symlink agar pencarian tidak keluar dari workspace.
      if (entry.isSymbolicLink()) {
        continue;
      }

      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        await inspectFile(child);
      }
    }
  };

  if (stat.isDirectory()) {
    await walk(options.searchPath);
  } else {
    await inspectFile(options.searchPath);
  }

  if (results.length === 0) {
    return "Tidak ada hasil.";
  }

  return truncateText(results.join("\n"), 20_000, "hasil dipotong");
}

export function createSearchTools(ctx: ToolContext) {
  const searchCode = tool(
    async ({
      pattern,
      path: inputPath = ".",
      glob,
      caseSensitive = false,
      maxResults = 50,
    }: {
      pattern: string;
      path?: string;
      glob?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    }) => {
      const searchPath = await resolveWorkspacePath(
        ctx.workspaceDir,
        inputPath,
      );

      const options: SearchOptions = {
        workspaceDir: ctx.workspaceDir,
        pattern,
        searchPath,
        glob,
        caseSensitive,
        maxResults,
      };

      try {
        return await searchWithRipgrep(options);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return searchWithJs(options);
        }
        throw error;
      }
    },
    {
      name: "search_code",
      description:
        "Search file contents inside the workspace using a regular expression. Prefers ripgrep, with a JavaScript fallback.",
      schema: z.object({
        pattern: z.string().min(1),
        path: z.string().optional().default("."),
        glob: z.string().optional(),
        caseSensitive: z.boolean().optional().default(false),
        maxResults: z.number().int().min(1).max(200).optional().default(50),
      }),
    },
  );

  return [searchCode] as const;
}
