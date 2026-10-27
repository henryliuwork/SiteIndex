import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  throw new Error(`Release tag 必须为不带后缀的三段数字版本：${tag}`);
}
if (`v${version}` !== tag) {
  throw new Error(`Desktop 版本 ${version} 与 Release tag ${tag} 不一致。`);
}

process.stdout.write(`Release 版本已核对：${tag}\n`);
