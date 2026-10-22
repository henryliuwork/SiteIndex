#!/usr/bin/env python3
"""生成测试输入（feeds/ 与 www/）。输出已提交在仓库中，只有修改测试场景时才需要重新运行。

场景（Kingsyard 风格的喂鸟器站点，16 个产品）：
  day1  基线：含变体组、促销价（有效/已过期）、backorder、未知库存、重复 id、缺价格条目
  day2  2 个转缺货、1 个到货、1 个调价、1 个上新、1 个从 feed 消失（feed 剔除缺货）
  day3  无变化（幂等）+ TSV 格式 feed
  day4  大量商品消失 → 触发保护阈值中止
"""
from pathlib import Path

H = "http://127.0.0.1:8765"
ROOT = Path(__file__).resolve().parent
TYPES = ["Home & Garden > Bird Feeders > Tube Feeders", "Home & Garden > Bird Feeders > Suet Feeders",
         "Home & Garden > Bird Houses", "Home & Garden > Bird Baths"]


def products(day):
    rows = []
    for p in range(16):
        variants = ["Green", "Red"] if p in (0, 4) else [None]
        for c in variants:
            sku = f"KYBF{p:03d}" + (f"-{c[0]}" if c else "")
            avail = "out of stock" if p in (3, 7) else "in stock"
            if p == 9:
                avail = "backorder"
            if p == 11:
                avail = "limited"          # 非标准值 → unknown
            price = 19.99 + p
            sale, eff = None, None
            if p == 2:
                sale, eff = 14.99 + p, "2020-01-01T00:00+00:00/2099-12-31T23:59+00:00"
            if p == 6:
                sale, eff = 9.99 + p, "2020-01-01T00:00+00:00/2020-12-31T23:59+00:00"  # 已过期
            if day >= 2:
                if sku in ("KYBF001", "KYBF004-R"):
                    avail = "out of stock"
                if p == 3:
                    avail = "in stock"
                if p == 10:
                    price = 24.50
                if p == 7:
                    continue                # feed 剔除缺货商品
            if day >= 4 and p >= 8:
                continue                    # 大量消失
            rows.append(dict(id=sku, title=f"Kingsyard Feeder {p} & Co", p=p, c=c,
                             link=f"{H}/feeder-{p}.html" + (f"?color={c}&utm_source=google" if c else "?utm_source=google"),
                             price=f"{price:.2f} USD", sale=f"{sale:.2f} USD" if sale else None, eff=eff,
                             avail=avail, image=f"{H}/media/catalog/product/k/y/feeder-{p}.jpg", type=TYPES[p % 4]))
    if day >= 2:
        rows.append(dict(id="KYBF100", title="Kingsyard Window Feeder", p=100, c=None, link=f"{H}/window-feeder.html",
                         price="39.00 USD", sale=None, eff=None, avail="in stock",
                         image=f"{H}/media/catalog/product/w/f/window.jpg", type=TYPES[0]))
    return rows


def xml(rows, extra_bad=True):
    out = []
    for r in rows:
        grp = f"<g:item_group_id>G{r['p']}</g:item_group_id><g:color>{r['c']}</g:color>" if r["c"] else ""
        sale = f"<g:sale_price>{r['sale']}</g:sale_price><g:sale_price_effective_date>{r['eff']}</g:sale_price_effective_date>" if r["sale"] else ""
        out.append(f"""  <item>
    <g:id>{r['id']}</g:id><g:title>{r['title'].replace('&', '&amp;')}</g:title>
    <g:link>{r['link'].replace('&', '&amp;')}</g:link><g:price>{r['price']}</g:price>{sale}
    <g:availability>{r['avail']}</g:availability><g:image_link>{r['image']}</g:image_link>
    <g:product_type>{r['type'].replace('&', '&amp;')}</g:product_type>{grp}
    <g:shipping><g:country>US</g:country><g:price>0 USD</g:price></g:shipping>
  </item>""")
    if extra_bad:
        out.append("  <item><g:id>KYBF000-G</g:id><g:title>Duplicate</g:title><g:link>https://x</g:link><g:price>1 USD</g:price></item>")
        out.append("  <item><g:id>NOPRICE</g:id><g:title>No price</g:title><g:link>https://x/np.html</g:link></item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n'
            '<channel><title>Kingsyard</title>\n' + "\n".join(out) + "\n</channel></rss>\n")


def tsv(rows):
    head = "id\ttitle\tlink\tprice\tsale price\tsale price effective date\tavailability\timage link\tproduct type\titem group id\tcolor"
    lines = [head]
    for r in rows:
        lines.append("\t".join([r["id"], r["title"], r["link"], r["price"], r["sale"] or "", r["eff"] or "", r["avail"],
                                r["image"], r["type"], f"G{r['p']}" if r["c"] else "", r["c"] or ""]))
    return "\n".join(lines) + "\n"


def www():
    w = ROOT / "www"
    (w / "blog").mkdir(parents=True, exist_ok=True)
    urls = [f"{H}/", f"{H}/bird-feeders.html", f"{H}/bird-houses.html", f"{H}/about-us", f"{H}/shipping-policy",
            f"{H}/feeder-1.html", f"{H}/blog/how-to-attract-cardinals", f"{H}/blog/clean-bird-bath", f"{H}/blog/missing-post"]
    (w / "sitemap.xml").write_text('<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                                   f'<sitemap><loc>{H}/sitemap-1.xml</loc></sitemap></sitemapindex>\n')
    (w / "sitemap-1.xml").write_text('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "".join(
        f"<url><loc>{u}</loc><lastmod>2026-09-{i + 1:02d}</lastmod></url>" for i, u in enumerate(urls)) + "</urlset>\n")
    (w / "robots.txt").write_text(f"User-agent: *\nDisallow: /checkout/\nSitemap: {H}/sitemap.xml\n")

    def page(path, title, body, head=""):
        return (f'<!doctype html><html><head><title>{title} | Kingsyard</title><meta name="description" content="About {title}">'
                f'<link rel="canonical" href="{H}{path}">{head}</head><body><header><nav><a href="/bird-feeders.html">Feeders</a>'
                f'<a href="/blog/clean-bird-bath">Blog</a></nav></header><main><h1>{title}</h1>{body}</main>'
                f'<footer><a href="/about-us">About</a><a href="/feeder-2.html">Popular</a></footer></body></html>\n')
    pages = {
        "index.html": page("/", "Home", "<p>Welcome, backyard bird lovers.</p>"),
        "bird-feeders.html": page("/bird-feeders.html", "Bird Feeders", "<p>Tube, suet and window feeders for every yard.</p>"),
        "bird-houses.html": page("/bird-houses.html", "Bird Houses", "<p>Cozy nest boxes.</p>"),
        "about-us": page("/about-us", "About Us", "<p>We have loved birds since 1998.</p>", '<meta name="robots" content="noindex,follow">'),
        "shipping-policy": page("/shipping-policy-old", "Shipping Policy", "<p>Free shipping over $49.</p>"),
        "blog/how-to-attract-cardinals": page(
            "/blog/how-to-attract-cardinals", "How to Attract Cardinals",
            '<article><p>Cardinals love sunflower seeds served from <a href="/feeder-1.html?utm_source=blog">a sturdy tube feeder</a>. '
            'Keep water fresh too: see <a href="/blog/clean-bird-bath">how to clean a bird bath</a> and browse '
            '<a href="/bird-feeders.html">all feeders</a> or <a href="/feeder-0.html?color=Green">the green feeder</a>.</p>'
            '<p>External: <a href="https://www.audubon.org/">Audubon</a></p></article>',
            '<meta property="article:published_time" content="2026-05-02T10:00:00Z"><meta property="article:tag" content="cardinals">'
            '<meta property="article:tag" content="attract birds"><meta property="article:section" content="Bird Guides">'
            '<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting",'
            '"author":{"@type":"Person","name":"Henry"},"dateModified":"2026-08-01"}</script>'),
        "blog/clean-bird-bath": page("/blog/clean-bird-bath", "How to Clean a Bird Bath",
                                     "<article><time datetime='2025-04-01'>April 1, 2025</time><p>Scrub weekly with a stiff brush.</p></article>"),
    }
    for name, html in pages.items():
        (w / name).write_text(html)


def main():
    f = ROOT / "feeds"
    f.mkdir(exist_ok=True)
    for d in (1, 2, 4):
        (f / f"day{d}.xml").write_text(xml(products(d)))
    (f / "day3.tsv").write_text(tsv(products(3)))
    www()
    print("fixtures generated")


if __name__ == "__main__":
    main()
