---
name: page-design
version: 1.1.0
description: 根据当前项目的设计规范制作页面、专题页、Banner 或邮件模板视觉产出。
reads:
  - index/design/tokens.json
  - index/design/brand.md
  - index/design/screenshots/
  - index/views/products.jsonl
writes: []
---

# page-design

先遵循 siteindex-data 的数据格式与不编造规则。视觉产物保存位置由 README 工作规则或用户当次指定；不要创建默认设计文件夹，也不写 index 数据。

## 读哪些数据

读取 index/design/tokens.json 中颜色、字体、字号、间距、圆角、阴影与组件规范；读取 index/design/brand.md 和 index/design/screenshots/ 了解已有视觉风格。涉及产品时读取 index/views/products.jsonl，图像、价格、链接只引用对应数据字段。检查 extracted_at；超过 60 天时提醒用户规范可能过期。

## 如何筛选判断

- 使用已定义的语义色和 palette、typography、spacing、radius 与 components；新增设计 token 时说明理由并先与用户确认。
- 产品相关视觉只选择数据实际存在且符合用户要求的商品；不从截图推测库存、SKU、价格或图片 URL。
- HTML 邮件使用单栏、表格布局、内联样式和 Web 安全字体回退；CSS 变量应与 tokens 对应。

## 写哪些台账

无。设计产物不是 SiteIndex 台账；如用户要求保存文件，按其指定位置交付。除非用户明确要求更新项目数据并确认具体值，否则不要修改 index/design 或任何其他 index 文件。
