---
name: siteindex-edm-build
version: 1.0.0
description: 根据项目数据制作 EDM 草稿。所有路径从 workspace.json 的逻辑键读取。
reads:
  - _site-index/workspace.json
  - edm.sku_index
  - edm.profile
writes:
  - ledgers/edm_campaigns
---

# siteindex-edm-build

## 数据目录与路径

- 首先读取 `_site-index/workspace.json`。所有板块和 EDM 文件路径必须按其中的逻辑键解析，不得硬编码目录名或根据旧项目习惯推断位置。
- 商品清单使用 `edm.sku_index`；运行配置使用 `edm.profile`；邮件模板、策略和成品目录分别使用 `edm.templates`、`edm.strategy`、`edm.emails`。
- 无法读取映射或配置缺失时先询问用户，不创建猜测的目录。
- 缺少必要运行参数时先向用户提问，并将用户确认的信息写入 `edm.profile` 对应文件。
- 外部邮件服务和连接信息一律视为项目配置项；不记录账号、连接标识或受众 ID。
- 运行结果写入 `ledgers/edm_campaigns` 台账；不得改写自动导出的 SKU 清单。

产出 `*-draft.html`，校验通过后改名 `*-ready.html`，交给 `邮件或平台服务-edm-mc-send` 推 ESP。**不碰 ESP 接口**，不做排期发送。
## 第 0 步（强制）：读项目配置
```
<project root>/_site-index/edm/edm-profile.md
```
需要拿到：品牌色值与字体、max-width 与断点、分类页 URL 表、SKU 形态与产品页 URL 形态、博客 sitemap 地址、UTM 约定、目录路径、邮件类型定义、CTA 配色规则。
不存在 → 停下来向用户收集并生成该文件，不要凭记忆填。
## 模式判定
| 用户意图 | 模式 |
|---|---|
| 新建/更新 header、footer、body 骨架 | **A. Templates** |
| 按计划出邮件 | **B. Create** |
| 用户给 body 片段 + hero URL + CTA，要拼成完整邮件 | **C. Assemble** |
| 改已有邮件里的产品 / 博客 / hero / CTA / 间距 | **D. Re-edit** |
| 校验、修复、能否发送 | **E. Validate** |
C 与 D 经常同时出现（新 campaign 拼接后往往要修 teaser 与间距）。
---
# 模式 A — Templates
模板是长期资产，改一次影响之后所有邮件。文件放 `{templates_dir}`：`header-v4.1.html`、`footer-v4.1.html`、`{type}-body-v4.1.html`（`edu-body-v4.1`、`promo-body-v4.1`、`welcome-body-v4.1`、`abandoned-cart-body-v4.1`、`winback-body-v4.1` …）。
**文件名带版本号**（当前 v4.1）。升级时**新增**下一版（如 `-v4.2`workspace.json` 中的逻辑路径-v5`）整套，并把上一版整套移入 `workspace.json` 中的逻辑路径（文件名保持不变），不要覆盖旧版。读模板一律取目录里**版本号最大**的那套；没有版本号的同名文件（`header.html` 等）是过期副本，不读、不改。Trust Badges 图标源文件在 `workspace.json` 中的逻辑路径（见 A3）。
## A1. 先看再动
列出现有模板给用户确认状态；存在且用户只想用 → 直接退出。缺 → 问是"用户提供文件"还是"按品牌配置生成"。
## A2. 边界定义（拼接靠这三段，必须严格）
- `header-v4.1.html` = logo 栏 + 导航栏的 `<table>` 片段，**只有表格**，不含 `<html>`workspace.json` 中的逻辑路径<head>`workspace.json` 中的逻辑路径<body>`workspace.json` 中的逻辑路径<style>`（首行那一行 XHTML DOCTYPE 是沿用下来的，见下方说明）
- `{type}-body-v4.1.html` = 邮件主体：body 内的 `<style>`（字体 @import、基础 reset、媒体查询、CTA class）+ 主体各 `<tr>` 区块；**不含外层 `<html><body>`**
- `footer-v4.1.html`workspace.json` 中的逻辑路径*|UNSUB|*`，**只有表格**
> ⚠️ 与旧规范的差异：**外层 `<!DOCTYPE html><html><head><邮件或平台服务…><title>` 与 `<body>`workspace.json` 中的逻辑路径<style>`+表格）。`<style>` 归属 body 模板，不再"只留 header 的 `<head>`"。
> 三段都是片段，拼装后再补 shell。成品必须含 `*|UNSUB|*`，否则后台发送检查会拦住。
> `header-v4.1.html` 首行带一行 XHTML DOCTYPE（沿用自旧版），原样保留，不要删改，也不要再加第二个 DOCTYPE。`footer-v4.1.html` 里退订链接 `href="*|UNSUB|*"` 只能出现一次，改样式时这个 href 与链接文字不得改动；版权行下方另有一条 "View in browser" 链接 `href="*|ARCHIVE|*"`（也只能一次，**每封邮件必须有**）。
**单容器铁律**：body 外层 `<table class="…-container">` 是**唯一的 660px 容器**。header、footer 各自是独立的 660px `<table>` 叠在上下，**禁止给 body 再加 `[色值已省略]` 外层 wrapper**（页面底色 `[色值已省略]` 写在 shell 的 `<body style>`）。加了 wrapper → header 白底 + 灰带 + 白卡，三段对不齐。
## A3. 骨架区块（V4.x：板块结构沿用 V3.2，只换样式）
- promotional body：Hero（深绿全出血 + 圆角 kicker + 黄 pill）→ Issue Bar（**奶油底**深绿字）→ 优惠码区（**白色票券卡**：左侧虚线码块、右侧优惠文案，落在与产品网格同色的浅绿底带上；`__CODE_TAIL__` 为可选小字，无内容时删掉整个 `coupon-tail` 段）→ Product Grid（白底圆角卡，价格与按钮对齐）→ Footer CTA（**圆角绿卡**：文案 + **重复优惠码 chip「Use code [CODE] at checkout」** + 黄 pill + fine print）→ Trust Badges
- educational body：Hero 图 → Issue Bar → Opening + above-fold CTA → Pull Quote（可选）→ Spotlight 卡 / 编号 Tips（可选）→ 文章（`__ARTICLE__`，**编号分段**）→ 软产品（浅绿带 + 白卡）→ Teasers「Also Worth Reading」（可选，2 张浅底圆角卡）→ Bottom CTA（绿 pill）→ Trust Badges
- **Trust Badges 恒为最后一个区块，紧贴 footer 之上**（promo 与 edu 一致：CTA 区 → Trust Badges → footer）。V4 起每格带 **44px 图标**（4 张 88px 透明 PNG：shipping / secure / returns / reviews），图标用 邮件或平台服务 托管的**固定地址**，已直接写在 `*-body-v4.1.html` 里；对照表（含 Logo、社交图标）见 `workspace.json` 中的逻辑路径。**不要改这些 URL、不要加 UTM**；换图时先上传、再整串替换，并同步改清单（不要改 Trust 文案与顺序）。
body 骨架里用 `__TOKEN__`workspace.json` 中的逻辑路径<!-- PRODUCT GRID START/END -->`、`<!-- `{identifier}`workspace.json` 中的逻辑路径、`<!-- `{identifier}`workspace.json` 中的逻辑路径、`workspace.json` 中的逻辑路径、`<!-- SOFT PRODUCT `{identifier}`workspace.json` 中的逻辑路径、`workspace.json` 中的逻辑路径、`workspace.json` 中的逻辑路径。每张规范卡片以 `<!-- ══ `{identifier}` … ══ -->` 注释块给出，**builder 按 SKU/内容逐张复制**，不改样式。
### V4.0 占位符表（与 V3.2 同名，只新增下面标 ★ 的）
- 通用：`__CAMPAIGN_NAME__ __DATE__ __SUBJECT__ __SLUG__ __KICKER__ __HERO_TITLE__ __HERO_SUB__ __CTA_URL__ __CTA_LABEL__ __ISSUE_LABEL__ __ISSUE_RIGHT__`
- promo：`__CODE__ __CODE_NOTE__ __CODE_LEAD__ __CODE_TAIL__ __GRID_TITLE__ __PRODUCT_GRID__ __FOOTER_TITLE__ __FOOTER_SUB__ __FOOTER_FINE__`；★`__GRID_SUB__`（仅在规范卡注释里，网格标题下的可选副标题，有文案才加）
- promo 卡内：`__PRODUCT_URL__ __UTM__ __PRODUCT_IMG__ __PRODUCT_ALT__ __CATEGORY__ __PRODUCT_NAME__ __PRODUCT_DESC__ __PRICE_OLD__ __PRICE_NEW__ __SAVE_BADGE__`（`__UTM__` = `?utm_source=newsletter&utm_medium=email&utm_campaign=__SLUG__`；卡内链接写作 `__PRODUCT_URL____UTM__`）
- edu：`__HERO_URL__ __HERO_IMG__ __HERO_ALT__ __QUOTE_KICKER__ __QUOTE_TEXT__ __QUOTE_ATTR__ __SPOTLIGHT__ __TIPS__ __ARTICLE__ __SOFT_KICKER__ __SOFT_TITLE__ __SOFT_PRODUCTS__ __TEASERS__ __BOTTOM_SUB__`
- edu 卡/提示/teaser 内字段见各 `{identifier}` 注释（`__ITEM_*__ __TIP_*__ __N__ __PRODUCT_*__ __TEASER_*__`）；★文章分段行 `__N__ __SEC_TITLE__ __SEC_BODY__`，★段落 `__P__`。
### V4.x 填充细节
- **`__ARTICLE__`**：每个小节复制一行 `{identifier}`「ARTICLE SECTION」。原文标题里的 `1.`workspace.json` 中的逻辑路径2.` 序号前缀去掉，序号放 `__N__`（大号数字格），`__SEC_TITLE__` 只放标题文字；`__SEC_BODY__` = 一个或多个 `{identifier}` 段落 `<p>`（`__P__`）。
- **`__SOFT_PRODUCTS__`**：每张卡一行，按钮文案固定 `Shop Now →`；模板在该 token 之后自带 24px 收尾行，不要再手加间距。V4.1：移动端图片撑满卡片宽度、按钮整行居中（`soft-img-col`workspace.json` 中的逻辑路径soft-text-col`workspace.json` 中的逻辑路径cta-btn-product` 的 `text-align:center`），不要再给 `.soft-card-img` 设 `max-width:220px`。
- **`__TEASERS__`**（V4.1 样式）：整块 = 标题 `__TEASER_TITLE__` + 两张并排的浅底圆角卡（`teaser-col`，中间 16px `teaser-gap`，移动端上下堆叠、间隔 14px）；每卡 = 胶囊标签 `__TEASER_n_TAG__` → Lora 标题 `__TEASER_n_TITLE__`（链接）→ 摘要 `__TEASER_n_EXCERPT__` → `Read Article →`。每卡 2 处链接（标题 + Read Article）。
- **promo 网格默认且必须 4 张产品（2×2）**：不得交付 3 张（会留下一张孤零零的整行卡）；产品不足 4 个时从站点商品页补一个主题相符、有货的产品（真实 URL / 图 / 价格，折后价按本期折扣率），并在报告里说明新增了哪一个。奇数张仅用于刻意的单品主推邮件。
- **promo 网格**：每 2 张卡一个独立 `workspace.json` 中的逻辑路径；奇数张的末行只放 1 张：该 `td` 改 `width="100%"`，卡片图 `style` 里 `max-width:100%` 改为 `max-width:320px;margin:0 auto`。外层 `td` 的 `height="1"`workspace.json` 中的逻辑路径height:1px` **保留**（让同行两张卡等高，移动端规则会重置它）。
- 价格行顺序固定：现价 `__PRICE_NEW__` → 划线原价 `__PRICE_OLD__` → Save 徽章 `__SAVE_BADGE__`。
- **填充后清理（必做）**：①删掉全部 `<!-- ══ `{identifier}` … ══ -->` 注释块；②未用的可选块（Pull Quote 整段 START…END、`__SPOTLIGHT__`、`__TIPS__`、`__TEASERS__`workspace.json` 中的逻辑路径<!-- == 邮件或平台服务 `{identifier}`|`{identifier}` EDM (V4.1) | {名称} | {`{sku}`} | slug: {slug} | {备注} == -->`；④全文不得残留 `__TOKEN__`（`__react-email-column` 是 header 里的合法属性值，不算）。
## A4. 模板硬性约定
CSS 全内联；`<style>` 放在 body 模板顶部（字体 @import、基础 reset、媒体查询、CTA class），shell `<head>` 只放 `workspace.json` 中的逻辑路径；图片绝对 URL；merge tags：`*|UNSUB|*`（退订）与 `*|ARCHIVE|*`（View in browser）必须各 1 处，都在页脚；`*|`{sku}`|*` 不再强制；max-width 与断点取自配置。
**CTA 一律黄/绿 pill（`border-radius:999px`workspace.json` 中的逻辑路径[色值已省略]`+`[色值已省略]`，educational 全用绿 `[色值已省略]`+`[色值已省略]`（V4 起不再用 `[色值已省略]`）；优惠码框用浅绿底（`[色值已省略]`）+ 虚线 + 深绿码块，教育正文不变黄。** 移动端媒体查询里必须含 `.pad-full {`，且 `.cta-btn-*` 有 `display:inline-block;width:auto;max-width:100%`workspace.json` 中的逻辑路径<!--[if mso]>` VML 圆角按钮兜底（VML 的 `href` 也要带 UTM、与锚点一致）；产品卡按钮是普通锚点，不带 VML。
分区间距用 `pad-sides`workspace.json` 中的逻辑路径pad-full`workspace.json` 中的逻辑路径pad-strip` class + inline padding（V4 CSS 里已没有 `pad-top`workspace.json` 中的逻辑路径pad-bottom`；旧邮件里若还有，见 D4）。改完跑一遍模式 E 校验，并在模板 Change Log 记一笔。header/footer 应尽量稳定。
---
# 模式 B — Create（按计划出邮件）
## B1. 读四份输入
1. `{planner_file}` 里目标那封（`#01` 或 `all`）：theme、subject、preview、内容大纲、推荐产品、CTA
2. `workspace.json` 中的逻辑路径（取最新 `-vN`）+ **必须同时读同版本的 `header-v4.1.html` 与 `footer-v4.1.html`**
3. `{sku_index_path}` 商品数据（= 项目 `workspace.json 的逻辑路径`；**邮件里的产品图只用这里登记的 邮件或平台服务 图片 URL**）
4. 品牌配置 + 品牌档案
⚠️ **body 模板只是主体，必须 header + body + footer 三段组装才是完整邮件。** 漏拼页脚 = 没有退订链接 = 发不出去。
## B2. 产品校验
计划里的每个 SKU 都要在商品清单核对：缺货 → 同品类替换并告知用户；价格、图 URL、产品 URL 用真实值，**不编造**。描述写 1–2 句核心卖点，与当期主题呼应。
## B3. 填充规则
- 产品卡：链接、图、alt、名称、描述、价格（原价/折后价）、CTA
- 优惠码按计划写入
- CTA 按钮用真实分类页 URL（hero 与 footer 同一个）
- 所有链接带 UTM（按配置约定，本期 slug 不改）
- preview text：**HTML 里不再放任何 preheader / 预览文案**（`<body>` 后直接接 header，不要出现孤立的文本行）；邮件或平台服务 后台的 `preview_text` 仍由 `邮件或平台服务-edm-mc-send` 通过 API 设置，也不要求 HTML 里写 `*|`{sku}`|*`
- CTA 配色按配置的类型规则（促销用 urgency 黄底绿字，educational 不用黄）
## B4. 输出
目录 `workspace.json` 中的逻辑路径，不存在则创建。
命名 `{序号}-{`{identifier}`}-{3-5个英文小写连词}-draft.html`，例：`01-`{identifier}`-fall-bird-feeding-guide-draft.html`。
**输出前自查清单：**
- [ ] 含 shell：`<!DOCTYPE html>`+`<html>`+`<head>`workspace.json` 中的逻辑路径<body style=… background:[色值已省略]>`（**拼装时现加，不在片段里**；`<body>` 后直接接 header，**无 preheader/预览文案行**）
- [ ] 含 `*|UNSUB|*` 与 `*|ARCHIVE|*`（都来自 footer，各恰好 1 处）
- [ ] 含品牌 logo（header）与社交图标（footer）
- [ ] body 只有**一个** 660px 容器（无 `[色值已省略]` 外层 wrapper 残留）
- [ ] 文件大小符合"完整邮件"量级（纯 body 片段通常远小于完整件；V4 完整件约 25–31 KB，远低于 Gmail 102KB 截断线）
- [ ] 无残留 `__TOKEN__`、无 ``{identifier}`` 注释块；Trust Badges 4 个图标 `<img>` 都在且 URL 与 `assets.readme.txt` 一致
报告：文件路径、对应计划编号、类型、subject、涉及 SKU、状态 `draft`（下一步校验）。
---
# 模式 C — Assemble（body 片段拼完整邮件）
常见输入：用户发一个 body 片段 + hero 图 URL + CTA 分类页，常伴随占位 slug 与间距问题。
## C1. 模板资产查找顺序
1. `workspace.json` 中的逻辑路径、`footer-v4.1.html`（首选，取最新 `-vN`）
2. 历史会话产物（仅兜底核对）
3. 都没有 → 请用户发一份完整 campaign 源码，从中提取 header/footer 存回 `{templates_dir}`（按 `-vN` 命名）再继续
## C2. 拼接
拼装顺序（UTF-8，显式编码见 C4）：
`workspace.json` 中的逻辑路径 + `header.TrimEnd()` + 空行 + `body.Trim()` + 空行 + `footer.TrimEnd()` + `workspace.json` 中的逻辑路径。
shell（`<title>` 取本期 subject）不在片段里；**不再生成 preheader 文本**。
输出命名 `educational-{slug}.html`workspace.json` 中的逻辑路径promotional-{slug}.html`，slug 取 **body 自带的 `utm_campaign` 值**，不要自己改。
拼完核对三段边界闭合标签完整、body 只有一个 660 容器、含 `*|UNSUB|*`。
## C3. Hero 图替换
模板里 hero `<img src>` 常是占位图（`workspace.json` 中的逻辑路径）。替换为用户给的 banner URL。同区块若有 mso fallback 图或 `alt` 引用旧图名，一并检查。
**用户没给 hero URL 时不要自己找图或编图，直接问。**
## C4. 编码与转义（Windows 高发坑）
该项按项目配置处理，不包含固定站点资料。
落地前统计非 ASCII 码点，出现明显乱码码点（如 CJK 区段出现在纯英文邮件里）说明解码错了，立即停手重读。
**不要把 HTML 属性引号批量改成单引号**——内联样式里已有 `'[字体名已省略]'` 这类单引号，改定界符会让属性值提前截断且写入仍"成功"。
## C5. 组装后立刻走模式 E 校验
---
# 模式 D — Re-edit（改已有邮件）
## D0. 三条通用铁律
1. **直接在用户指定的文件路径上操作**，不要先复制到别处再编辑副本——用户看的是原件，会以为没改。（需要项目副本时：先改原件，再复制。）
2. **不改排版**：所有 inline style、class、table 结构、区块顺序保持原样，只换内容。
3. **只做指定改动**：换 hero 图与 CTA 时不动 header 顶部导航、不动产品卡商品链接；改产品时不动 hero 与文字区块。
定位技巧：先按**注释名称**找区块（`SOFT PRODUCT FEATURE`、`ARTICLE TEASERS`、`<!-- Product N: {SKU} -->`），不要按编号硬找——编号会随期数变化。
`edit` 是精确字符匹配，**一个空格不同就报 not found**。做法：先取目标行的行号，再按行区间读出原文，逐字复制进 `old_text`。
## D1. 替换产品卡（promotional）
V4 每张产品卡有 **2 处链接实例**，必须全部一致更新：
1. 图片链接 `<a href="URL?utm_..."><img ...>`
2. 文字 CTA `workspace.json` 中的逻辑路径
（V3.2 及更早的旧邮件卡里可能还有第 3 处 `<!--[if mso]>` VML roundrect 的 `href`——**别删，只换 href**。）
同一卡片内一并更新：注释里的 SKU、`img src`、`img alt`（短名+SKU）、品类标签 `<p>`、标题 `<p>`、描述 `<p>`（≤160 字符，1–2 句卖点）、现价 / 划线原价 / 折扣百分比三个文本。
折后价 = 原价 ×(1 − 折扣率)，保留两位。折扣率取**当期邮件正文声明的百分比**（看优惠码区块），不是随便假设。
⚠️ 结构：V4 网格每行一个独立 `<table>`（旧版是一个大表多个 `<tr>`）。末行若只有 1 张（V4.1 起不应出现：promo 默认 4 张），该 `td` 是 `width="100%"`、图 `max-width:320px;margin:0 auto`。**只替换卡内内容，别改外层 wrapper、`height="1"`、行表结构。**
产品数据来源：**`{sku_index_path}`（`workspace.json 的逻辑路径`workspace.json` 中的逻辑路径原价 / 10% 折后 / 15% 折后` / 库存状态。
**产品图铁律**：邮件或平台服务 不显示站点上的 `.webp`，邮件里产品图（`img src`）一律用 index 的 `[站点地址已省略] `workspace.json` 中的逻辑路径 图，更不要生成 `.webp`。
- 选品：按本期主题从 index 挑 `有货`workspace.json` 中的逻辑路径邮件或平台服务 ` 前缀，描述取 index 短描述（`Description pending.` 时自行写 ≤160 字符、只写站点页面能证实的事实）。
- **图片未录入**（图片 URL 为 `workspace.json` 中的逻辑路径，或 SKU 不在 index 里）：先把该 SKU 补进/保留在 index（线上核对标题、价格、库存；图片填 placeholder），**通知用户去 邮件或平台服务 上传并回填 URL**；回填前该卡暂保留站点图并在报告里列为「待录入」，回填后再按 SKU 更新邮件。能用「已录入」的同主题产品替代的，优先替代，不要让邮件长期挂着未录入的卡。
- **index 的库存/URL 可能过期**：曾发现标 `已下架` 的条目其实只是产品页 slug 变了（线上仍在售）。邮件里**已在用的产品 URL 保留不动**，换图时只换 `img src`；index 状态与线上冲突时以线上产品页为准并告知用户，不要因 index 的 `已下架` 直接换掉整张卡。
- 需要现拉线上数据（index 没有该 SKU）时用浏览器/抓取产品页取 `<h1>` 标题（去掉品牌前缀）、价格、颜色、SKU（从 URL slug 提取）；**图片仍要走上面的"未录入"流程**，不要直接用站点图。
浏览器执行 JS 取图时，**语句包在 `(function(){ ... })()` 里返回 JSON 字符串**，顶层 `const`workspace.json` 中的逻辑路径let`workspace.json` 中的逻辑路径var x =` 会报 SyntaxError。
改完用正则计数核对：旧 SKU 残留 = 0、新 SKU 各出现 2 次（V4；旧版卡含 VML 则 3 次）。
## D2. 替换博客推荐区
两栏各更新：分类标签（2–3 个英文单词，贴合内容）、标题（8–12 个英文单词，**逐字取自文章页 `<title>` 去掉品牌后缀**，不意译）、摘要（120–150 字符，基于真实正文改写）、两处链接（标题 + `Read Article →`，保留 UTM）。
### 占位 slug 必须先核实（经验硬规则）
**body 自带的 teaser slug 几乎全是占位、在站点上不存在。不核实就交付 = 交付死链。**
1. 抓文章清单：站点博客 sitemap（配置里的地址，通常 `workspace.json` 中的逻辑路径；Rank Math 由 `workspace.json` 中的逻辑路径 指向它）。Windows 下 `curl.exe` 可能报 schannel 吊销检查错误，加 `--ssl-no-revoke`。
2. 全部 `<loc>` 落地成 urls 文件再读，按本期主题挑 **2 篇真实存在**的。没有完全对口的就挑最贴近的，**说明取舍理由并给备选**。
3. 核实后替换，再核对：假 slug 残留 = 0，新 slug 各出现 2 次。
4. **占位 slug 经查证不存在这一事实必须如实告知用户**，不能默默换掉。
### Resource Hub 工具页替代（活动/打印向 campaign 的更优选项）
站内有免费下载打印工具页时，用它替代博客推荐区更贴主题。**交付前重新抓一次工具页清单核对**（会新增，别凭记忆）。换工具页必须同步改三处，否则误导读者（那是工具页不是文章）：
- 区块小标题：`Also Worth Reading` → 贴合主题的表述
- 链接文案：`Read Article →` → `Get the Printable →`workspace.json` 中的逻辑路径Open the Tool →`
- 分类标签：改为工具向标签
其余格式与字段完全沿用原推荐区结构，链接同样带本期 utm。
## D3. CTA 批量换链接（硬规则：只改 body 内 5 处）
Campaign CTA 在 body 中 edu 共 5 处：hero 图片链接、hero 按钮 mso fallback、hero 按钮、底部按钮 mso fallback、底部按钮；promo 共 4 处（没有 hero 图片链接）。
- **必须用完整 URL（含整串 utm）做 replaceAll**。只匹配路径段会误伤 header 导航和产品卡链接。
- 绝不动：header 顶部导航（其特征是配置里标注的固定 `utm_campaign`，与本期 slug 不同，replaceAll 天然排除）、soft product 卡片里的商品链接。
- 用户说"CTA 链接不变"时跳过。
- 目标分类页按主题从配置的分类 URL 表选，hero 与 footer 保持一致。
## D4. 间距检查与修复（高发：产品卡与上方板块贴死）
分区用 `pad-sides`workspace.json` 中的逻辑路径pad-full`workspace.json` 中的逻辑路径pad-strip` class + inline padding（V4 模板不使用 `pad-top`workspace.json` 中的逻辑路径pad-bottom`；以下规则针对仍含这两个 class 的旧邮件）：
- `pad-top` = 桌面端 bottom 为 0；`pad-bottom` = 桌面端 top 为 0。**相邻两块分别是「bottom 0」和「top 0」时贴死**（高发：上方卡片区接 soft product 卡）。
- 修复：把贴死区块的 `<td>` 改为 `class="pad-full"`，inline 补回顶部间距。
- ⚠️ **≤520px 媒体查询陷阱**：`pad-top`workspace.json` 中的逻辑路径pad-bottom` 在窄屏会把对应方向 padding 强制压回 0，**只加 inline 值在移动端无效甚至回归贴死**；`.pad-full` 在窄屏有独立规则仍保有间距 → **修间距一律转成 `pad-full`，不要只改 inline padding**。
- 改完 grep 确认 CSS 里存在 `.pad-full {` 的移动端规则，缺则补进 `<style>`。
## D5. Subject / Preview
- Subject 约 35–50 字符（移动端不截断）；Preview 40–90 字符，补全而不重复 subject。
- 数字/功效表述必须与正文一致，属引用需提示用户补来源，避免疗效式承诺。
- 避免全大写、多个感叹号、spam 词。
- 输出 1 组推荐 + 2–3 组备选（好奇心 / 情绪拟人 / 数据驱动各一），并问是否写入 HTML 顶部注释或 `*|SUBJECT|*` 占位。
## D6. 改完的核对（全部用正则计数，不目测）
- 新 CTA URL 计数 = 5（edu）/ 4（promo）（或用户指定处数）；旧 URL + 本期 slug 残留 = 0
- header 导航固定 utm 计数未变；产品卡 SKU 链接未变（除非本轮就是要改产品）
- hero 占位图计数 = 0；假 teaser slug 计数 = 0；新链接计数正确
- 间距修复后 `pad-full` + 正确 inline 值存在、移动端 `.pad-full` 规则存在
- 给出新旧对比汇总表 + 改动文件路径
---
# 模式 E — Validate（校验并自动修复）
输入：单个文件或批量（扫 `workspace.json` 中的逻辑路径）。
基准：品牌配置（色值/字体/max-width）、模板（结构）、商品清单（产品数据）。
## E1. 检查项
| 组 | 检查 | 可自动修 |
|---|---|---|
| A 代码 | DOCTYPE；html/head/body 结构；`<head>` 内单个 `<style>`；无外链样式表；表格布局；标签闭合；HTML 实体完整；UTF-8 声明；无冗余空行 | 部分（外链/表格布局只报告） |
| B ESP 标签 | `*|UNSUB|*` 在页脚退订处且恰好 1 处；**`*|ARCHIVE|*` 必须存在**（页脚 "View in browser"，恰好 1 处）；`*|`{sku}`|*` 不强制；merge tag 语法无冲突 | 是（缺 `*|ARCHIVE|*` 按 `footer-v4.1.html` 的写法补进页脚） |
| C Outlook | mso 条件注释；圆角按钮 VML 回退；无 Outlook 不支持属性 | 否（报告） |
| D 移动端 | `@media` 存在；max-width 符合配置；断点齐备；图 `max-width:100%`；正文字号移动端可读（约 14px） | 部分 |
| E 品牌 | 主/次/强调色、背景色、字体、logo URL、max-width 与配置一致 | 是（logo 404 只报告） |
| F 链接 | 所有 `<a>` 有有效 href；品牌链接带 UTM；退订格式正确；无 `javascript:`/可疑 URL；绝对 URL | 部分 |
| G 产品 | SKU 存在于清单；价格非 0/非空；折后价算式正确；图 URL 与产品 URL 可访问 | 仅折后价（其余报告） |
该项按项目配置处理，不包含固定站点资料。
实体写法统一用 `&amp;`、`&mdash;`、`&rsquo;`。
## E2. 修复循环
分类为「可自动修」与「需人工」。自动修 → 记录每处改动 → **重新跑完整检查** → 若修复引入新问题回到修；若同一问题反复出现（修不动）停止并报告；默认最多 3 轮，用户可提高上限。
常见自动修：补 merge tag、按配置替换品牌色 hex、收窄 max-width、给品牌链接补 UTM、把 `<style>` 移回 `<head>`、重算折后价、清理空行。
## E3. 结果
全部通过 → 文件改名 `-draft.html` → `-ready.html`，输出通过报告。
仍有不可修问题 → **保持 `-draft`**，报告列出问题、类别、建议的人工动作。
不可因"大部分通过"就改名为 ready。
## E4. 报告格式
```markdown
# HTML Validation Report
**File**: ...
**Date**: `{sku}`
**Rounds**: N
**Result**: PASS / FAIL (X issues remaining)
## Auto-Fixes Applied
| # | Issue | Fix |
## Final Check Results
| Category | Total | Pass | Fail | Skipped |
## Remaining Issues
| # | Category | Issue | Recommended Action |
## Status Change
draft → ready
```
## E5. 环境坑
该项按项目配置处理，不包含固定站点资料。
- PowerShell 单行内联命令带复杂括号/管道易解析失败 → 写成临时 `.ps1` 或拆步。
- 抓取产物（sitemap、页面快照）放临时目录，**不要混进输出目录**。
- 多份同名模板时，`old_text` 可能匹配到错的文件——改完先 grep 确认改动落在目标文件上。
- shell 输出过大时宿主会摘要成文字而非原文，别指望用 `Get-Content` 把 3 万字符 HTML 取回上下文。
---

## 数据与安全边界

- SKU、商品名、价格、库存、图片 URL、受众与连接标识必须来自当前项目数据或用户明确提供；不得编造、借用其他项目的数据或写入示例真值。
- 凭据由 SiteIndex 或用户配置读取；不要请求、复制、记录或输出密码、密钥、受众 ID、连接 ID。
- 创建草稿和改写台账前先读取现有内容；写入后回读核对。没有用户明确授权时不排期、不发送。
