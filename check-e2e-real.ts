import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ai-e2e-real-"));
const dbPath = path.join(workspace, "checkpoints.sqlite");

const child = spawn(
  "pnpm",
  ["exec", "tsx", "src/index.ts", "--dir", workspace, "--db", dbPath],
  {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let output = "";
let sentUser = false;
let approvalsSent = 0;
let sentExit = false;

const sanitize = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const count = (value: string, needle: string) => value.split(needle).length - 1;

const maybeInteract = () => {
  const plain = sanitize(output);

  if (!sentUser && plain.includes("you ")) {
    sentUser = true;
    child.stdin.write(
      'Buat file from-lmstudio.txt di root workspace dengan isi: "halo lmstudio". Gunakan tool write_file dengan path relatif.\n',
    );
    return;
  }

  const prompts =
    count(plain, "Setujui write_file?") +
    count(plain, "Setujui edit_file?") +
    count(plain, "Setujui run_command?");

  if (prompts > approvalsSent && approvalsSent < 4) {
    approvalsSent += 1;
    child.stdin.write("y\n");
    return;
  }

  if (
    !sentExit &&
    sentUser &&
    prompts === approvalsSent &&
    count(plain, "you ") >= 2
  ) {
    sentExit = true;
    child.stdin.write("/exit\n");
  }
};

child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
  process.stdout.write(chunk);
  maybeInteract();
});

child.stderr.on("data", (chunk: Buffer) => {
  output += chunk.toString();
  process.stderr.write(chunk);
  maybeInteract();
});

const timer = setTimeout(() => {
  console.error("\n[timeout] menghentikan proses");
  child.kill("SIGKILL");
}, 280_000);

await new Promise<void>((resolve) => {
  child.on("close", () => resolve());
});
clearTimeout(timer);

const plain = sanitize(output);
const fileContent = await fs
  .readFile(path.join(workspace, "from-lmstudio.txt"), "utf8")
  .catch(() => "(file tidak ditemukan)");

console.log("\n=== VERIFIKASI ===");
console.log("preflight LM Studio:", plain.includes("LM Studio siap"));
console.log("approval muncul:", plain.includes("Persetujuan diperlukan"));
console.log("jumlah approval dijawab:", approvalsSent);
console.log("tool result bersih:", !plain.includes('"lc":1'));
console.log("isi file:", JSON.stringify(fileContent));

await fs.rm(workspace, { recursive: true, force: true });
