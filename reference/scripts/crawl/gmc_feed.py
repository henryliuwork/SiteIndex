#!/usr/bin/env python3
"""通用适配器：Google Merchant Center 商品 feed + sitemap。适用于任何能提供 GMC feed 的站点
（Magento、WordPress/WooCommerce、Shopify、自建站），不需要后台 API 权限。

  daily : feed → 商品/变体快照（SKU、价格、划线价、库存、图片、分类）
  weekly: feed 的 product_type → 分类树；sitemap → 页面 SEO 信息 + 博客索引

用法（由 run_sync.sh 调用，也可手动运行）:
  python gmc_feed.py --site <site_dir> --job daily  --out .tmp/snapshot.jsonl
  python gmc_feed.py --site <site_dir> --job weekly --out-dir .tmp
  python gmc_feed.py --site <site_dir> --job inspect          # 打印 feed 字段统计，接入时用

site.json → crawl 相关配置:
  feed_url              str|list  feed 地址或本地路径；多个时按顺序合并，同 id 以先出现者为准
  sku_field             str       作 SKU 的 feed 字段，默认 id（可改 mpn）
  category_source       str       product_type（默认）| google_product_category | url_path
  category_depth        int       取分类路径第几层作主分类，默认 1（"Bird Feeders > Tube" → bird-feeders）
  category_map          object    {原始分类名或slug: 目标slug}，可选
  missing_as            str       feed 会剔除缺货商品时设 out_of_stock（见 inventory_update.py）
  blog_url_patterns     list      博客 URL 正则，默认 ["/blog/", "/news/", "/\\d{4}/\\d{2}/"]
  exclude_url_patterns  list      sitemap 中跳过的 URL 正则
  max_pages             int       weekly 最多抓取页面数，默认 2000
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

TRACKING = re.compile(r"^(utm_|gclid$|gbraid$|wbraid$|srsltid$|fbclid$|mc_|_ga$)")
AVAIL = {"in_stock": "in_stock", "in stock": "in_stock", "instock": "in_stock",
         "out_of_stock": "out_of_stock", "out of stock": "out_of_stock", "outofstock": "out_of_stock",
         "preorder": "preorder", "pre-order": "preorder", "backorder": "preorder", "back order": "preorder"}
VARIANT_ATTRS = ("color", "size", "material", "pattern")


# ---------------- helpers ----------------
def slugify(s: str) -> str:
    s = re.sub(r"&", " and ", (s or "").lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-") or "uncategorized"


def clean_url(u: str | None, base: str | None = None) -> str | None:
    if not u:
        return None
    u = urljoin(base, u.strip()) if base else u.strip()
    p = urlsplit(u)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=False) if not TRACKING.match(k.lower())]
    path = p.path or "/"
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), path, urlencode(q), ""))


def parse_price(v: str | None) -> tuple[float | None, str | None]:
    if not v:
        return None, None
    cur = re.search(r"\b([A-Z]{3})\b", v)
    num = re.search(r"\d[\d.,]*", v)
    if not num:
        return None, cur.group(1) if cur else None
    n = num.group(0)
    if "," in n and "." in n:
        n = n.replace(",", "") if n.rfind(".") > n.rfind(",") else n.replace(".", "").replace(",", ".")
    elif "," in n:
        n = n.replace(",", ".") if len(n.split(",")[-1]) == 2 else n.replace(",", "")
    return round(float(n), 2), cur.group(1) if cur else None


def sale_active(eff: str | None, today: date) -> bool:
    if not eff or "/" not in eff:
        return True
    try:
        a, b = (datetime.fromisoformat(x.strip().replace("Z", "+00:00")).date() for x in eff.split("/", 1))
        return a <= today <= b
    except ValueError:
        return True


def fetch(url: str, ua: str, timeout=120, retries=2) -> tuple[int, bytes]:
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
                    data = gzip.decompress(data)
                return r.status, data
        except urllib.error.HTTPError as e:
            if e.code in (404, 410, 403, 401):
                return e.code, b""
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(2 ** (i + 1))
    raise RuntimeError(f"请求失败 {url}: {last}")


def load_source(src: str, ua: str) -> bytes:
    if re.match(r"^https?://", src):
        status, data = fetch(src, ua)
        if status != 200:
            raise RuntimeError(f"feed 返回 HTTP {status}: {src}")
        return data
    data = Path(src).expanduser().read_bytes()
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


# ---------------- feed parsing ----------------
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parse_feed(data: bytes) -> list[dict]:
    head = data.lstrip()[:1]
    if head == b"<":
        items = []
        for _, el in ET.iterparse(io.BytesIO(data), events=("end",)):
            if _local(el.tag) in ("item", "entry"):
                row: dict = {}
                for ch in el:
                    name = _local(ch.tag)
                    if len(ch):  # nested (shipping, tax …) → skip
                        continue
                    txt = (ch.text or "").strip()
                    if name == "link" and not txt:
                        txt = ch.get("href", "")
                    if name in ("additional_image_link", "product_type") and name in row:
                        row.setdefault(name + "_all", [row[name]]).append(txt)
                        continue
                    row.setdefault(name, txt)
                items.append(row)
                el.clear()
        return items
    text = data.decode("utf-8-sig", errors="replace")
    first = text.splitlines()[0] if text else ""
    delim = "\t" if first.count("\t") >= first.count(",") else ","
    rows = []
    for r in csv.DictReader(io.StringIO(text), delimiter=delim):
        rows.append({(k or "").strip().lower().removeprefix("g:").replace(" ", "_"): (v or "").strip()
                     for k, v in r.items()})
    return rows


def category_of(item: dict, cfg: dict, url: str | None) -> tuple[str, list[str], list[str]]:
    """返回 (主分类 slug, 所有分类 slug, 原始路径名称列表)"""
    src = cfg.get("category_source", "product_type")
    depth = max(1, int(cfg.get("category_depth", 1)))
    cmap = {k.lower(): v for k, v in (cfg.get("category_map") or {}).items()}
    if src == "url_path" and url:
        segs = [s.removesuffix(".html") for s in urlsplit(url).path.strip("/").split("/")[:-1]]
        path = segs or ["uncategorized"]
    else:
        raw = item.get("google_product_category" if src == "google_product_category" else "product_type") or ""
        path = [p.strip() for p in re.split(r"\s*>\s*", raw) if p.strip()] or ["uncategorized"]
    seg = path[min(depth, len(path)) - 1]
    main = cmap.get(seg.lower()) or cmap.get(slugify(seg)) or slugify(seg)
    all_types = [item.get("product_type") or ""] + item.get("product_type_all", [])[1:]
    cats = []
    for t in all_types:
        ps = [p.strip() for p in re.split(r"\s*>\s*", t) if p.strip()]
        if ps:
            s = ps[min(depth, len(ps)) - 1]
            cats.append(cmap.get(s.lower()) or slugify(s))
    return main, sorted(set(cats) | {main}), path


def handle_of(item: dict, url: str | None) -> str:
    if url:
        last = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
        last = re.sub(r"\.(html?|php)$", "", last)
        if last:
            return last.lower()
    return slugify(item.get("item_group_id") or item.get("id") or "")


def to_snapshot(items: list[dict], site: dict) -> tuple[list[dict], dict]:
    cfg = site.get("crawl", {})
    sku_field = cfg.get("sku_field", "id")
    today = date.today()
    out, seen, stats = [], set(), Counter()
    groups = defaultdict(list)
    for it in items:
        sku = (it.get(sku_field) or it.get("id") or "").strip()
        if not sku:
            stats["no_id"] += 1
            continue
        if sku in seen:
            stats["duplicate"] += 1
            continue
        seen.add(sku)
        url = clean_url(it.get("link") or it.get("mobile_link"), site["base_url"])
        price, cur = parse_price(it.get("price"))
        sale, scur = parse_price(it.get("sale_price"))
        if price is None or not url:
            stats["missing_price_or_link"] += 1
            continue
        compare = None
        if sale is not None and sale < price and sale_active(it.get("sale_price_effective_date"), today):
            price, compare = sale, price
        avail = AVAIL.get((it.get("availability") or "").strip().lower(), "unknown")
        stats[avail] += 1
        main, cats, _ = category_of(it, cfg, url)
        qty = it.get("quantity") or it.get("sell_on_google_quantity")
        row = {
            "sku": sku, "product_id": it.get("item_group_id") or it.get("id"),
            "handle": handle_of(it, url), "title": it.get("title") or sku, "variant_title": None,
            "url": url, "category": main, "categories": cats,
            "price": price, "compare_at_price": compare, "currency": cur or scur or site.get("currency"),
            "image_url": clean_url(it.get("image_link")), "stock_status": avail,
            "qty": int(qty) if qty and str(qty).isdigit() else None,
        }
        out.append(row)
        if it.get("item_group_id"):
            groups[it["item_group_id"]].append((row, it))
    # 变体：同一 item_group_id 共用 handle（取最短 URL 的 slug），变体名取差异属性
    for gid, members in groups.items():
        if len(members) < 2:
            continue
        handle = min((m[0]["handle"] for m in members), key=len)
        diff = [a for a in VARIANT_ATTRS if len({(m[1].get(a) or "") for m in members}) > 1]
        for row, it in members:
            row["handle"] = handle
            row["product_id"] = gid
            vt = " / ".join(it.get(a) for a in diff if it.get(a))
            row["variant_title"] = vt or None
    return out, dict(stats)


def read_feeds(site: dict) -> list[dict]:
    cfg = site.get("crawl", {})
    srcs = cfg.get("feed_url")
    if not srcs or srcs == "TODO":
        raise SystemExit("ERROR: site.json → crawl.feed_url 未配置")
    srcs = [srcs] if isinstance(srcs, str) else srcs
    ua = cfg.get("user_agent", "SiteOpsBot/1.0")
    items = []
    for s in srcs:
        items += parse_feed(load_source(s, ua))
    return items


# ---------------- sitemap & pages ----------------
def sitemap_urls(site: dict) -> list[tuple[str, str | None]]:
    cfg = site.get("crawl", {})
    ua = cfg.get("user_agent", "SiteOpsBot/1.0")
    todo, done, urls = list(site.get("sitemaps") or []), set(), {}
    while todo:
        sm = todo.pop(0)
        if sm in done:
            continue
        done.add(sm)
        try:
            data = load_source(sm, ua)
            root = ET.fromstring(data)
        except Exception as e:  # noqa: BLE001
            print(f"WARN sitemap 读取失败 {sm}: {e}", file=sys.stderr)
            continue
        kind = _local(root.tag)
        for node in root:
            loc = lastmod = None
            for ch in node:
                n = _local(ch.tag)
                if n == "loc":
                    loc = (ch.text or "").strip()
                elif n == "lastmod":
                    lastmod = (ch.text or "").strip()[:10] or None
            if not loc:
                continue
            if kind == "sitemapindex":
                todo.append(loc)
            else:
                urls.setdefault(clean_url(loc), lastmod)
        time.sleep(int(cfg.get("rate_limit_ms", 1500)) / 1000)
    return sorted(urls.items())


class PageParser(HTMLParser):
    CHROME = {"header", "nav", "footer", "aside"}
    CONTENT = {"article", "main"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, list[str]] = defaultdict(list)
        self.canonical = None
        self.h1 = None
        self.ldjson: list[str] = []
        self.times: list[str] = []
        self._in = Counter()
        self._buf_title = False
        self._buf_h1 = None
        self._ld = None
        self.words_all = 0
        self.words_content = 0
        self.links_all: list[str] = []
        self.links_content: list[str] = []
        self.has_content_zone = False
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.CHROME | self.CONTENT:
            self._in[tag] += 1
            if tag in self.CONTENT:
                self.has_content_zone = True
        if tag in ("script", "style", "noscript", "template"):
            self._skip += 1
            if tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
                self._ld = []
        elif tag == "title":
            self._buf_title = True
        elif tag == "meta":
            k = (a.get("name") or a.get("property") or "").lower()
            if k and a.get("content") is not None:
                self.meta[k].append(a["content"].strip())
        elif tag == "link" and "canonical" in (a.get("rel") or "").lower():
            self.canonical = a.get("href")
        elif tag == "h1" and self.h1 is None:
            self._buf_h1 = []
        elif tag == "a" and a.get("href"):
            if not any(self._in[t] for t in self.CHROME):
                self.links_all.append(a["href"])
                if any(self._in[t] for t in self.CONTENT):
                    self.links_content.append(a["href"])
        elif tag == "time" and a.get("datetime"):
            self.times.append(a["datetime"])

    def handle_endtag(self, tag):
        if tag in self.CHROME | self.CONTENT and self._in[tag]:
            self._in[tag] -= 1
        if tag in ("script", "style", "noscript", "template") and self._skip:
            self._skip -= 1
            if self._ld is not None:
                self.ldjson.append("".join(self._ld))
                self._ld = None
        elif tag == "title":
            self._buf_title = False
        elif tag == "h1" and self._buf_h1 is not None:
            self.h1 = re.sub(r"\s+", " ", "".join(self._buf_h1)).strip() or None
            self._buf_h1 = None

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
            return
        if self._skip:
            return
        if self._buf_title:
            self.title += data
        if self._buf_h1 is not None:
            self._buf_h1.append(data)
        if any(self._in[t] for t in self.CHROME):
            return
        n = len(re.findall(r"\w+", data))
        self.words_all += n
        if any(self._in[t] for t in self.CONTENT):
            self.words_content += n


def _ld_find(objs, keys):
    found = {}

    def walk(o):
        if isinstance(o, dict):
            for k in keys:
                if k in o and k not in found:
                    found[k] = o[k]
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    for raw in objs:
        try:
            walk(json.loads(raw))
        except Exception:  # noqa: BLE001
            continue
    return found


def _d(v) -> str | None:
    if not v:
        return None
    m = re.match(r"\d{4}-\d{2}-\d{2}", str(v))
    return m.group(0) if m else None


def crawl_pages(site: dict, product_urls: set[str], category_slugs: set[str]) -> tuple[list, list, dict]:
    cfg = site.get("crawl", {})
    ua = cfg.get("user_agent", "SiteOpsBot/1.0")
    delay = int(cfg.get("rate_limit_ms", 1500)) / 1000
    host = urlsplit(site["base_url"]).netloc.lower().removeprefix("www.")
    blog_pat = [re.compile(p) for p in cfg.get("blog_url_patterns", [r"/blog/", r"/news/", r"/\d{4}/\d{2}/"])]
    excl = [re.compile(p) for p in cfg.get("exclude_url_patterns", [])]
    product_by_url = {}
    for u, h in product_urls:  # 变体 URL 常带 ?color= 等参数，同时登记去参数版本
        product_by_url[u] = h
        product_by_url.setdefault(urlunsplit(urlsplit(u)._replace(query="")), h)
    today = date.today().isoformat()
    pages, blogs, stats = [], [], Counter()
    entries = sitemap_urls(site)
    for url, lastmod in entries[: int(cfg.get("max_pages", 2000))]:
        if url in product_by_url or any(p.search(url) for p in excl):
            stats["skipped"] += 1
            continue
        path = urlsplit(url).path
        is_blog = any(p.search(path) for p in blog_pat)
        last = re.sub(r"\.(html?|php)$", "", path.rstrip("/").rsplit("/", 1)[-1]).lower()
        if path in ("", "/"):
            ptype = "home"
        elif last in category_slugs:
            ptype = "collection"
        else:
            ptype = "page"
        try:
            status, body = fetch(url, ua, timeout=60)
        except RuntimeError as e:
            stats["error"] += 1
            print(f"WARN {e}", file=sys.stderr)
            continue
        time.sleep(delay)
        p = PageParser()
        if status == 200:
            try:
                p.feed(body.decode("utf-8", errors="replace"))
            except Exception:  # noqa: BLE001
                pass
        robots = " ".join(p.meta.get("robots", [])).lower()
        canon = clean_url(p.canonical, url) if p.canonical else None
        indexable = status == 200 and "noindex" not in robots and (canon is None or canon == url)
        desc = (p.meta.get("description") or [None])[0]
        title = re.sub(r"\s+", " ", p.title).strip() or None
        words = p.words_content if p.has_content_zone else p.words_all
        if is_blog and status == 200:
            ld = _ld_find(p.ldjson, ["datePublished", "dateModified", "author", "articleSection", "keywords"])
            published = (_d((p.meta.get("article:published_time") or [None])[0]) or _d(ld.get("datePublished"))
                         or _d(p.times[0] if p.times else None) or lastmod or today)
            updated = (_d((p.meta.get("article:modified_time") or [None])[0]) or _d(ld.get("dateModified")) or lastmod)
            author = (p.meta.get("author") or [None])[0]
            if not author and ld.get("author"):
                au = ld["author"]
                au = au[0] if isinstance(au, list) and au else au
                author = au.get("name") if isinstance(au, dict) else str(au)
            links = p.links_content if p.has_content_zone else p.links_all
            internal, prods = set(), set()
            for h in links:
                cu = clean_url(h, url)
                if not cu or urlsplit(cu).netloc.removeprefix("www.") != host or cu == url:
                    continue
                if cu in product_by_url:
                    prods.add(product_by_url[cu])
                elif urlsplit(cu).path not in ("", "/"):
                    internal.add(cu)
            blogs.append({
                "url": url, "slug": last, "title": p.h1 or title or last, "published_at": published,
                "updated_at": updated if updated != published else None,
                "category": (p.meta.get("article:section") or [None])[0] or ld.get("articleSection"),
                "author": author, "tags": sorted(set(p.meta.get("article:tag", []))),
                "meta_description": desc, "word_count": words,
                "links_internal": sorted(internal), "links_products": sorted(prods), "last_crawled": today})
            stats["blog"] += 1
        elif not is_blog:
            pages.append({"url": url, "type": ptype, "title": title, "meta_description": desc, "h1": p.h1,
                          "canonical": canon, "status_code": status, "indexable": indexable,
                          "word_count": words if status == 200 else None, "last_crawled": today})
            stats[ptype] += 1
    return pages, blogs, dict(stats)


def build_categories(items: list[dict], snapshot: list[dict], site: dict, pages_by_slug: dict) -> list[dict]:
    cfg = site.get("crawl", {})
    depth = max(1, int(cfg.get("category_depth", 1)))
    nodes: dict[str, dict] = {}
    counts = defaultdict(set)
    handle_by_sku = {r["sku"]: r["handle"] for r in snapshot}
    sku_field = cfg.get("sku_field", "id")
    used = set()
    for it in items:
        sku = (it.get(sku_field) or it.get("id") or "").strip()
        if sku not in handle_by_sku or sku in used:  # 只统计进入快照的条目（跳过重复、缺价格等）
            continue
        used.add(sku)
        _, _, path = category_of(it, cfg, it.get("link"))
        path = path[depth - 1:] or path  # 主分类层级之上的路径（如 Home & Garden）不进树
        parent = None
        for seg in path:
            slug = slugify(seg)
            nodes.setdefault(slug, {"slug": slug, "name": seg, "parent": parent})
            h = handle_by_sku.get(sku)
            if h:
                counts[slug].add(h)
            parent = slug
    today = date.today().isoformat()
    return [{**n, "url": pages_by_slug.get(n["slug"], ""), "product_count": len(counts[n["slug"]]),
             "last_seen": today} for n in sorted(nodes.values(), key=lambda x: x["slug"])]


# ---------------- main ----------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--job", choices=["daily", "weekly", "inspect"], required=True)
    ap.add_argument("--out")
    ap.add_argument("--out-dir")
    ap.add_argument("--skip-pages", action="store_true", help="weekly 只生成分类，不抓页面")
    a = ap.parse_args()
    sd = Path(a.site).resolve()
    site = json.loads((sd / "site.json").read_text(encoding="utf-8"))

    items = read_feeds(site)
    snap, stats = to_snapshot(items, site)

    if a.job == "inspect":
        keys = Counter(k for it in items for k in it)
        print(f"feed 条目: {len(items)}，可用 SKU: {len(snap)}，统计: {stats}")
        print("字段覆盖率:")
        for k, c in keys.most_common():
            print(f"  {k:32s} {c / max(len(items), 1):6.1%}")
        cats = Counter(r["category"] for r in snap)
        print(f"主分类（category_depth={site.get('crawl', {}).get('category_depth', 1)}）: {dict(cats.most_common(30))}")
        print("示例:", json.dumps(snap[:2], ensure_ascii=False, indent=1))
        return 0

    if not snap:
        print(f"ERROR: feed 无可用商品 {stats}", file=sys.stderr)
        return 2
    if stats.get("missing_price_or_link", 0) > 0.2 * len(items):
        print(f"ERROR: 超过 20% 的条目缺价格或链接 {stats}", file=sys.stderr)
        return 2

    if a.job == "daily":
        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in snap), encoding="utf-8")
        print(f"gmc_feed daily: {len(snap)} SKU {stats}", file=sys.stderr)
        return 0

    od = Path(a.out_dir)
    od.mkdir(parents=True, exist_ok=True)
    cat_slugs = {slugify(seg) for it in items for seg in category_of(it, site.get("crawl", {}), it.get("link"))[2]}
    pages, blogs, pstats = ([], [], {}) if a.skip_pages else crawl_pages(
        site, {(r["url"], r["handle"]) for r in snap}, cat_slugs)
    pages_by_slug = {}
    for pg in pages:
        if pg["type"] == "collection":
            s = re.sub(r"\.(html?|php)$", "", urlsplit(pg["url"]).path.rstrip("/").rsplit("/", 1)[-1]).lower()
            pages_by_slug.setdefault(s, pg["url"])
    cats = build_categories(items, snap, site, pages_by_slug)
    (od / "categories.json").write_text(json.dumps(cats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, rows in (("pages.jsonl", pages), ("blog.jsonl", blogs)):
        (od / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    nourl = sum(1 for c in cats if not c["url"])
    print(f"gmc_feed weekly: {len(cats)} 分类（{nourl} 个未匹配到页面 URL），页面 {pstats}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
