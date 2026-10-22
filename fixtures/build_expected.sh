#!/usr/bin/env bash
# 用 Python 参考实现生成 fixtures/expected/（新目录结构）。
# 需要：python3 ≥ 3.10、jsonschema；会在 127.0.0.1:8765 启动临时 http 服务提供 fixtures/www/
# 用法：bash fixtures/build_expected.sh
set -euo pipefail
F="$(cd "$(dirname "$0")" && pwd)"
R="$(dirname "$F")"
REF="$R/reference"
W="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null || true; rm -rf "$W"' EXIT

(cd "$F/www" && exec python3 -m http.server 8765 >/dev/null 2>&1) & SRV=$!
sleep 1

python3 "$REF/scripts/new_site.py" "$W/site" --domain kingsyard.com --name Kingsyard >/dev/null
cp "$F/inputs/site.json" "$W/site/site.json"
cd "$W/site"
setfeed() { python3 -c 'import json,sys;s=json.load(open("site.json"));s["crawl"]["feed_url"]=sys.argv[1];json.dump(s,open("site.json","w"),indent=2,ensure_ascii=False)' "$1"; }

rm -rf "$F/expected"; mkdir -p "$F/expected/snapshots" "$F/expected/steps"
for spec in "day1.xml 2026-10-19" "day2.xml 2026-10-20" "day3.tsv 2026-10-21" "day4.xml 2026-10-22"; do
  set -- $spec; d="${1%.*}"
  setfeed "$F/feeds/$1"
  python3 "$REF/scripts/crawl/gmc_feed.py" --site . --job daily --out "$F/expected/snapshots/$d.jsonl" 2>/dev/null
  code=0; python3 "$REF/scripts/inventory_update.py" . --snapshot "$F/expected/snapshots/$d.jsonl" --date "$2" >/dev/null 2>&1 || code=$?
  # 每一步之后的 SKU/库存/事件状态，便于逐日对比
  mkdir -p "$F/expected/steps/$d"
  cp catalog/skus.jsonl inventory/latest.jsonl inventory/daily_summary.csv "$F/expected/steps/$d/"
  cat inventory/events/*.jsonl > "$F/expected/steps/$d/events.jsonl" 2>/dev/null || true
  echo "$code" > "$F/expected/steps/$d/exit_code"
done

setfeed "$F/feeds/day3.tsv"
python3 "$REF/scripts/crawl/gmc_feed.py" --site . --job weekly --out-dir "$W/weekly" 2>/dev/null
python3 "$REF/scripts/weekly_update.py" . --categories "$W/weekly/categories.json" --pages "$W/weekly/pages.jsonl" --blog "$W/weekly/blog.jsonl" >/dev/null

L="$F/inputs/ledgers"
python3 "$REF/scripts/upsert.py" . enrich/sku_media.csv --rows "$L/sku_media.jsonl" >/dev/null
python3 "$REF/scripts/upsert.py" . enrich/sku_tags.csv --rows "$L/sku_tags.jsonl" >/dev/null
python3 "$REF/scripts/upsert.py" . content/keywords.jsonl --rows "$L/keywords.jsonl" >/dev/null
python3 "$REF/scripts/upsert.py" . outreach/contacted.jsonl --rows "$L/outreach.jsonl" >/dev/null
python3 "$REF/scripts/upsert.py" . edm/index.jsonl --rows "$L/edm_campaigns.jsonl" >/dev/null
mkdir -p edm/2026-10-05-fall-feeding
python3 "$REF/scripts/build_views.py" . >/dev/null

C=2026-10-20-halloween
mkdir -p "edm/$C" && cp "$F/inputs/edm/$C/content.json" "edm/$C/"
python3 "$REF/edm/render.py" . "edm/$C" 2>/dev/null >/dev/null
python3 "$REF/scripts/validate.py" . --quiet >/dev/null

# 映射到新目录结构（DATA_SPEC 第 3 节）
E="$F/expected/project"; I="$E/index"
mkdir -p "$I"/{catalog,inventory,content,ledgers,views,reports,logs} "$E/edm/$C"
cp site.json "$I/site.json"
cp catalog/* "$I/catalog/"
cp -r inventory/* "$I/inventory/"
cp content/blog_index.jsonl content/keywords.jsonl "$I/content/"
cp enrich/sku_media.csv enrich/sku_tags.csv "$I/ledgers/"
cp edm/index.jsonl "$I/ledgers/edm_campaigns.jsonl"
cp outreach/contacted.jsonl "$I/ledgers/outreach.jsonl"
cp views/products.jsonl "$I/views/"
cp -r reports/daily "$I/reports/"
cp logs/runs.jsonl "$I/logs/"
cp "edm/$C/email.html" "edm/$C/products.json" "$E/edm/$C/"
find "$F/expected" -name .gitkeep -delete
echo "expected/ 已生成"
