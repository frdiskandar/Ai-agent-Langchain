import type { Interface } from "node:readline/promises";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../agent/graph.js";
import { formatJson, style } from "../utils/output.js";

export async function promptApproval(
  rl: Interface,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const approved: string[] = [];

  console.log(`\n${style.yellow("⚠ Persetujuan diperlukan")}`);

  for (const call of request.calls) {
    console.log(`\n${style.bold(call.name)} ${style.gray(`(${call.id})`)}`);
    console.log(style.dim(formatJson(call.args)));

    const answer = await rl
      .question(`Setujui ${style.bold(call.name)}? ${style.dim("[y/N]")} `)
      .catch(() => null);

    if (answer === null) {
      console.log(style.yellow("  (input ditutup, aksi dianggap ditolak)"));
      break;
    }

    if (/^y(es)?$/i.test(answer.trim())) {
      approved.push(call.id);
      console.log(style.green("  ✓ disetujui"));
    } else {
      console.log(style.red("  ✗ ditolak"));
    }
  }

  return { approved };
}
