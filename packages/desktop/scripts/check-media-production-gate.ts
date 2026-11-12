import { appendFile } from "node:fs/promises";
import { PENDING_HANDLERS } from "@siteindex/shared";
import { isMediaPrepareContractOpen } from "../src/main/media-contract-gate.js";

const ready = isMediaPrepareContractOpen(PENDING_HANDLERS);
const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) await appendFile(outputPath, `media_prepare_ready=${ready}\n`, "utf8");

if (!ready && process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    "\n`media.prepare` remains pending. Production UI and Desktop readiness were not bypassed; packaged media acceptance did not run. The contract PR must run this workflow with the pending marker removed.\n",
    "utf8",
  );
}

process.stdout.write(`media.prepare contract gate: ${ready ? "open" : "pending"}\n`);
