/**
 * @siteindex/cli — 工作流 A 负责。
 * 打包后由 desktop 输出为 resources/cli.js，经 ELECTRON_RUN_AS_NODE=1 运行。
 * 命令表见 docs/ARCHITECTURE.md §6；退出码见 @siteindex/shared EXIT。
 */
import { CLI_BIN, CLI_COMMANDS, EXIT } from "@siteindex/shared";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [cmd] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    io.out(`用法: ${CLI_BIN} <命令> [参数]\n命令: ${CLI_COMMANDS.join(", ")}`);
    return EXIT.OK;
  }
  if (!(CLI_COMMANDS as readonly string[]).includes(cmd)) {
    io.err(`未知命令: ${cmd}`);
    return EXIT.BAD_ARGS;
  }
  io.err(`命令 ${cmd} 尚未实现`);
  return EXIT.BAD_ARGS;
}
