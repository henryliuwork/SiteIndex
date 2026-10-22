#!/usr/bin/env python3
"""把 content.json + views/products.jsonl 渲染成 Mailchimp 可用的 email.html。

用法: python render.py <site_dir> <campaign_dir> [--allow-oos]
默认跳过非 in_stock 产品。产品的标题、价格、图片、链接全部取自数据，文案只取自 content.json。
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.common import load_site, read_jsonl, site_dir

SYMBOL = {"USD": "$", "EUR": "€", "GBP": "£", "AUD": "A$", "CAD": "C$", "JPY": "¥", "CNY": "¥"}


def esc(s, allow_br=False):
    t = html.escape(s or "")
    return t.replace("&lt;br&gt;", "<br>").replace("&lt;br/&gt;", "<br>") if allow_br else t


def utm(url, site, cid, content=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    q.update({"utm_source": site["edm"]["utm"].get("source", "mailchimp"),
              "utm_medium": site["edm"]["utm"].get("medium", "email"), "utm_campaign": cid})
    if content:
        q["utm_content"] = content
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), u.fragment))


def money(v, cur):
    return f"{SYMBOL.get(cur, cur + ' ')}{v:,.2f}" if v is not None else ""


def card(p, site, cid, color):
    price = money(p["price_min"], p["currency"])
    if p["price_max"] and p["price_max"] > p["price_min"]:
        price = f"From {price}"
    was = (f'<span style="color:#9a9a9a;text-decoration:line-through;font-weight:400;margin-left:6px">'
           f'{money(p["compare_at_max"], p["currency"])}</span>') if p.get("on_sale") and p.get("compare_at_max") else ""
    link = utm(p["url"], site, cid, p["handle"])
    blurb = f'<p style="margin:6px 0 0;font-size:13px;line-height:18px;color:#555">{esc(p.get("blurb"))}</p>' if p.get("blurb") else ""
    return f'''<td class="col" width="50%" valign="top" style="padding:10px">
  <a href="{link}" target="_blank" style="text-decoration:none;color:#222">
    <img src="{html.escape(p["image_url"])}" width="260" alt="{esc(p["title"])}" style="display:block;width:100%;max-width:260px;height:auto;border:0;border-radius:6px">
    <p style="margin:12px 0 0;font-size:15px;line-height:20px;font-weight:600">{esc(p["title"])}</p>
  </a>{blurb}
  <p style="margin:6px 0 10px;font-size:15px;font-weight:700;color:{color}">{price}{was}</p>
  <a href="{link}" target="_blank" style="display:inline-block;padding:9px 18px;border:1px solid {color};border-radius:4px;color:{color};font-size:13px;font-weight:600;text-decoration:none">Shop now</a>
</td>'''


def main() -> int:
    sd = site_dir(sys.argv[1])
    cdir = (sd / sys.argv[2]).resolve()
    site = load_site(sd)
    c = json.loads((cdir / "content.json").read_text(encoding="utf-8"))
    cid = c.get("campaign_id") or cdir.name
    views = {p["handle"]: p for p in read_jsonl(sd / "views/products.jsonl")}
    if not views:
        sys.exit("ERROR: views/products.jsonl 为空，先运行 build_views.py")

    picks, problems = [], []
    for item in c["products"]:
        p = views.get(item["handle"])
        if not p:
            problems.append(f"{item['handle']}: 不存在")
            continue
        if p["stock_status"] != "in_stock" and "--allow-oos" not in sys.argv:
            problems.append(f"{item['handle']}: 当前 {p['stock_status']}，已跳过（确需保留加 --allow-oos）")
            continue
        if not p.get("image_url"):
            problems.append(f"{item['handle']}: 无图片")
            continue
        picks.append({**p, "blurb": item.get("blurb")})
    if problems:
        print("WARN:\n  " + "\n  ".join(problems), file=sys.stderr)

    color = site["edm"].get("brand_color", "#1f3a2e")
    font = site["edm"].get("font_stack", "Helvetica,Arial,sans-serif")
    rows = []
    for i in range(0, len(picks), 2):
        cells = [card(p, site, cid, color) for p in picks[i:i + 2]]
        if len(cells) == 1:
            cells.append('<td class="col" width="50%"></td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")
    promo = ""
    if c.get("promo_code"):
        note = ('<br><span style="font-size:12px;color:#777">' + esc(c.get("promo_note")) + "</span>") if c.get("promo_note") else ""
        promo = (f'<tr><td align="center" style="padding:0 30px 20px"><div style="border:2px dashed {color};padding:14px;'
                 f'font-size:15px">Use code <strong style="color:{color};letter-spacing:1px">{esc(c["promo_code"])}</strong>'
                 f'{note}</div></td></tr>')
    closing = f'<tr><td style="padding:10px 30px 0;font-size:15px;line-height:22px;color:#333">{esc(c.get("closing"), True)}</td></tr>' if c.get("closing") else ""

    doc = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(c["subject"])}</title>
<style>@media only screen and (max-width:600px){{.col{{display:block!important;width:100%!important}}.wrap{{width:100%!important}}}}</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f2;font-family:{font}">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">{esc(c.get("preheader"))}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff">
<tr><td align="center" style="padding:28px 30px 8px;font-size:20px;font-weight:700;letter-spacing:2px;color:{color}">
  <a href="{utm(site["base_url"], site, cid, "logo")}" style="color:{color};text-decoration:none">{esc(site["brand"]["name"]).upper()}</a></td></tr>
<tr><td align="center" style="padding:18px 30px 6px;font-size:26px;line-height:32px;font-weight:700;color:#222">{esc(c["headline"])}</td></tr>
<tr><td align="center" style="padding:6px 40px 22px;font-size:15px;line-height:22px;color:#444">{esc(c.get("intro"), True)}</td></tr>
{promo}
<tr><td style="padding:0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table></td></tr>
{closing}
<tr><td align="center" style="padding:24px 30px 34px">
  <a href="{utm(c["cta_url"], site, cid, "cta")}" style="display:inline-block;background:{color};color:#ffffff;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:700;text-decoration:none">{esc(c["cta_text"])}</a></td></tr>
<tr><td align="center" style="padding:18px 30px 26px;background:#fafaf8;font-size:11px;line-height:17px;color:#999">
  *|LIST:ADDRESSLINE|*<br><a href="*|UNSUB|*" style="color:#999">Unsubscribe</a> · <a href="*|UPDATE_PROFILE|*" style="color:#999">Update preferences</a></td></tr>
</table></td></tr></table>
</body></html>
'''
    (cdir / "email.html").write_text(doc, encoding="utf-8", newline="\n")
    snap = [{k: p.get(k) for k in ("handle", "title", "price_min", "price_max", "compare_at_max", "currency",
                                    "url", "image_url", "image_source", "stock_status", "blurb")} for p in picks]
    (cdir / "products.json").write_text(json.dumps(snap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"email.html 已生成：{len(picks)} 个产品" + (f"，{len(problems)} 个问题见上方" if problems else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
