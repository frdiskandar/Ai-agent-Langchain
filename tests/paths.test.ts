import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotDenied,
  PathAccessError,
  resolveWorkspacePath,
} from "../src/utils/paths.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ai-paths-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
  it("mengizinkan path di dalam workspace", async () => {
    const resolved = await resolveWorkspacePath(workspace, "src/index.ts", {
      allowMissing: true,
    });
    expect(resolved).toBe(path.join(workspace, "src/index.ts"));
  });

  it("menolak path yang keluar dari workspace", async () => {
    await expect(
      resolveWorkspacePath(workspace, "../rahasia.txt", { allowMissing: true }),
    ).rejects.toBeInstanceOf(PathAccessError);
  });

  it("menolak absolute path di luar workspace", async () => {
    await expect(
      resolveWorkspacePath(workspace, "/etc/passwd", { allowMissing: true }),
    ).rejects.toBeInstanceOf(PathAccessError);
  });

  it("menolak file sensitif", async () => {
    await expect(
      resolveWorkspacePath(workspace, ".env", { allowMissing: true }),
    ).rejects.toBeInstanceOf(PathAccessError);

    await expect(
      resolveWorkspacePath(workspace, "config/secret.pem", {
        allowMissing: true,
      }),
    ).rejects.toBeInstanceOf(PathAccessError);
  });

  it("menolak direktori yang diblokir", async () => {
    await expect(
      resolveWorkspacePath(workspace, "node_modules/pkg/index.js", {
        allowMissing: true,
      }),
    ).rejects.toBeInstanceOf(PathAccessError);

    await expect(
      resolveWorkspacePath(workspace, ".git/config", { allowMissing: true }),
    ).rejects.toBeInstanceOf(PathAccessError);
  });

  it("menolak symlink yang mengarah keluar workspace", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentic-ai-outside-"),
    );
    await fs.writeFile(path.join(outside, "secret.txt"), "rahasia");
    await fs.symlink(outside, path.join(workspace, "escape"), "dir");

    try {
      await expect(
        resolveWorkspacePath(workspace, "escape/secret.txt"),
      ).rejects.toBeInstanceOf(PathAccessError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("assertNotDenied", () => {
  it("mengizinkan path normal", () => {
    expect(() => assertNotDenied("src/agent/graph.ts")).not.toThrow();
  });

  it("menolak segmen terlarang", () => {
    expect(() => assertNotDenied(".git/config")).toThrow(PathAccessError);
    expect(() => assertNotDenied("node_modules/x/y.js")).toThrow(
      PathAccessError,
    );
  });
});
