#!/usr/bin/env python3
"""根据 inventory/daily_summary.csv 生成库存趋势图。

用法: python stock_chart.py <site_dir> [--days 60] [--top 8]
输出: reports/charts/stock_trend.png（覆盖写入，始终为最新）
      上图：各分类有货率；下图：全站缺货 SKU 数
需要 matplotlib；未安装时跳过且不报错。
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.common import SUMMARY_FILE, read_csv, site_dir, load_site


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--top", type=int, default=8, help="按 SKU 数取前 N 个分类")
    a = ap.parse_args()
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
        from datetime import date
    except ImportError:
        print("stock_chart: 未安装 matplotlib，跳过")
        return 0
    sd = site_dir(a.site)
    rows = read_csv(sd / SUMMARY_FILE)
    if not rows:
        print("stock_chart: 无数据")
        return 0
    days = sorted({r["date"] for r in rows})[-a.days:]
    rows = [r for r in rows if r["date"] in set(days)]
    series = defaultdict(dict)
    for r in rows:
        t = int(r["total"])
        series[r["category"]][r["date"]] = (int(r["in_stock"]) / t if t else 0, int(r["out_of_stock"]), t)
    last = days[-1]
    cats = sorted((c for c in series if c != "_all"), key=lambda c: -series[c].get(last, (0, 0, 0))[2])[:a.top]

    x = [date.fromisoformat(d) for d in days]
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True, gridspec_kw={"height_ratios": [2, 1]})
    for c in cats:
        ax1.plot(x, [series[c].get(d, (None,))[0] for d in days], marker=".", linewidth=1.6, label=c)
    ax1.set_ylabel("In-stock rate")
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
    ax1.set_ylim(0, 1.02)
    ax1.grid(alpha=0.25)
    ax1.legend(loc="lower left", fontsize=8, ncol=4, frameon=False)
    allv = series.get("_all", {})
    ax2.bar(x, [allv.get(d, (0, 0, 0))[1] for d in days], color="#c0504d", width=0.8)
    ax2.set_ylabel("OOS SKUs (all)")
    ax2.grid(axis="y", alpha=0.25)
    ax2.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(days) // 10)))
    ax2.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
    for s in ("top", "right"):
        ax1.spines[s].set_visible(False)
        ax2.spines[s].set_visible(False)
    site = load_site(sd)
    fig.suptitle(f"{site['domain']} stock trend · last {len(days)} days (to {last})", fontsize=12)
    fig.tight_layout()
    out = sd / "reports/charts/stock_trend.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=110)
    print(f"stock_chart: {out.relative_to(sd)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
