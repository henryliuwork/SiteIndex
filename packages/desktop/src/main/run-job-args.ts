import type { JobName } from "@siteindex/shared";
import { isJobName } from "./job-protocol.js";

export interface RunJobArguments {
  projectPath: string;
  job: JobName;
}

export function parseRunJobArguments(argv: readonly string[]): RunJobArguments | null {
  const index = argv.indexOf("--run-job");
  if (index < 0) return null;
  const projectPath = argv[index + 1];
  const job = argv[index + 2];
  if (!projectPath?.trim() || !isJobName(job) || argv[index + 3] !== undefined) return null;
  return { projectPath, job };
}
