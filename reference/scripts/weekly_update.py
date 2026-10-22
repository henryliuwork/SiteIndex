#!/usr/bin/env python3
"""合并每周抓取结果：分类、页面、博客索引。整表替换（以本次抓取为准），保持排序。

用法:
  python weekly_update.py <site_dir> [--categories .tmp/categories.json] [--pages .tmp/pages.jsonl] [--blog .tmp/blog.jsonl]
任一输入为空时不覆盖对应文件（防止抓取失败清空数据）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (append_run_log, load_site, now_iso, primary_key, read_json, read_jsonl, site_dir, site_today,
                        sort_key, write_json, write_jsonl)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--categories")
    ap.add_argument("--pages")
    ap.add_argument("--blog")
    a = ap.parse_args()
    sd = site_dir(a.site)
    site = load_site(sd)
    day, started = site_today(site), now_iso(site)
    counts, errors = {}, []

    if a.categories:
        rows = read_json(Path(a.categories), [])
        if rows:
            for r in rows:
                r.setdefault("last_seen", day)
            write_json(sd / "catalog/categories.json", sorted(rows, key=sort_key(primary_key("category"))))
            counts["categories"] = len(rows)
        else:
            errors.append("categories 为空，未覆盖")
    for arg, rel, schema, stamp in ((a.pages, "catalog/pages.jsonl", "page", "last_crawled"),
                                    (a.blog, "content/blog_index.jsonl", "blog_post", "last_crawled")):
        if not arg:
            continue
        rows = read_jsonl(Path(arg))
        if not rows:
            errors.append(f"{rel} 输入为空，未覆盖")
            continue
        for r in rows:
            r.setdefault(stamp, day)
        write_jsonl(sd / rel, rows, schema)
        counts[rel.split("/")[-1].split(".")[0]] = len(rows)

    append_run_log(sd, {"run_id": f"{day}-weekly", "job": "weekly", "started_at": started, "finished_at": now_iso(site),
                        "status": "ok" if not errors else ("partial" if counts else "failed"),
                        "counts": counts, "errors": errors})
    print(f"sync: weekly {day} {counts}" + (f" errors={errors}" if errors else ""))
    return 0 if counts else 2


if __name__ == "__main__":
    sys.exit(main())
