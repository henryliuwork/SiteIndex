# WooCommerce v0.6.5 synthetic inputs

All hosts use `.example.test`. Product names, SKUs, prices and media are invented.
These are input fixtures, not golden outputs or evidence from an installed app.
No current product API or output shape is assumed. The route table lets a loopback
server return each payload with its declared status and content type.

| Scenario | Inputs | Expected observation when support is implemented |
| --- | --- | --- |
| Valid product Feed | `gmc-products.xml` | Product Feed is accepted; variation URL retains its SKU and is canonicalized for SEO. |
| Blog RSS entered as Feed | `home.html`, `blog-rss.xml` | Blog/comment RSS is excluded from product Feed candidates; no product snapshot is silently replaced. |
| Inquiry Feed without prices | `b2b-no-price.xml` | Missing price is diagnosed explicitly; any nullable-price policy awaits a separate contract. |
| No Feed, Store API available | `home.html`, `store-api-*.json` | Products, categories and variable/variation stock are collected through public GET endpoints. |
| No Feed, Store API blocked or missing | `store-api-forbidden.json`, `store-api-missing.json`, `*sitemap.xml`, `product-page.html` | 403 or 404 selects Sitemap + HTML fallback, without pretending the API succeeded. |
| Multiple custom category prefixes | `category-sitemap.xml`, `category-page.html`, `store-api-categories.json` | Both `/shop/` and `/gear/outdoor/` paths are considered; parent category is preserved. |
| Variable product query URL | `gmc-products.xml`, `product-sitemap.xml`, `product-page.html` | `attribute_pa_*` query does not create a second SEO page; the child SKU remains visible. |
| WordPress blog alongside products | `home.html`, `post-sitemap.xml`, `blog-page.html` | Blog enters content indexing while product Feed detection ignores blog RSS. |

`routes.json` records synthetic GET responses, including status codes. The
403/404 responses are intentional test cases. No external requests are needed.
