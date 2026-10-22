# {{DOMAIN}} · Agent 工作规则

本仓库是 {{DOMAIN}} 的运营数据仓库。工具包位于同级目录 `../site-ops-toolkit/`。

## 开工
1. `git pull --rebase`（本仓库与 `../site-ops-toolkit` 都要拉）
2. `python ../site-ops-toolkit/scripts/build_views.py .`
3. 读 `site.json` 了解品牌、调性、目标人群
4. 按下方「任务路由」只读所需文件，不要全量扫描仓库

## 任务路由
| 任务 | 使用 skill | 读 | 写 |
|---|---|---|---|
| 写 EDM | edm-builder | views/products.jsonl, edm/index.jsonl, site.json | edm/{date}-{slug}/, edm/index.jsonl |
| 录入 Mailchimp 图片 | sku-media-enrich | catalog/skus.jsonl, enrich/sku_media.csv | enrich/sku_media.csv |
| 打标签/设优先级 | sku-media-enrich | catalog/skus.jsonl, enrich/sku_tags.csv | enrich/sku_tags.csv |
| 库存汇报/分析 | stock-report | reports/daily/, inventory/events/, inventory/daily_summary.csv | 无 |
| 外链搜集 | link-prospect | site.json, outreach/contacted.jsonl | outreach/contacted.jsonl + linkflow(MCP) |
| 写博客 | blog-writer | site.json, content/*, catalog/pages.jsonl, views/products.jsonl | content/drafts/, content/keywords.jsonl |
| 每日/每周同步 | site-sync | 网站前台 | catalog/, inventory/, reports/, content/blog_index.jsonl, logs/ |

## 写入权限（强制）
- AGENT 可写：`enrich/` `content/keywords.jsonl` `content/drafts/` `outreach/` `edm/`
- 仅 SYNC 可写：`catalog/` `inventory/` `reports/` `content/blog_index.jsonl` `logs/`
- 仅 OWNER 可写：`site.json` `AGENTS.md` `CLAUDE.md`
- `views/` 为生成目录，禁止手写，禁止提交
- 发现 SYNC 文件数据错误：不修改，向用户报告，并建议在 `site.json → crawl.overrides` 中修正

## 数据格式
- 字段定义：`../site-ops-toolkit/docs/DATA_DICTIONARY.md`
- JSONL 一行一条、按主键升序；CSV 首行表头、按主键升序；日期 `YYYY-MM-DD`；空值 `null`
- 修改 JSONL/CSV 时用脚本或逐行读写，保持排序与键顺序；不整体重写无关行

## 收工
1. `python ../site-ops-toolkit/scripts/validate.py .`，有 ERROR 必须修复
2. `git add` 仅添加本次写入的路径
3. `git commit -m "<前缀>: <说明>"`，前缀：`enrich` `edm` `content` `outreach`
4. `git pull --rebase && git push`
5. 向用户汇报：改了哪些文件、新增/修改多少条

## 禁止
- 提交 `views/`、`*.db`、临时文件、密钥
- 编造 SKU、价格、库存、图片 URL；数据缺失时标注并询问
- 推荐 `stock_status != in_stock` 或 `exclude_edm = 1` 的产品进入 EDM，除非用户明确要求
