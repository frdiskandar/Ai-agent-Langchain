import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTools } from "../src/agent/tools/index.js";

let workspace: string;
let tools: StructuredToolInterface[];

function getTool(name: string): StructuredToolInterface {
  const selected = tools.find((entry) => entry.name === name);
  if (!selected) {
    throw new Error(`Tool ${name} tidak ditemukan`);
  }
  return selected;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ai-tools-"));
  tools = createTools({
    workspaceDir: workspace,
    maxFileBytes: 200_000,
    maxOutputChars: 20_000,
    commandTimeoutMs: 10_000,
    maxIterations: 25,
  });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("filesystem tools", () => {
  it("list_files menampilkan isi workspace", async () => {
    await fs.writeFile(path.join(workspace, "hello.txt"), "halo");
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};");

    const result = await getTool("list_files").invoke({
      path: ".",
      depth: 2,
    });

    expect(result).toContain("hello.txt");
    expect(result).toContain("src/");
    expect(result).toContain("src/index.ts");
  });

  it("read_file membaca isi file dan rentang baris", async () => {
    await fs.writeFile(
      path.join(workspace, "data.txt"),
      ["satu", "dua", "tiga"].join("\n"),
    );

    const full = await getTool("read_file").invoke({ path: "data.txt" });
    expect(full).toContain("satu\ndua\ntiga");

    const ranged = await getTool("read_file").invoke({
      path: "data.txt",
      startLine: 2,
      endLine: 3,
    });
    expect(ranged).toBe("dua\ntiga");
  });

  it("write_file membuat file baru beserta direktori induknya", async () => {
    const result = await getTool("write_file").invoke({
      path: "src/baru/hello.ts",
      content: 'export const hello = "world";\n',
    });

    expect(result).toContain("Membuat");
    const content = await fs.readFile(
      path.join(workspace, "src", "baru", "hello.ts"),
      "utf8",
    );
    expect(content).toBe('export const hello = "world";\n');
  });

  it("edit_file mengganti teks yang unik", async () => {
    await fs.writeFile(
      path.join(workspace, "app.ts"),
      "const value = 1;\nconsole.log(value);\n",
    );

    const result = await getTool("edit_file").invoke({
      path: "app.ts",
      oldString: "const value = 1;",
      newString: "const value = 42;",
    });

    expect(result).toContain("Mengubah");
    const content = await fs.readFile(path.join(workspace, "app.ts"), "utf8");
    expect(content).toContain("const value = 42;");
  });

  it("edit_file menolak oldString yang ambigu", async () => {
    await fs.writeFile(
      path.join(workspace, "dup.txt"),
      "sama\nsama\n",
    );

    await expect(
      getTool("edit_file").invoke({
        path: "dup.txt",
        oldString: "sama",
        newString: "beda",
      }),
    ).rejects.toThrow(/muncul 2 kali/);
  });

  it("menolak akses file di luar workspace", async () => {
    await expect(
      getTool("read_file").invoke({ path: "../rahasia.txt" }),
    ).rejects.toThrow(/di luar workspace|sandbox/);
  });
});

describe("search tools", () => {
  it("search_code menemukan baris yang cocok", async () => {
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(
      path.join(workspace, "src", "app.ts"),
      ["const a = 1;", "const needle = 2;", "console.log(needle);"].join("\n"),
    );

    const result = await getTool("search_code").invoke({
      pattern: "needle",
      path: ".",
    });

    expect(result).toContain("src/app.ts:2");
    expect(result).toContain("const needle = 2;");
  });
});

describe("shell tools", () => {
  it("run_command menjalankan command di workspace", async () => {
    const result = await getTool("run_command").invoke({
      command: "printf 'hello-from-test'",
    });

    expect(result).toContain("Exit code: 0");
    expect(result).toContain("hello-from-test");
  });

  it("run_command memblokir command berbahaya", async () => {
    await expect(
      getTool("run_command").invoke({ command: "rm -rf /" }),
    ).rejects.toThrow(/diblokir/);
  });

  it("git_status bekerja pada repository git", async () => {
    await fs.writeFile(path.join(workspace, "file.txt"), "halo");
    await getTool("run_command").invoke({ command: "git init -q" });

    const result = await getTool("git_status").invoke({});
    expect(result).toContain("file.txt");
  });
});
