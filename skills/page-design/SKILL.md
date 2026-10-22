---
name: page-design
version: 1.0.0
description: 按当前网站项目提取的设计规范制作落地页、专题页、Banner、邮件模板等视觉产出，确保颜色、字体、按钮、间距与网站一致。用户要求做页面、设计稿、Banner、活动页时使用。
---

# page-design

工作目录为项目根目录。产出放入 README「目录地图」中的设计类文件夹（默认 `设计/`）。

## 读取
- `index/design/tokens.json`：颜色（语义色 + palette）、字体与字号阶梯、间距、圆角、阴影、按钮与输入框样式、Logo
- `index/design/brand.md`：视觉风格说明
- `index/design/screenshots/`：参考现有页面风格
- 涉及产品时：`index/views/products.jsonl`（只用有货产品；图片、价格、链接取自数据）
- `extracted_at` 早于 60 天时提醒用户规范可能过期

## 规则
- 颜色只用 tokens 中的语义色与 palette；新增颜色需说明理由
- 字体用 `typography.font_families`；字号用 `typography.scale` 中的级别
- 按钮、输入框照搬 `components` 样式
- 间距、圆角取 `spacing`、`radius` 中的值
- HTML 产出：CSS 变量集中定义在 `:root`，变量名与 tokens 对应
- 邮件模板：600px 单栏、表格布局、内联样式、Web 安全字体回退

## 交付
文件路径、所用 tokens 清单、与规范不一致之处（如有）及原因。
