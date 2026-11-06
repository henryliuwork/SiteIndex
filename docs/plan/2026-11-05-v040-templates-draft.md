# v0.4 工作区模板草案（供 C 落地到 `templates/workspace/`）

> 约定：`{{变量}}` 由程序渲染；`siteindex:auto` 区块由程序维护，id 不得改；其余为用户区。模板里不出现任何品牌、域名、受众 ID、账号、连接标识。
> 变量：`{{brand_name}}` `{{domain}}` `{{base_url}}` `{{platform_label}}`（Magento 2 / WooCommerce / Shopify / 其他）`{{markets}}` `{{created_at}}`。

## 1. `README.md`

```markdown
# {{brand_name}} · 项目说明

> 本文件说明项目是什么、目录在哪。agent 的工作规则在 `AGENTS.md`，先读它。
> 带 `siteindex:auto` 标记的区块由 SiteIndex 维护，不要手动修改；其余内容由用户和 agent 维护。

## 项目概况
- 网站：{{base_url}}（{{platform_label}}）
- 目标市场：{{markets}}
- 创建时间：{{created_at}}

## 当前重点
<!-- 本月目标、进行中的事项、近期不要碰的内容 -->

## 目录地图
<!-- siteindex:auto:start id="workspace-map" -->
<!-- siteindex:auto:end id="workspace-map" -->

## 数据概况
<!-- siteindex:auto:start id="index-summary" -->
<!-- siteindex:auto:end id="index-summary" -->

## 最近变更
<!-- siteindex:auto:start id="changelog" -->
<!-- siteindex:auto:end id="changelog" -->
```

## 2. `AGENTS.md`

```markdown
# {{brand_name}} · Agent 工作手册

进入本目录工作的 agent 必须遵守本文件。项目是什么、目录在哪见 `README.md`。
带 `siteindex:auto` 标记的区块由 SiteIndex 维护，不要修改。**不要直接编辑本文件的其他部分**：需要新增或修改约定时，把提案写进 `_outputs/agents-md-proposals.md`（每条带日期、理由、建议的位置），由用户确认后合并。

## 一、先读什么

1. `README.md`：项目概况与目录地图。
2. 本文件。
3. 做具体任务前，读对应板块目录里的 `README.md`。
4. 站点事实（SKU、价格、库存、URL、分类、博客清单、设计规范）**先读数据层**，见下方「数据指南」；数据缺失或冲突时如实说明，不要凭记忆或临时爬站给结论。

<!-- siteindex:auto:start id="agents-core" -->
<!-- siteindex:auto:end id="agents-core" -->

## 二、两条基本原则

1. **板块目录只放产物**：每个板块固定少量子目录，需要分组时按当期需要临时建。
2. **agent 要读的数据一律在 `_site-index/`**：它由 SiteIndex 维护，agent 只读；需要写入的台账只能通过 `siteindex ledger upsert`（或 MCP 的写入工具），不要直接编辑数据文件。

## 三、落盘与审核

1. 产物命名：`YYYY-MM-DD-<主题>.<状态后缀>.<扩展名>`；主题用英文小写连字符。
2. 待审产物先放 `_outputs/`；用户审完移到对应板块。板块目录里的文件视为已通过的现行版本。`_outputs/` 里的项处理完必须移走，空目录 = 没有待办。
3. 状态后缀只表达渠道自身进度：`-draft` / `-ready` / `-scheduled` / `-sent` / `-published`。例外：EDM 邮件成品留在 `04-edm/emails/` 内就地改名，不进 `_outputs/`。
4. 改文件前先读。**不做删除**：需要下线的内容移入 `_archive/`，只进不改。
5. 批量改写、格式转换一律生成副本，不覆盖原始数据与素材。
6. `_tmp/` 放中间文件，可随时清空。

## 四、硬边界

- 不可逆动作不自动执行：发送、排期、商品上下架、改价改库存、促销生效、退款、对外发送消息——只做到草稿或方案，交用户确认后执行。
- 写入类操作（发布、更新内容、排期）不以接口返回成功为准，必须回读核对。
- 商品参数、材质、认证、价格、数据结论必须有来源；未知项写「待补充」，不编造。正文出现具体百分比或统计时注明来源。
- **不要读取、复制、输出 `.env`**。凭据只由 SiteIndex 读取。
- 不要修改 `_site-index/` 内由 SiteIndex 维护的文件；不要把凭据、密钥写进任何文件或对话。

## 五、文件编码

- 所有文本文件使用 UTF-8。
- Windows 下 PowerShell 的默认编码会写坏中文与符号：写文件用编辑工具或明确指定 UTF-8，不要用 `Set-Content` 直接输出中文内容。
- 控制台输出中文可能乱码：需要核对完整输出时重定向到 `_tmp/` 文件再读。

<!-- siteindex:auto:start id="task-routing" -->
<!-- siteindex:auto:end id="task-routing" -->

<!-- siteindex:auto:start id="data-guide" -->
<!-- siteindex:auto:end id="data-guide" -->

<!-- siteindex:auto:start id="design-summary" -->
<!-- siteindex:auto:end id="design-summary" -->

<!-- siteindex:auto:start id="skills-installed" -->
<!-- siteindex:auto:end id="skills-installed" -->

<!-- siteindex:auto:start id="esp-presets" -->
<!-- siteindex:auto:end id="esp-presets" -->

## 项目约定与变更记录（用户确认后追加）
<!-- 每条：日期 · 约定内容 · 来源（用户口头 / agent 提案已确认） -->
```

## 3. 预设区块 `esp.mailchimp`（渲染进 `esp-presets` 区块）

```markdown
### 邮件渠道规则（Mailchimp）

- 受众、连接、发件人等参数记录在 `_site-index/edm/edm-profile.md`。缺失时先向用户询问并记录，不凭默认值或其他项目的配置代填。
- 只操作该配置中指定的受众。创建 campaign 必须显式传受众 ID；其他受众一律不读、不列、不建、不发。
- 默认只建草稿，**不主动排期或发送**；排期、发送必须用户明确要求。
- 接口按 UTC 存储时间：口头时区先换算成 UTC 再写入，汇报时同时写出本地时间与 UTC。
- 更新类接口可能整体替换设置：改任一字段须整份带上，写后回读核对。
- 写入后回读邮件内容与设置，不以接口 200 判定成功；非法值可能被静默丢弃。
- 邮件里的产品图必须是 ESP 能显示的格式（jpg/png/gif），不用 webp；图片 URL 取自 `ledgers/sku_media` 台账或 `_site-index/edm/sku-index.md`，没有可用图的 SKU 列出来等待用户处理。
- 主题行与预览文案来自邮件实际内容，不凭空编写。
```

## 4. `_site-index/workspace.json`

```json
{
  "version": "1.0",
  "layout": "workspace",
  "sections": [
    { "id": "brand", "dir": "01-brand" },
    { "id": "products", "dir": "02-products" },
    { "id": "seo", "dir": "03-seo" },
    { "id": "edm", "dir": "04-edm" },
    { "id": "affiliate", "dir": "05-affiliate" },
    { "id": "site-updates", "dir": "06-site-updates" },
    { "id": "reports", "dir": "07-reports" }
  ],
  "paths": {
    "edm.templates": "04-edm/templates",
    "edm.planner": "04-edm/planner",
    "edm.strategy": "04-edm/strategy",
    "edm.emails": "04-edm/emails",
    "edm.profile": "_site-index/edm/edm-profile.md",
    "edm.sku_index": "_site-index/edm/sku-index.md",
    "edm.raw_reports": "_site-index/edm/reports",
    "brand.facts": "01-brand",
    "products.stock_reports": "02-products/stock",
    "seo.audit": "03-seo/audit",
    "seo.blog": "03-seo/blog",
    "reports.inbox": "07-reports",
    "outputs": "_outputs",
    "archive": "_archive",
    "tmp": "_tmp"
  },
  "esp_presets": ["mailchimp"]
}
```

## 5. 板块 `README.md`（骨架，C 参照以下内容改写措辞）

每个板块 README 固定四段：**放什么 / 命名 / 谁写谁读 / 和数据层的关系**，不超过 30 行。子目录如下：

| 板块 | 子目录 | 要点 |
|---|---|---|
| `01-brand` | `sops/`、`assets/` | 品牌与站点唯一参照；品牌事实冲突时以这里为准；`site-facts.md`、`brand-profile.md`、`voice-and-style.md` 由用户创建，未知项写「待补充」，agent 不猜 |
| `02-products` | `listings/`、`media/`、`stock/` | 上下架与描述改稿、图片视频、缺货与补货报告；SKU、价格、库存读数据层，不在这里存副本；上下架与改价只输出可审阅清单 |
| `03-seo` | `audit/`、`blog/`、`topic-pages/`、`guest/`、`refresh/` | 划分依据是发布通道与生命周期；内链与博客 slug 上线前验证返回 200；关键词、排名等机器数据在数据层 |
| `04-edm` | `templates/`、`planner/`、`emails/`、`strategy/` | 模板、月度计划、邮件成品（按 `YYYY/MM` 归档）、节奏规范；邮件运行配置在 `_site-index/edm/edm-profile.md` |
| `05-affiliate` | `newsletter/`、`kit/`、`partners/` | 联盟简报、对外素材包、伙伴名录与绩效；追踪链接不与其他渠道混用 |
| `06-site-updates` | `banners/`、`pages/`、`campaigns/` | 区分长期页面与有档期的活动页；活动结束即下线的进 `campaigns/` |
| `07-reports` | 无子目录 | 见下 |

### `07-reports/README.md`

```markdown
# 07-reports · 原始报表收件箱

放从 GSC、GA4、广告平台、ESP 等下载的**原始数据报表**，供 agent 阅读分析。根目录平铺，不建子目录。

## 命名规范
下载的文件保持平台原始文件名直接放入——这表示「未处理」。
agent 读取并使用后，必须改名为：

`YYYY-MM-DD_<来源>_<范围>_<时间段>.<扩展名>`

- 日期：下载或导出当天
- 来源：`gsc` / `ga4` / `ads-google` / `ads-meta` / `mailchimp` 等小写英文
- 范围：`queries` / `pages` / `campaigns` / `products` 等
- 时间段：`2026-10` 或 `2026-10-01..2026-10-31`

示例：`2026-11-05_gsc_queries_2026-10.csv`

## 规则
- 不覆盖、不删除原始数据；改名后文件内容保持不变。
- 分析结论写到对应板块（如 `03-seo/audit/`），不要写回这里。
- 需要核对口径时，在结论里写明文件名与时间段。
```

## 6. `_outputs/README.md`、`_archive/README.md`、`_tmp/README.md`

- `_outputs`：待用户审核的产物；审完移走；空目录 = 没有待办；`agents-md-proposals.md` 也放这里。
- `_archive`：结案归档，只进不改。
- `_tmp`：中间文件，可随时清空，已加入 `.gitignore`。

## 7. `.env`（空模板，生成时写入；`.env.example` 不需要）

```
# SiteIndex 读取，agent 不读取、不复制、不输出本文件
# WordPress 媒体上传（EDM 图片托管）
wp_base_url=
wp_username=
wp_app_password=
```

## 8. `.gitignore`

```
_tmp/
.env
*.key
*.pem
Thumbs.db
desktop.ini
.DS_Store
.vscode/
.idea/
_site-index/logs/
_site-index/.lock
_site-index/.runner.json
```
