import fs from "node:fs/promises";
import path from "node:path";

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessError";
  }
}

const DENIED_SEGMENTS = new Set([".git", "node_modules", ".ssh"]);

const DENIED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|crt)$/i,
];

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isInsideWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertNotDenied(relativePath: string): void {
  const posixPath = toPosix(relativePath);
  if (posixPath === "" || posixPath === ".") {
    return;
  }

  const segments = posixPath.split("/").filter(Boolean);
  const deniedSegment = segments.find((segment) => DENIED_SEGMENTS.has(segment));
  if (deniedSegment) {
    throw new PathAccessError(
      `Akses ke "${deniedSegment}" diblokir oleh sandbox workspace.`,
    );
  }

  const fileName = segments.at(-1) ?? "";
  if (DENIED_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
    throw new PathAccessError(`File sensitif "${fileName}" diblokir oleh sandbox.`);
  }
}

async function nearestExistingAncestor(targetPath: string): Promise<string> {
  let current = targetPath;

  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export interface ResolvePathOptions {
  /** Izinkan path yang belum ada, misalnya untuk membuat file baru. */
  allowMissing?: boolean;
}

export async function resolveWorkspacePath(
  workspaceDir: string,
  targetPath: string,
  options: ResolvePathOptions = {},
): Promise<string> {
  const root = await fs.realpath(workspaceDir);
  const resolved = path.resolve(root, targetPath);

  if (!isInsideWorkspace(root, resolved)) {
    throw new PathAccessError(
      `Path "${targetPath}" berada di luar workspace (${root}).`,
    );
  }

  const relative = path.relative(root, resolved) || ".";
  assertNotDenied(relative);

  const checkPath = options.allowMissing
    ? await nearestExistingAncestor(resolved)
    : resolved;

  let realCheckPath: string;
  try {
    realCheckPath = await fs.realpath(checkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PathAccessError(`Path tidak ditemukan: ${relative}`);
    }
    throw error;
  }

  if (!isInsideWorkspace(root, realCheckPath)) {
    throw new PathAccessError(
      `Path "${relative}" mengarah ke luar workspace melalui symlink.`,
    );
  }

  return resolved;
}

export function relativeToWorkspace(
  workspaceDir: string,
  absolutePath: string,
): string {
  return toPosix(path.relative(workspaceDir, absolutePath)) || ".";
}
