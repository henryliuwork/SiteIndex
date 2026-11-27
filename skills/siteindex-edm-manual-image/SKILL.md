---
name: siteindex-edm-manual-image
version: 1.0.0
description: 将用户给出的商品图片链接匹配到 SKU，通过 SiteIndex CLI 设置 EDM 手动首图。
reads:
  - README.md
  - index/catalog/skus.jsonl
  - index/catalog/product_details.jsonl
  - index/ledgers/sku_media.csv
  - index/views/products.jsonl
writes:
  - index/ledgers/sku_media.csv
  - index/views/products.jsonl
---

# siteindex-edm-manual-image

仅处理用户明确提供的图片链接。先读当前项目 README 和商品数据；workspace 项目按 `_site-index/workspace.json` 的路径映射定位数据，legacy 项目使用 `index/`。不要把示例路径当成其他项目的实际路径。

## 确认商品与图片

1. 按用户明确给出的 SKU → 明确给出的 handle → 产品名称唯一匹配的顺序定位。一个名称匹配多个商品、匹配不到、或父子关系不明时，停止该条并请用户确认，不猜测相似商品。SKU、handle、名称均须来自当前项目数据。
2. 图片 URL 必须由用户提供，使用有效的 `http` 或 `https` 地址。拒绝含用户名或密码、Cookie、访问令牌、签名或到期参数的临时链接；不从标题、SKU 或文件名构造图片地址。来源只能由 URL 域名确认：Mailchimp 域名记 `mailchimp`，其他已确认 CDN 记 `cdn`；无法确认来源时先询问。
3. 默认按整个父子 SKU 组设置首图。用户给的是子 SKU 但未明确说“仅此变体”时，仍由 CLI 找到父组并写入全部子 SKU。只有用户明确说“仅此变体”或“只填这个子 SKU”时才传 `--only-child`。不要自行计算父 SKU 或手改台账。

## 写入并核对

- 对每条已确认的图片执行 `siteindex edm set-image <项目路径> --sku <sku> --url <用户提供的链接>`；仅此变体时追加 `--only-child`。由 CLI 调用 SiteIndex 的 `setManualImage`、展开目标 SKU 并返回实际写入的 SKU 列表及每项替换前的旧值。
- 每次执行后核对 CLI 返回的写入列表。若已有手动首图，向用户说明“旧值 → 新值”；失败或返回不完整时停止该条，不宣称成功，不直接改 `sku_media.csv`。
- 所有成功条目完成后执行 `siteindex views <项目路径>` 重建视图。汇报写入 SKU 数、替换数、未匹配和待确认条目；读取结果只用于核对，不覆盖用户维护的其他图片角色或标签。
- 不在台账、命令日志、报告或公开仓库写入凭据、Cookie、带签名的临时链接或真实运营数据。
