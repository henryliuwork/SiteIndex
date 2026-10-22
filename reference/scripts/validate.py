#!/usr/bin/env python3
"""校验站点仓库数据。有 ERROR 时退出码为 1（用于 pre-commit 与 CI）。

用法:
  python validate.py <site_dir> [--quiet]

检查项:
  - site.json 结构与 schema_version
  - 每个数据文件：可解析、字段符合 schema、主键唯一、按主键排序
  - 引用完整性：enrich/inventory 中的 sku 必须存在于 catalog/skus.jsonl
  - 规则：一个 URL 只能有一个 primary 关键词；edm/index 每条记录有对应目录
  - git：views/ 与 *.db 不得被跟踪
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (EVENTS_GLOB, FILES, SCHEMA_VERSION, SUMMARY_COLS, SUMMARY_FILE, coerce_csv_row, load_schema,
                        read_csv, read_json, read_jsonl, site_dir, sort_key)

try:
    import jsonschema
except ImportError:  # 退化为必填字段检查
    jsonschema = None


class Report:
    def __init__(self):
        self.errors, self.warns = [], []

    def err(self, m):
        self.errors.append(m)

    def warn(self, m):
        self.warns.append(m)


def check_rows(rep: Report, rel: str, rows: list[dict], schema_name: str, max_msgs=5):
    schema = load_schema(schema_name)
    pk = schema.get("x-primary-key", [])
    bad = 0
    for i, r in enumerate(rows, 1):
        if jsonschema:
            errs = list(jsonschema.Draft202012Validator(schema).iter_errors(r))
        else:
            errs = [f"缺少字段 {k}" for k in schema["required"] if k not in r]
        for e in errs:
            bad += 1
            if bad <= max_msgs:
                msg = e.message if hasattr(e, "message") else e
                path = ".".join(str(p) for p in getattr(e, "path", [])) or ""
                rep.err(f"{rel} 第{i}行 {path}: {msg}")
    if bad > max_msgs:
        rep.err(f"{rel}: 另有 {bad - max_msgs} 处字段错误未列出")
    if pk:
        keys = [tuple(r.get(k) for k in pk) for r in rows]
        dup = [k for k, c in Counter(keys).items() if c > 1]
        if dup:
            rep.err(f"{rel}: 主键重复 {len(dup)} 个，例如 {dup[0]}")
        if rows != sorted(rows, key=sort_key(pk)):
            rep.err(f"{rel}: 未按主键 {pk} 排序（用脚本写入，或运行 python scripts/fix_sort.py）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    sd = site_dir(a.site)
    rep = Report()
    data = {}

    site = read_json(sd / "site.json")
    check_rows(rep, "site.json", [site], "site")
    if site.get("schema_version") != SCHEMA_VERSION:
        rep.err(f"site.json schema_version={site.get('schema_version')}，工具包要求 {SCHEMA_VERSION}")
    todo = [k for k in ("brand", "crawl", "integrations") if "TODO" in json.dumps(site.get(k, {}), ensure_ascii=False)]
    if todo:
        rep.warn(f"site.json 仍有 TODO 未填写：{', '.join(todo)}")

    for rel, (schema_name, fmt) in FILES.items():
        p = sd / rel
        if not p.exists():
            rep.err(f"缺少文件 {rel}")
            continue
        try:
            if fmt == "csv":
                rows = [coerce_csv_row(r, schema_name) for r in read_csv(p)]
                header = p.read_text(encoding="utf-8").splitlines()[:1]
                expected = ",".join(load_schema(schema_name)["properties"].keys())
                if header and header[0].lstrip("﻿") != expected:
                    rep.err(f"{rel}: 表头应为 {expected}")
            elif fmt == "jsonarray":
                rows = read_json(p, [])
            else:
                rows = read_jsonl(p)
        except Exception as e:
            rep.err(f"{rel}: 解析失败 {e}")
            continue
        data[rel] = rows
        check_rows(rep, rel, rows, schema_name)

    for f in sorted(sd.glob(EVENTS_GLOB)):
        try:
            rows = read_jsonl(f)
        except Exception as e:
            rep.err(f"{f.relative_to(sd)}: {e}")
            continue
        check_rows(rep, str(f.relative_to(sd)), rows, "inventory_event")
        month = f.stem
        if any(not r.get("date", "").startswith(month) for r in rows):
            rep.err(f"{f.relative_to(sd)}: 含有不属于 {month} 的事件")

    sp = sd / SUMMARY_FILE
    if sp.exists():
        head = sp.read_text(encoding="utf-8").splitlines()[:1]
        if head and head[0] != ",".join(SUMMARY_COLS):
            rep.err(f"{SUMMARY_FILE}: 表头应为 {','.join(SUMMARY_COLS)}")

    # 引用完整性
    skus = {r["sku"]: r for r in data.get("catalog/skus.jsonl", []) if "sku" in r}
    for rel in ("enrich/sku_media.csv", "enrich/sku_tags.csv", "inventory/latest.jsonl"):
        missing = sorted({r.get("sku") for r in data.get(rel, []) if r.get("sku") not in skus})
        if missing:
            (rep.err if rel.startswith("inventory") else rep.warn)(
                f"{rel}: {len(missing)} 个 SKU 不在 catalog/skus.jsonl，例如 {missing[:3]}")
    removed_tagged = sorted({r["sku"] for r in data.get("enrich/sku_media.csv", [])
                             if skus.get(r["sku"], {}).get("status") == "removed"})
    if removed_tagged:
        rep.warn(f"enrich/sku_media.csv: {len(removed_tagged)} 个 SKU 已下架")

    prim = Counter(r.get("target_url") for r in data.get("content/keywords.jsonl", [])
                   if r.get("role") == "primary" and r.get("target_url"))
    for url, c in prim.items():
        if c > 1:
            rep.warn(f"content/keywords.jsonl: {url} 有 {c} 个 primary 关键词（可能互相蚕食）")

    for c in data.get("edm/index.jsonl", []):
        if c.get("campaign_id") and not (sd / "edm" / c["campaign_id"]).is_dir():
            rep.err(f"edm/index.jsonl: {c['campaign_id']} 没有对应目录 edm/{c['campaign_id']}/")

    # git 跟踪检查
    try:
        tracked = subprocess.run(["git", "ls-files"], cwd=sd, capture_output=True, text=True, check=True).stdout.split()
        bad = [t for t in tracked if t.startswith("views/") or t.endswith(".db")]
        if bad:
            rep.err(f"以下文件不应提交: {bad[:5]}（git rm --cached）")
    except Exception:
        pass

    if not a.quiet or rep.errors:
        for m in rep.errors:
            print(f"ERROR  {m}")
        for m in rep.warns:
            print(f"WARN   {m}")
    print(f"validate: {len(rep.errors)} error(s), {len(rep.warns)} warning(s)"
          + ("" if jsonschema else "（未安装 jsonschema，仅做基础检查）"))
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
