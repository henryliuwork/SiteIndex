# 抓取适配器约定

每种建站平台一个适配器：`scripts/crawl/<adapter>.py`，`<adapter>` 与 `site.json → crawl.adapter` 一致。
适配器**只负责抓取并输出标准格式**，不写站点仓库里的任何文件；合并、对比、事件、日报全部由 `inventory_update.py` / `weekly_update.py` 完成。

## 命令行接口

```bash
python <adapter>.py --site <site_dir> --job daily  --out .tmp/snapshot.jsonl
python <adapter>.py --site <site_dir> --job weekly --out-dir .tmp
```

- 读取 `site.json` 获取 `base_url`、`sitemaps`、`crawl.rate_limit_ms`、`crawl.user_agent`、`crawl.exclude_url_patterns`、`crawl.stock_rules`
- 必须遵守 `rate_limit_ms`，失败请求重试 2 次（指数退避）
- 成功退出码 0；抓取明显不完整（如产品数为 0、超过 20% 请求失败）时退出码非 0，不输出文件

## daily 输出：`snapshot.jsonl`

一行一个变体，必填字段：

| 字段 | 说明 |
|---|---|
| `sku` | 有 SKU 编码用编码，否则 `{handle}:{variant_id}`；同一 SKU 在不同运行中必须稳定 |
| `product_id` `handle` `title` `url` `category` `price` `currency` | 见数据字典 |
| `stock_status` | `in_stock` / `out_of_stock` / `preorder` / `unknown`，判断优先级：结构化数据（JSON-LD `availability`、平台 JSON 的 `available`）> `stock_rules` 文案匹配 > `unknown` |

可选：`variant_title` `categories` `compare_at_price` `image_url` `qty`

`category` 取产品所在的第一个/主分类 slug；无法判断时用 `uncategorized`。

## weekly 输出：`--out-dir` 下 3 个文件

| 文件 | 内容 |
|---|---|
| `categories.json` | 分类数组（slug, name, url, parent, product_count） |
| `pages.jsonl` | 首页、分类页、静态页的 SEO 字段（不含产品页、博客） |
| `blog.jsonl` | 全部已发布博客（含 links_internal、links_products） |

## 已实现

| 适配器 | 数据源 | 适用 |
|---|---|---|
| `gmc_feed.py` | GMC 商品 feed（XML/TSV/gzip，支持多个）+ sitemap | 任何有 GMC feed 的站点。**默认首选**。接入时先运行 `--job inspect` 查看字段覆盖率与分类层级 |

## 平台实现提示（有 API 权限后可选）

| 平台 | 产品与库存来源 |
|---|---|
| Shopify | `/products.json?limit=250&page=N` 分页；变体 `available` 字段判断库存；分类用 `/collections.json` + `/collections/{handle}/products.json` |
| WooCommerce | Store API `/wp-json/wc/store/v1/products?per_page=100&page=N`，`is_in_stock` / `is_purchasable` |
| 其他 | sitemap 中的产品 URL → 页面 JSON-LD `Product.offers.availability`；无结构化数据时用 `stock_rules` |
