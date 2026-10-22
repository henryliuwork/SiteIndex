#!/usr/bin/env python3
"""从 template/ 初始化一个站点仓库。

用法: python new_site.py <target_dir> --domain kingsyard.com [--name Kingsyard]
目标目录可以是空目录或刚 clone 的空仓库；已存在的文件不会被覆盖。
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parents[1] / "template"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--domain", required=True)
    ap.add_argument("--name")
    a = ap.parse_args()
    domain = a.domain.lower().removeprefix("https://").removeprefix("http://").removeprefix("www.").strip("/")
    name = a.name or domain.split(".")[0].capitalize()
    target = Path(a.target).resolve()
    target.mkdir(parents=True, exist_ok=True)
    created, skipped = 0, 0
    for src in sorted(TEMPLATE.rglob("*")):
        rel = src.relative_to(TEMPLATE)
        dst = target / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
            continue
        if dst.exists():
            skipped += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in (".md", ".json"):
            dst.write_text(src.read_text(encoding="utf-8").replace("{{DOMAIN}}", domain).replace("{{SITE}}", name),
                           encoding="utf-8", newline="\n")
        else:
            shutil.copy2(src, dst)
        created += 1
    print(f"已初始化 {target}（{domain}）：新建 {created} 个文件，跳过已存在 {skipped} 个")
    print("下一步：填写 site.json 中的 TODO，然后运行 validate.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
