#!/usr/bin/env python3
"""重新排序并规范化站点仓库内所有数据文件（不改变内容）。

用法: python fix_sort.py <site_dir>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (EVENTS_GLOB, FILES, SUMMARY_COLS, SUMMARY_FILE, field_order, primary_key, read_csv,
                        read_json, read_jsonl, site_dir, sort_key, write_csv, write_json, write_jsonl)


def main() -> int:
    sd = site_dir(sys.argv[1] if len(sys.argv) > 1 else ".")
    for rel, (schema_name, fmt) in FILES.items():
        p = sd / rel
        if not p.exists():
            continue
        if fmt == "csv":
            write_csv(p, read_csv(p), field_order(schema_name), primary_key(schema_name))
        elif fmt == "jsonarray":
            write_json(p, sorted(read_json(p, []), key=sort_key(primary_key(schema_name))))
        else:
            write_jsonl(p, read_jsonl(p), schema_name)
    for f in sd.glob(EVENTS_GLOB):
        write_jsonl(f, read_jsonl(f), "inventory_event")
    if (sd / SUMMARY_FILE).exists():
        write_csv(sd / SUMMARY_FILE, read_csv(sd / SUMMARY_FILE), SUMMARY_COLS, ["date", "category"])
    print("fix_sort: done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
