import { tool } from "@langchain/core/tools";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  relativeToWorkspace,
  resolveWorkspacePath,
} from "../../utils/paths.js";
import { formatBytes, truncateText } from "../../utils/output.js";
import type { ToolContext } from "./types.js";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".ssh", "dist"]);

export function createFilesystemTools(ctx: ToolContext) {
  const listFiles = tool(
    async ({
      path: inputPath = ".",
      depth = 2,
      maxEntries = 400,
    }: {
      path?: string;
      depth?: number;
      maxEntries?: number;
    }) => {
      const root = await resolveWorkspacePath(ctx.workspaceDir, inputPath);
      const rootStat = await fs.stat(root);
      if (!rootStat.isDirectory()) {
        throw new Error(`"${inputPath}" bukan direktori.`);
      }

      const lines: string[] = [];
      let truncated = false;

      const walk = async (directory: string, currentDepth: number) => {
        if (lines.length >= maxEntries) {
          truncated = true;
          return;
        }

        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) {
            return left.isDirectory() ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });

        for (const entry of entries) {
          if (lines.length >= maxEntries) {
            truncated = true;
            return;
          }
          if (IGNORED_DIRECTORIES.has(entry.name)) {
            continue;
          }

          const absolute = path.join(directory, entry.name);
          const relative = relativeToWorkspace(ctx.workspaceDir, absolute);

          if (entry.isSymbolicLink()) {
            lines.push(`${relative} -> (symlink)`);
            continue;
          }

          if (entry.isDirectory()) {
            lines.push(`${relative}/`);
            if (currentDepth < depth) {
              await walk(absolute, currentDepth + 1);
            }
          } else {
            const stat = await fs.stat(absolute).catch(() => null);
            lines.push(
              stat ? `${relative} (${formatBytes(stat.size)})` : relative,
            );
          }
        }
      };

      await walk(root, 1);

      if (lines.length === 0) {
        return "(direktori kosong)";
      }

      return `${lines.join("\n")}${
        truncated ? "\n... (daftar file dipotong)" : ""
      }`;
    },
    {
      name: "list_files",
      description:
        "List files and directories inside the workspace. Skips .git, node_modules, .ssh, and dist.",
      schema: z.object({
        path: z.string().optional().default("."),
        depth: z.number().int().min(1).max(5).optional().default(2),
        maxEntries: z.number().int().min(1).max(1_000).optional().default(400),
      }),
    },
  );

  const readFile = tool(
    async ({
      path: inputPath,
      startLine,
      endLine,
    }: {
      path: string;
      startLine?: number;
      endLine?: number;
    }) => {
      const absolute = await resolveWorkspacePath(ctx.workspaceDir, inputPath);
      const stat = await fs.stat(absolute);

      if (!stat.isFile()) {
        throw new Error(`"${inputPath}" bukan file.`);
      }
      if (stat.size > ctx.maxFileBytes) {
        throw new Error(
          `File terlalu besar (${formatBytes(stat.size)}). Batas: ${formatBytes(
            ctx.maxFileBytes,
          )}. Gunakan startLine/endLine atau search_code.`,
        );
      }

      const content = await fs.readFile(absolute, "utf8");
      if (content.includes("\u0000")) {
        throw new Error(`"${inputPath}" terlihat seperti file binary.`);
      }

      if (startLine === undefined && endLine === undefined) {
        return truncateText(content, ctx.maxOutputChars, "isi file dipotong");
      }

      const lines = content.split(/\r?\n/);
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);

      if (start > end) {
        throw new Error(
          `Rentang baris tidak valid: startLine=${start}, endLine=${end}.`,
        );
      }

      return truncateText(
        lines.slice(start - 1, end).join("\n"),
        ctx.maxOutputChars,
        "isi file dipotong",
      );
    },
    {
      name: "read_file",
      description:
        "Read a text file from the workspace. Optionally limit to a line range with startLine and endLine (1-based).",
      schema: z.object({
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
    },
  );

  const writeFile = tool(
    async ({
      path: inputPath,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      const absolute = await resolveWorkspacePath(
        ctx.workspaceDir,
        inputPath,
        { allowMissing: true },
      );

      const previous = await fs.stat(absolute).catch(() => null);
      if (previous?.isDirectory()) {
        throw new Error(`"${inputPath}" adalah direktori, bukan file.`);
      }

      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");

      const relative = relativeToWorkspace(ctx.workspaceDir, absolute);
      return `${previous ? "Menimpa" : "Membuat"} ${relative} (${formatBytes(
        Buffer.byteLength(content, "utf8"),
      )}).`;
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file inside the workspace. Requires user approval.",
      schema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    },
  );

  const editFile = tool(
    async ({
      path: inputPath,
      oldString,
      newString,
      replaceAll = false,
    }: {
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }) => {
      if (oldString === newString) {
        return "Tidak ada perubahan: oldString dan newString identik.";
      }

      const absolute = await resolveWorkspacePath(ctx.workspaceDir, inputPath);
      const stat = await fs.stat(absolute);

      if (!stat.isFile()) {
        throw new Error(`"${inputPath}" bukan file.`);
      }

      const content = await fs.readFile(absolute, "utf8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        throw new Error(
          `oldString tidak ditemukan di "${inputPath}". Baca ulang file dan gunakan teks yang persis sama.`,
        );
      }

      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString muncul ${occurrences} kali di "${inputPath}". Sertakan konteks lebih banyak atau set replaceAll=true.`,
        );
      }

      let updated: string;
      if (replaceAll) {
        updated = content.split(oldString).join(newString);
      } else {
        const index = content.indexOf(oldString);
        updated =
          content.slice(0, index) +
          newString +
          content.slice(index + oldString.length);
      }

      await fs.writeFile(absolute, updated, "utf8");
      const relative = relativeToWorkspace(ctx.workspaceDir, absolute);
      return `Mengubah ${relative} (${occurrences} kemunculan${
        replaceAll ? "" : ", pertama saja"
      }).`;
    },
    {
      name: "edit_file",
      description:
        "Replace an exact string in an existing file. Fails if oldString is missing or ambiguous. Requires user approval.",
      schema: z.object({
        path: z.string().min(1),
        oldString: z.string().min(1),
        newString: z.string(),
        replaceAll: z.boolean().optional().default(false),
      }),
    },
  );

  return [listFiles, readFile, writeFile, editFile] as const;
}
