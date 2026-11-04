import fs from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function createCheckpointer(dbPath: string): SqliteSaver {
  const absolutePath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  return SqliteSaver.fromConnString(absolutePath);
}

export function closeCheckpointer(checkpointer: SqliteSaver): void {
  try {
    checkpointer.db.close();
  } catch {
    // Abaikan error saat menutup database yang sudah tertutup.
  }
}
