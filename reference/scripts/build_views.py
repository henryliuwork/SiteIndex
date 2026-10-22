#!/usr/bin/env python3
"""生成本地合并视图 views/（不进 git）。

用法:
  python build_views.py <site_dir> [--db]

输出:
  views/products.jsonl   产品级合并视图（skus + latest + sku_media + sku_tags + edm/index）
  views/index.db         加 --db 时生成，包含所有数据表 + products 表，供需要 SQL 的场景
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (FILES, EVENTS_GLOB, SUMMARY_FILE, load_site, read_csv, read_json, read_jsonl,
                        site_dir, site_today, write_jsonl)

RANK = {"in_stock": 0, "preorder": 1, "out_of_stock": 2, "unknown": 3}


def build_products(sd: Path, site: dict) -> list[dict]:
    skus = [r for r in read_jsonl(sd / "catalog/skus.jsonl")]
    latest = {r["sku"]: r for r in read_jsonl(sd / "inventory/latest.jsonl")}
    media = defaultdict(dict)
    for r in read_csv(sd / "enrich/sku_media.csv"):
        media[r["sku"]][r.get("image_role") or "main"] = r
    tags = {r["sku"]: r for r in read_csv(sd / "enrich/sku_tags.csv")}
    featured: dict[str, str] = {}
    for c in read_jsonl(sd / "edm/index.jsonl"):
        for h in c.get("handles") or []:
            d = c.get("send_date") or c.get("date")
            if d and d > featured.get(h, ""):
                featured[h] = d
    today = date.fromisoformat(site_today(site))

    groups = defaultdict(list)
    for r in skus:
        groups[r["handle"]].append(r)

    out = []
    for handle, vs in groups.items():
        active = [v for v in vs if v.get("status") == "active"] or vs
        lead = sorted(active, key=lambda v: v["sku"])[0]
        prices = [v["price"] for v in active if v.get("price") is not None]
        compares = [v["compare_at_price"] for v in active if v.get("compare_at_price")]
        sts = [latest.get(v["sku"], {}).get("stock_status", "unknown") for v in active]
        best = min(sts, key=lambda s: RANK.get(s, 9)) if sts else "unknown"
        since_vals = [latest[v["sku"]]["since"] for v in active
                      if v["sku"] in latest and latest[v["sku"]]["stock_status"] == best]
        # 1.1 取图规则：feed 首图优先 → 手动首图（ledgers/sku_media.csv）→ none
        feed_img = next((v.get("image_url") for v in sorted(active, key=lambda v: v["sku"]) if v.get("image_url")), None)
        manual_img = None
        for v in sorted(active, key=lambda v: v["sku"]):
            m = media.get(v["sku"], {}).get("main")
            if m and m.get("image_url"):
                manual_img = m["image_url"]
                break
        if feed_img:
            img, src = feed_img, "feed"
        elif manual_img:
            img, src = manual_img, "manual"
        else:
            img, src = None, "none"
        t_set, prio, excl = set(), None, 0
        for v in active:
            t = tags.get(v["sku"])
            if not t:
                continue
            t_set.update(x.strip().lower() for x in (t.get("tags") or "").split(";") if x.strip())
            if t.get("priority"):
                prio = max(prio or 0, int(t["priority"]))
            if str(t.get("exclude_edm") or "0") == "1":
                excl = 1
        lf = featured.get(handle)
        out.append({
            "handle": handle, "product_id": lead.get("product_id"), "title": lead.get("title"),
            "url": lead.get("url", "").split("?")[0], "category": lead.get("category"),
            "categories": sorted({c for v in active for c in (v.get("categories") or [])}),
            "price_min": min(prices) if prices else None, "price_max": max(prices) if prices else None,
            "compare_at_max": max(compares) if compares else None, "currency": lead.get("currency"),
            "on_sale": any(v.get("compare_at_price") and v.get("price") is not None and v["compare_at_price"] > v["price"] for v in active),
            "image_url": img, "image_source": src,
            "feed_image_url": feed_img, "manual_image_url": manual_img,
            "variant_count": len(active), "skus": sorted(v["sku"] for v in active),
            "in_stock_variants": sum(1 for s in sts if s == "in_stock"),
            "stock_status": best, "stock_since": min(since_vals) if since_vals else None,
            "tags": sorted(t_set), "priority": prio, "exclude_edm": excl,
            "last_featured": lf, "days_since_featured": (today - date.fromisoformat(lf)).days if lf else None,
            "first_seen": min(v["first_seen"] for v in vs),
            "status": "active" if any(v.get("status") == "active" for v in vs) else "removed",
        })
    return out


def build_db(sd: Path, products: list[dict]) -> Path:
    db = sd / "views/index.db"
    if db.exists():
        db.unlink()
    con = sqlite3.connect(db)
    tables = {rel.split("/")[-1].split(".")[0]: (rel, fmt) for rel, (_, fmt) in FILES.items()}
    data = {}
    for name, (rel, fmt) in tables.items():
        p = sd / rel
        data[name] = read_csv(p) if fmt == "csv" else (read_json(p, []) if fmt == "jsonarray" else read_jsonl(p))
    data["events"] = [e for f in sorted(sd.glob(EVENTS_GLOB)) for e in read_jsonl(f)]
    data["daily_summary"] = read_csv(sd / SUMMARY_FILE)
    data["products"] = products
    for name, rows in data.items():
        if not rows:
            continue
        cols = list(dict.fromkeys(k for r in rows for k in r))
        con.execute(f'CREATE TABLE "{name}" ({", ".join(f"[{c}]" for c in cols)})')
        con.executemany(f'INSERT INTO "{name}" VALUES ({",".join("?" * len(cols))})',
                        [[json.dumps(r.get(c), ensure_ascii=False) if isinstance(r.get(c), (list, dict)) else r.get(c)
                          for c in cols] for r in rows])
    con.commit()
    con.close()
    return db


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--db", action="store_true")
    a = ap.parse_args()
    sd = site_dir(a.site)
    site = load_site(sd)
    products = build_products(sd, site)
    (sd / "views").mkdir(exist_ok=True)
    write_jsonl(sd / "views/products.jsonl", products, pk=["handle"])
    msg = f"views/products.jsonl: {len(products)} 个产品"
    if a.db:
        build_db(sd, products)
        msg += "；views/index.db 已生成"
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
