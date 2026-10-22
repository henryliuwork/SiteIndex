#!/usr/bin/env python3
"""合并一次全站抓取快照，更新 SKU 主表、库存、事件、每日汇总，并生成日报。

用法:
  python inventory_update.py <site_dir> --snapshot .tmp/snapshot.jsonl [--date YYYY-MM-DD] [--dry-run] [--force]

快照格式（抓取适配器输出，一行一个变体）:
  sku, product_id, handle, title, variant_title, url, category, categories,
  price, compare_at_price, currency, image_url, stock_status, qty
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import (STOCK_STATES, SUMMARY_COLS, SUMMARY_FILE, append_run_log, load_site, now_iso,
                        read_csv, read_jsonl, site_dir, site_today, write_csv, write_jsonl)

TRACKED = ["product_id", "handle", "title", "variant_title", "url", "category", "categories",
           "price", "compare_at_price", "currency", "image_url"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--date")
    ap.add_argument("--max-removed-ratio", type=float, default=0.10)
    ap.add_argument("--force", action="store_true", help="跳过下架比例保护")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    sd = site_dir(a.site)
    site = load_site(sd)
    day = a.date or site_today(site)
    checked_at = now_iso(site)
    run_id = f"{day}-daily"

    snap = read_jsonl(Path(a.snapshot))
    if not snap:
        append_run_log(sd, {"run_id": run_id, "job": "daily", "started_at": checked_at, "finished_at": now_iso(site),
                            "status": "failed", "counts": {}, "errors": ["empty snapshot"]})
        print("ERROR: 快照为空，未写入任何数据", file=sys.stderr)
        return 2

    overrides = site.get("crawl", {}).get("overrides", {}) or {}
    snap_by = {}
    for r in snap:
        r = {**r, **overrides.get(r["sku"], {})}
        st = r.get("stock_status") or "unknown"
        r["stock_status"] = st if st in STOCK_STATES else "unknown"
        snap_by[r["sku"]] = r

    skus = {r["sku"]: r for r in read_jsonl(sd / "catalog/skus.jsonl")}
    latest = {r["sku"]: r for r in read_jsonl(sd / "inventory/latest.jsonl")}
    events: list[dict] = []
    baseline = not skus  # 首次导入：只建立基线，不产生事件

    def ev(sku, typ, frm, to, src):
        if baseline:
            return
        events.append({"date": day, "sku": sku, "type": typ, "from": frm, "to": to,
                       "category": src.get("category"), "title": _label(src)})

    # --- removal guard ---
    active = {k for k, v in skus.items() if v.get("status") == "active"}
    gone = sorted(active - snap_by.keys())
    # 只比较"上次运行还在、这次消失"的 SKU，避免把长期不在源里的 SKU 反复计入
    prev_run = max((skus[k]["last_seen"] for k in active), default=None)
    seen_last = {k for k in active if skus[k]["last_seen"] == prev_run}
    newly_gone = [k for k in gone if k in seen_last]
    if seen_last and len(newly_gone) / len(seen_last) > a.max_removed_ratio and not a.force:
        msg = (f"本次有 {len(newly_gone)}/{len(seen_last)} 个 SKU 从数据源消失，超过 {a.max_removed_ratio:.0%} "
               f"保护阈值，疑似抓取/feed 不完整")
        append_run_log(sd, {"run_id": run_id, "job": "daily", "started_at": checked_at, "finished_at": now_iso(site),
                            "status": "failed", "counts": {"snapshot": len(snap_by), "missing": len(gone)}, "errors": [msg]})
        print(f"ERROR: {msg}。确认无误后加 --force 重跑。", file=sys.stderr)
        return 3

    # --- catalog merge ---
    for sku, s in snap_by.items():
        old = skus.get(sku)
        row = {k: s.get(k) for k in TRACKED}
        row["categories"] = row.get("categories") or ([row["category"]] if row.get("category") else [])
        if old is None:
            skus[sku] = {"sku": sku, **row, "status": "active", "first_seen": day, "last_seen": day, "updated_at": day}
            ev(sku, "new_sku", None, s.get("price"), s)
            continue
        if old.get("status") == "removed":
            ev(sku, "restored_sku", "removed", "active", s)
        if old.get("price") != row["price"] and old.get("price") is not None:
            ev(sku, "price_change", old.get("price"), row["price"], s)
        changed = any(old.get(k) != row[k] for k in TRACKED) or old.get("status") != "active"
        old.update(row)
        old.update({"status": "active", "last_seen": day})
        if changed:
            old["updated_at"] = day

    # 数据源会剔除缺货商品时（如部分 GMC feed 配置），消失先视为缺货，超过 N 天才判定下架
    crawl_cfg = site.get("crawl", {})
    missing_as = crawl_cfg.get("missing_as", "removed")
    removed_after = int(crawl_cfg.get("missing_removed_after_days", 30))
    for sku in gone:
        r = skus[sku]
        if missing_as == "out_of_stock":
            from datetime import date as _d
            idle = (_d.fromisoformat(day) - _d.fromisoformat(r["last_seen"])).days
            if idle < removed_after:
                cur = latest.get(sku)
                if cur and cur["stock_status"] != "out_of_stock":
                    ev(sku, "stock_change", cur["stock_status"], "out_of_stock", r)
                    cur.update({"stock_status": "out_of_stock", "since": day})
                if cur:
                    cur.update({"qty": None, "checked_at": checked_at})
                continue
        r.update({"status": "removed", "updated_at": day})
        ev(sku, "removed_sku", "active", "removed", r)
        latest.pop(sku, None)

    # --- stock ---
    for sku, s in snap_by.items():
        new_st = s["stock_status"]
        old = latest.get(sku)
        if old is None:
            latest[sku] = {"sku": sku, "stock_status": new_st, "qty": s.get("qty"), "since": day, "checked_at": checked_at}
            continue
        if old["stock_status"] != new_st:
            ev(sku, "stock_change", old["stock_status"], new_st, s)
            old["since"] = day
        old.update({"stock_status": new_st, "qty": s.get("qty"), "checked_at": checked_at})

    # --- summary ---
    agg: dict[str, Counter] = defaultdict(Counter)
    for sku, r in skus.items():
        if r.get("status") != "active":
            continue
        st = latest.get(sku, {}).get("stock_status", "unknown")
        for cat in (r.get("category") or "uncategorized", "_all"):
            agg[cat]["total"] += 1
            agg[cat][st] += 1
    summary = [r for r in read_csv(sd / SUMMARY_FILE) if r["date"] != day]
    prev_day = max((r["date"] for r in summary), default=None)
    prev = {r["category"]: r for r in summary if r["date"] == prev_day}
    for cat, c in agg.items():
        summary.append({"date": day, "category": cat, "total": c["total"], **{k: c[k] for k in STOCK_STATES}})

    counts = Counter(e["type"] for e in events)
    restock = [e for e in events if e["type"] == "stock_change" and e["to"] == "in_stock"]
    oos = [e for e in events if e["type"] == "stock_change" and e["to"] == "out_of_stock"]
    stats = {"snapshot": len(snap_by), "active": sum(1 for r in skus.values() if r["status"] == "active"),
             "restock": len(restock), "out_of_stock": len(oos), "price_change": counts["price_change"],
             "new_sku": counts["new_sku"], "removed_sku": counts["removed_sku"],
             "unknown": agg["_all"]["unknown"]}

    report = render_report(site, day, agg, prev, events, skus, latest)

    if a.dry_run:
        print(report)
        print(stats)
        return 0

    write_jsonl(sd / "catalog/skus.jsonl", list(skus.values()), "sku")
    write_jsonl(sd / "inventory/latest.jsonl", list(latest.values()), "inventory_latest")
    ev_path = sd / f"inventory/events/{day[:7]}.jsonl"
    existing = read_jsonl(ev_path)
    seen = {(e["date"], e["sku"], e["type"]) for e in existing}
    merged = existing + [e for e in events if (e["date"], e["sku"], e["type"]) not in seen]
    write_jsonl(ev_path, merged, "inventory_event")
    write_csv(sd / SUMMARY_FILE, summary, SUMMARY_COLS, ["date", "category"])
    (sd / "reports/daily").mkdir(parents=True, exist_ok=True)
    (sd / f"reports/daily/{day}.md").write_text(report, encoding="utf-8", newline="\n")

    status = "partial" if stats["unknown"] > 0.05 * max(stats["active"], 1) else "ok"
    errors = [f"unknown 库存占比过高: {stats['unknown']}/{stats['active']}，请检查 feed 的 availability 字段或 stock_rules"] if status == "partial" else []
    append_run_log(sd, {"run_id": run_id, "job": "daily", "started_at": checked_at, "finished_at": now_iso(site),
                        "status": status, "counts": stats, "errors": errors})
    print(f"sync: daily {day} (+{stats['restock']} restock, -{stats['out_of_stock']} oos, "
          f"{stats['new_sku']} new, {stats['removed_sku']} removed, {stats['price_change']} price)")
    return 0


def _label(r: dict) -> str:
    t = r.get("title") or r.get("sku")
    return f"{t} / {r['variant_title']}" if r.get("variant_title") else t


def render_report(site, day, agg, prev, events, skus, latest) -> str:
    by = defaultdict(list)
    for e in events:
        key = e["type"] if e["type"] != "stock_change" else f"stock:{e['to']}"
        by[key].append(e)
    a = agg["_all"]
    rate = a["in_stock"] / a["total"] if a["total"] else 0
    L = [f"# {site['domain']} 库存日报 · {day}", "",
         f"- 在售 SKU：**{a['total']}**，有货 {a['in_stock']}（{rate:.1%}），缺货 {a['out_of_stock']}，"
         f"预售 {a['preorder']}，未知 {a['unknown']}",
         f"- 新到货 **{len(by['stock:in_stock'])}**｜新缺货 **{len(by['stock:out_of_stock'])}**｜"
         f"调价 {len(by['price_change'])}｜上新 {len(by['new_sku'])}｜下架 {len(by['removed_sku'])}", ""]

    def section(title, items, fmt):
        if not items:
            return
        L.append(f"## {title}（{len(items)}）")
        L.append("")
        for e in sorted(items, key=lambda x: (x["category"] or "", x["title"])):
            L.append(f"- `{e['sku']}` {e['title']} · {e['category']}{fmt(e)}")
        L.append("")

    section("新到货", by["stock:in_stock"], lambda e: f"（原 {e['from']}）")
    section("新缺货", by["stock:out_of_stock"], lambda e: "")
    section("转预售", by["stock:preorder"], lambda e: "")
    section("状态未知", by["stock:unknown"], lambda e: f"（原 {e['from']}）")
    section("调价", by["price_change"], lambda e: f"：{e['from']} → {e['to']}")
    section("上新", by["new_sku"], lambda e: f"：{e['to']}")
    section("下架/消失", by["removed_sku"], lambda e: "")

    L += ["## 分类概览", "", "| 分类 | 在售 | 有货 | 缺货 | 有货率 | 较前日缺货 |", "|---|---:|---:|---:|---:|---:|"]
    for cat in sorted(k for k in agg if k != "_all"):
        c = agg[cat]
        p = prev.get(cat)
        d = c["out_of_stock"] - int(p["out_of_stock"]) if p else None
        ds = "—" if d is None else (f"+{d}" if d > 0 else str(d))
        r = c["in_stock"] / c["total"] if c["total"] else 0
        L.append(f"| {cat} | {c['total']} | {c['in_stock']} | {c['out_of_stock']} | {r:.0%} | {ds} |")
    L.append("")

    long_oos = sorted(((v["since"], k) for k, v in latest.items()
                       if v["stock_status"] == "out_of_stock" and skus.get(k, {}).get("status") == "active"))[:15]
    if long_oos:
        L += ["## 缺货时间最长（前 15）", ""]
        for since, k in long_oos:
            L.append(f"- `{k}` {_label(skus[k])} · 自 {since}")
        L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
