#!/usr/bin/env python3
"""按主键插入/更新/删除记录，自动保持排序、键顺序、updated_at。Agent 写数据统一用它。

用法:
  python upsert.py <site_dir> <file> --rows rows.jsonl     # 插入或合并更新（只覆盖给出的字段）
  python upsert.py <site_dir> <file> --rows -              # 从 stdin 读 JSONL
  python upsert.py <site_dir> <file> --delete KEY [KEY...] # 删除（复合主键用 | 连接，如 SKU1|main）

<file> 取值: enrich/sku_media.csv  enrich/sku_tags.csv  content/keywords.jsonl
             outreach/contacted.jsonl  edm/index.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (FILES, field_order, load_site, primary_key, read_csv, read_jsonl, site_dir, site_today,
                        write_csv, write_jsonl)

AGENT_WRITABLE = {"enrich/sku_media.csv", "enrich/sku_tags.csv", "content/keywords.jsonl",
                  "outreach/contacted.jsonl", "edm/index.jsonl"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("file")
    ap.add_argument("--rows")
    ap.add_argument("--delete", nargs="+")
    a = ap.parse_args()
    if a.file not in AGENT_WRITABLE:
        sys.exit(f"ERROR: {a.file} 不允许 AGENT 写入。可写: {sorted(AGENT_WRITABLE)}")
    sd = site_dir(a.site)
    schema_name, fmt = FILES[a.file]
    pk, cols = primary_key(schema_name), field_order(schema_name)
    path = sd / a.file
    rows = read_csv(path) if fmt == "csv" else read_jsonl(path)
    idx = {tuple(str(r.get(k)) for k in pk): r for r in rows}
    today = site_today(load_site(sd))
    added = updated = deleted = 0

    if a.delete:
        for key in a.delete:
            k = tuple(key.split("|"))
            if idx.pop(k, None) is not None:
                deleted += 1
    if a.rows:
        src = sys.stdin if a.rows == "-" else open(a.rows, encoding="utf-8")
        for n, line in enumerate(src, 1):
            if not line.strip():
                continue
            new = json.loads(line)
            if a.file == "content/keywords.jsonl" and new.get("keyword"):
                new["keyword"] = new["keyword"].strip().lower()
            if a.file == "outreach/contacted.jsonl" and new.get("domain"):
                new["domain"] = new["domain"].strip().lower().removeprefix("www.")
            if any(new.get(k) in (None, "") for k in pk):
                sys.exit(f"ERROR: 第{n}行缺少主键 {pk}")
            k = tuple(str(new[c]) for c in pk)
            if "updated_at" in cols:
                new.setdefault("updated_at", today)
            if a.file == "outreach/contacted.jsonl":
                new.setdefault("added_at", today)
            if k in idx:
                idx[k].update(new)
                updated += 1
            else:
                idx[k] = new
                added += 1
    out = list(idx.values())
    if fmt == "csv":
        for r in out:
            for c, v in r.items():
                if isinstance(v, list):
                    r[c] = ";".join(v)
        write_csv(path, out, cols, pk)
    else:
        write_jsonl(path, out, schema_name)
    print(f"{a.file}: +{added} 新增, {updated} 更新, {deleted} 删除, 共 {len(out)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
