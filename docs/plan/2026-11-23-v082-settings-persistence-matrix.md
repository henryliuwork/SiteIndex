# v0.8.2 设置保存审计矩阵（W0）

> 基线：最初从 `origin/main` `7c44825` 取证，文档分支已变基至包含 #762 的当前 main。只用虚构项目的隔离副本取证。项目级 `S/R/U` 分别表示正式 UI 保存后读回、退出重开后读回、从 v0.8.0 覆盖升级后读回；合成 Core/IPC 证据另列，不能替代这些格。`待验`不等于通过。
>
> 本矩阵按 roadmap §5.2 的封闭范围列设置项。项目配置写入共用 `projects.updateConfig` → `site.json` → `projects.get`；应用配置由 C 的 `settings.set/get` → `settings.json`；分类、计划、README、待办、GSC 的独立 API 单列。

## 已确认的复现与公共风险

| 编号 | 复现步骤与结果 | 归属 |
|---|---|---|
| R1 | 旧版合成复现：只提交 `seo.core_keywords` 后，`seo.competitors` 与 `seo.title_range` 消失。#762 已修 Core 深合并、dirty/revision、显式清空和写后读回，三系统 CI 全绿；正式 UI 提交仍待验。 | [#743](https://github.com/henryliuwork/SiteIndex/issues/743)，D 类 |
| R2 | 旧版合成复现：README 缺 `## 当前重点` 时提交 `focus="Focus text"`，保存返回成功，重读仍无内容。#752 已修 Core 补标题并通过三系统 CI；打包 UI 保存与缺段提示仍待验。 | [#745](https://github.com/henryliuwork/SiteIndex/issues/745)，D 类 |
| R3 | 旧版隔离 mock 页每键 trim/filter，尾部空格与回车空行无法暂存。#761 已修 7 个真正的多行字段为原始草稿至失焦/保存；站点地图仍是单行框，不在该修复内。正式 UI 读回待验。 | [#761](https://github.com/henryliuwork/SiteIndex/pull/761)，I8 |
| R4 | D 在隔离 mock 页先加载旧草稿，再通过另一次调用更新 `brand.tagline`，只在页面改品牌名后保存；提交的 16 个顶层字段仍含旧 tagline，读回也回退为旧值。 | [#743 评论](https://github.com/henryliuwork/SiteIndex/issues/743)，D 类 |
| R5 | 旧版合成复现：README 模板初始含 5 个自动区块标记；保存工作规则后标记从 5 个变为 0 个。#752 已修 Core 读写边界并通过三系统 CI；打包 UI 待验。 | [#745 评论](https://github.com/henryliuwork/SiteIndex/issues/745#issuecomment-7094778905)，D 类 |

Core [#762](https://github.com/henryliuwork/SiteIndex/pull/762) 已合并受保护的 `updateConfig` 路径：深合并、revision、显式 `clear`、写后读回与无操作字节不变；旧两参调用仍可清空，D 的 dirty/revision UI 提交尚待接线。C [#747](https://github.com/henryliuwork/SiteIndex/pull/747) 已修 `settings.json` 未知字段丢失与无操作重写；通知旧草稿风险由 #744 跟进。#752/#759 的 README Core 修复已合并，E 已复验 Core 直接路径，#745 已关闭；B 页面提示与正式安装版仍待验。A 的复现只写系统临时目录。

### 升级路径的已验证范围

`v0.8.0` 标签中的 `fixtures/e-v050-w0/projects/legacy/index/site.json` 与 `templates/project/README.md` 曾和取证时 main 的对应文件 Git blob 相同。A 将其复制到系统临时目录，填入虚构 SEO 关键词、竞品域名、长度范围和博客识别配置，再由当时 Core 新建 service 加载并运行 `views`、`validate`、`readme`。加载与三个任务后，`site.json` 中这些用户字段逐键保留；`views` 和 `readme` 返回 `ok`，`validate` 因该轻量 fixture 缺校验所需文件返回 `failed`，但仍未改写上述字段。模板的三个用户段正文在 `readme` Job 后仍在；读回“工作规则”在 Job 前误含自动标记，见 R5（#752 已修）。

这只能证明**旧版文件经当时 Core 的上述路径**的行为。下面分别记录 v0.7.5/v0.7.6/当前 Core 源码探测与 v0.8.0 同源打包 CLI 探测；两者均未执行正式安装包覆盖升级。“升级后变空”的准确步骤目前**未复现**，U 列仍为待验。

### §5.3 W0：跨版本同形态源码任务探测

A 从同一仓库虚构 `fixtures/e-v050-w0/projects/legacy` 各复制一份到系统临时目录，填入虚构品牌、市场、SEO 关键词/竞品/Title 范围、博客前缀与 README 三用户段。Feed 指向各版本本地虚构 `fixtures/feeds/day1.xml`；仅对虚构站点 Sitemap/HTML 使用内存 `fetch` 回环。每个 Job 后重新读 `site.json` 与 README，对上述用户字段逐键比较。临时 probe 与输出未提交仓库；下表是实际运行结果，不能代表安装包 UI。

| Core 版本 | daily | weekly | monthly | readme | validate | 每步后用户字段 |
|---|---|---|---|---|---|---|
| v0.7.5 `c6ef611` | ok | partial | failed/7 | ok | failed/1 | 所选配置键与 README 三段均不变 |
| v0.7.6 `833784e` | ok | partial | failed/7 | ok | failed/1 | 所选配置键与 README 三段均不变 |
| 当前 Core（`e5971f7`；之后 #763/#764 未改 Core） | ok | partial | failed/7 | ok | failed/1 | 所选配置键与 README 三段均不变 |

复现命令为各版本隔离工作树中的 `pnpm exec vitest run packages/core/test/w0-upgrade-probe.test.ts --maxWorkers=1 --minWorkers=1`。首轮 v0.7.5 daily 因原夹具旧 SKU 与本地 feed 不同触发移除保护，虚构配置仅将 `max_removed_ratio` 设为 1 后，三版 daily 均成功。weekly 的 `links/product_details` 输入为空而返回 partial；monthly 未提供浏览器路径而返回 `BROWSER_UNAVAILABLE`；validate 因轻量夹具缺 `AGENTS.md`、`CLAUDE.md` 等文件而失败。因此**仅能确认已执行路径没有清空所选字段**；三版的 weekly/monthly/validate 完整成功路径与正式安装包覆盖升级仍未验证。

E 另以 v0.8.0 同源构建的 Windows 解包 `resources/cli.js`（源码与已发布 v0.8.0 tag 的 `packages/` 相同）在独立虚构副本上逐个独立进程执行任务。[执行记录](https://github.com/henryliuwork/SiteIndex/pull/753#issuecomment-7097641512)表明：首次 daily 因合成旧索引移除保护失败，在该副本加 `--force` 后 ok；weekly ok；monthly 首次缺浏览器路径失败，指定本机浏览器后 ok；readme ok；validate 首次因轻量副本缺文件与请求间隔不合 schema 失败，只修正副本条件后 ok。每次退出后重读的 SEO 两字段与 README 三用户段均保留，最终五类 runs 记录均为 ok。**该探测既非官方 Release EXE 安装，也未覆盖安装 v0.8.2**；旧草稿并发、正式 UI 和其他用户字段仍待验。

## 项目设置 · `site.json`

下表的 API `P` = `projects.updateConfig`；读回 `G` = `projects.get(id).config`。当前 UI 保存提交整份草稿，故各行仍暴露于 R4。D 用隔离虚构项目**完整 patch**一次提交，在磁盘、新 Core service 与返回值之间逐项深比较下表 44 个控件字段，得到 `CONFIG_FULL_PATCH_READBACK_OK fields=44`；该证据标为 `C44`，不证明局部 patch、dirty/revision 或正式 UI S/R/U。E 的 JSON 编辑合成证据标为 `J1`，两者细节见 [D 补证](https://github.com/henryliuwork/SiteIndex/pull/753#issuecomment-7097121009)与 [E 补证](https://github.com/henryliuwork/SiteIndex/pull/753#issuecomment-7096276776)。逐项 W0 的“通过”**只限括号内的合成读回路径**；R4 的 UI 旧草稿缺陷仍成立。

| 设置项 | 页面/控件 | API | 写入文件与键 → 读回 | 不变量与当前结论 | S/R/U | W0 合成结论（仅已测路径） | G8.2-3 终验 |
|---|---|---|---|---|---|---|---|
| 以 JSON 编辑整个配置 | 项目设置·JSON 草稿 | P | `site.json` 全部键 → G 与原文件 | I1：E 的隔离 Core 全量提交→新实例读回一致、其他 16 个顶层分区未变；UI mock 仅同会话提交。I2–I6 与安装版仍待验 | 待验/待验/待验 | 通过（J1：Core 读回；UI 仅同会话） | 待验 |
| 域名 | 基本·域名 | P | `site.json:domain` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 网站地址 | 基本·网站地址 | P | `base_url` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 平台 | 基本·平台 | P | `platform` → G | I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 币种 | 基本·币种 | P | `currency` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 语言 | 基本·语言 | P | `locale` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 时区 | 基本·时区 | P | `timezone` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 目标市场 | 基本·逗号列表 | P | `markets` → G | I2/I4：空列表与 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 品牌名 | 品牌·名称 | P | `brand.name` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 一句话定位 | 品牌·定位 | P | `brand.tagline` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 文案调性 | 品牌·调性 | P | `brand.voice` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 目标人群 | 品牌·人群 | P | `brand.audience` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 核心卖点 | 品牌·多行 | P | `brand.usp` → G | I2/I8：空列表及 R3 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| Feed 地址 | 数据源·多行 | P | `crawl.feed_url` → G | I2/I8：空列表及 R3；Core 另作 feed 兼容归一化 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| SKU 字段 | 数据源·字段 | P | `crawl.sku_field` → G | I2/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 主分类层级 | 数据源·数字 | P | `crawl.category_depth` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 商品消失时 | 数据源·选择 | P | `crawl.missing_as` → G | I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 移除保护阈值 | 数据源·数字 | P | `crawl.max_removed_ratio` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| Feed 生成时间 | 数据源·文本 | P | `crawl.feed_generated_at` → G | I2/I4：空文本及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 站点地图 | 数据源·单行文本框 | P | `sitemaps` → G | I2：当前每键 `fromLines` 回填；#761 不覆盖此控件，输入与清空待验 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 数据修正 | 数据源·JSON | P | `crawl.overrides` → G | I2–I4：保存时总从文本重解析；R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 请求间隔 | 抓取·数字 | P | `crawl.rate_limit_ms` → G | I2/I4：空输入会变 0；R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 每周最多页面 | 抓取·数字 | P | `crawl.max_pages` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 抓取产品页 | 抓取·勾选 | P | `crawl.crawl_product_pages` → G | I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 无 Feed 自动采集 | 抓取·勾选 | P | `crawl.auto_collect_products` → G | I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 排除 URL 规则 | 抓取·多行 | P | `crawl.exclude_url_patterns` → G | I2/I8：空列表及 R3 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 博客 Sitemap | 博客识别·多行 | P | `content.blog_sitemaps` → G | I2–I4/I8：整块 content/R3 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 博客 URL 规则 | 博客识别·多行 | P | `content.blog_url_patterns` → G | I2–I4/I8：整块 content/R3 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 父子 SKU 开关 | 父子 SKU·勾选 | P | `sku_grouping.enabled` → G | I3/I4：整块分组替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 父子 SKU 规则类型 | 父子 SKU·选择 | P | `sku_grouping.rule.type` → G | I3/I4：整块规则替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 父子 SKU 规则值 | 父子 SKU·文本 | P | `sku_grouping.rule.value` → G | I2–I4：空文本及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 关注分类 | 关注分类·列表/手动添加 | P | `categories.watched` → G | I2–I4：整块分类替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 核心关键词 | SEO·多行 | P | `seo.core_keywords` → G | R1/R3 旧版缺陷；#762/#761 已修 Core 与多行草稿，正式 UI 待验 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 竞品域名 | SEO·多行 | P | `seo.competitors` → G | R1 旧版缺陷；#762 Core 已修，正式 UI 待验 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| Title 长度范围 | SEO·数字对 | P | `seo.title_range` → G | R1 旧版缺陷；#762 Core 已修，正式 UI 待验 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| Description 长度范围 | SEO·数字对 | P | `seo.description_range` → G | I3/I4：R1 同一分区风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 邮件平台 | EDM·选择 | P | `edm.platform` → G | I3/I4：整块 EDM 替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 每封产品数 | EDM·数字 | P | `edm.max_products` → G | I2–I4：空输入及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 推荐冷却期 | EDM·数字 | P | `edm.cooldown_days` → G | I2–I4：空输入及 R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| UTM source | EDM·文本 | P | `edm.utm.source` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| UTM medium | EDM·文本 | P | `edm.utm.medium` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 图片优先级 | EDM·选择 | P | `edm.image_priority` → G | I3/I4：R4 风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| 默认受众 | EDM·文本 | P | `integrations.mailchimp.audience` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| LinkFlow MCP 服务 | 集成·文本 | P | `integrations.linkflow.mcp_server` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |
| LinkFlow 录入工具 | 集成·文本 | P | `integrations.linkflow.create_tool` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 | 通过（C44：全量 patch 的 Core 读回） | 待验 |

`site.json` 中还有由其他流程拥有、设置页不直接编辑的 `policies`、`crawl.stock_verify`、`crawl.stock_rules`、`crawl.allow_unpriced_products`、`crawl.max_removed_ratio` 以外的阈值、`edm.discount_tiers`、`edm.image_host`、`integrations.gsc`、`readme.disabled_blocks`、`workspace` 与 `schema_version`。这些键是 I6 的逐键保留断言对象；不能把“设置页没控件”解释为允许升级时删除。`workspace_folders` 是已废弃字段，按既有决策读取忽略、写回去掉，不列为用户拥有字段。

## 项目设置 · 独立保存入口

合成证据代号：`CAT` = D 的虚构分类 `categories.save` 后新 Core service 逐字段读回 `mode/url_pattern/manual.name/slug/url/match/watched`；`VAL` = D 的轻量虚构项目 `files.validate` 后新 service `files.lastReport` 与返回报告一致（项目故意缺业务文件，**不表示校验通过**）；`RUN` = E 的隔离 Desktop handler `runner.claim` 写文件、新 handler/Core service 读回设备一致；`README` = #752/#759 的 Core 回归。上述证据均不等于正式安装版 UI 退出重开。

| 设置项 | 页面/控件 | IPC/API | 写入文件与键 → 读回 | 不变量与当前结论 | S/R/U | W0 合成结论（仅已测路径） | G8.2-3 终验 |
|---|---|---|---|---|---|---|---|
| 分类模式 | 分类设置·选择 | `categories.save/get` | `site.json:categories.mode` → `categories.get` | I1：合成 Core 新实例读回通过；保存前读最新 watched，其余草稿陈旧风险待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 分类 URL 规则 | 分类设置·规则 | `categories.save/get` | `categories.url_pattern` → `categories.get` | I1：合成 Core 新实例读回通过；正式 UI 待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 手动分类名称 | 分类设置·表格 | `categories.save/get` | `categories.manual[].name` → `categories.get` | I1：合成 Core 新实例读回通过；正式 UI 待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 手动分类 slug | 分类设置·表格 | `categories.save/get` | `categories.manual[].slug` → `categories.get` | I1：合成 Core 新实例读回通过；正式 UI 待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 手动分类 URL | 分类设置·表格 | `categories.save/get` | `categories.manual[].url` → `categories.get` | I1：合成 Core 新实例读回通过；正式 UI 待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 手动分类匹配规则 | 分类设置·表格 | `categories.save/get` | `categories.manual[].match` → `categories.get` | I1：合成 Core 新实例读回通过；正式 UI 待验 | 待验/待验/待验 | 通过（CAT：分类字段 Core 读回） | 待验 |
| 每日计划 | 运行·计划弹窗 | `schedule.save/get` | `site.json:schedule.daily.enabled/time` → `schedule.get` | I1/I4/I6：两个字段均待逐项读回；全量草稿无 revision | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 校验计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.validate.enabled/time` → `schedule.get` | I1/I4/I6：两个字段均待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 每周计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.weekly.enabled/time/days` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| README 计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.readme.enabled/time/days` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 | 无法验证（计划字段未测） | 待验 |
| 每月计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.monthly.enabled/time/day_of_month` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 唤醒设备执行 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.wake_to_run` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 错过后补跑 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.run_if_missed` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 失败时通知 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.notify_on_failure` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 同步后校验 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.validate_after_sync` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 执行设备改为本机 | 运行·设备操作 | `runner.claim/get` | `index/.runner.json` → `runner.get` | I1：E 的隔离 Desktop handler 写文件、新 handler/Core 实例读回本机设备一致；mock `runner.get` 固定返回 false 是 mock 证据限制。安装版重启与系统任务仍待验 | 待验/待验/待验 | 通过（RUN：Desktop handler 读回） | 待验 |
| README 项目概况 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 项目概况` → `readme.get` | I7：#752 Core 合成回归通过，打包 UI 逐段读回待验 | 待验/待验/待验 | 通过（README：Core 回归与直接读回） | 待验 |
| README 当前重点 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 当前重点` → `readme.get` | R2 旧版缺陷；#752 已补标题，#759 Core 已报告缺段，B 页面提示和打包 UI 待验 | 待验/待验/待验 | 通过（README：Core 回归与直接读回） | 待验 |
| README 工作规则 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 工作规则与偏好` → `readme.get` | R5 旧版缺陷；#752 Core 已保留自动区块，打包 UI 待验 | 待验/待验/待验 | 通过（README：Core 回归与直接读回） | 待验 |
| 待办人工状态 | 待办·状态 | `todos.update/list` | 本地待办人工状态与历史 → `todos.list` | I1/I6：API 仅提交状态字段；文件级复验待 E | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 待办备注 | 待办·备注 | `todos.update/list` | 本地待办人工备注与历史 → `todos.list` | I1/I2/I6：`null` 为显式清空；文件级复验待 E | 待验/待验/待验 | 无法验证（W0 未做字段级读回） | 待验 |
| 文件校验报告（非设置） | 本地文件·校验 | `files.validate/lastReport` | 校验报告 → `files.lastReport` | I1：合成 Core 新实例读回同一报告；轻量项目不完整，未执行修复，正式 UI 待验 | 待验/待验/待验 | 通过（VAL：报告读回，非校验成功） | 待验 |
| GSC 项目属性 | 项目设置·GSC 卡片 | 当前无可编辑入口 | `integrations.gsc` → `projects.get` | 卡片仅显示“暂未开放”；I6 仍须保留已有键 | 不适用/待验/待验 | 无法验证（无编辑入口；升级未测） | 待验 |

## 应用设置 · `settings.json` 与本机状态

C 负责存储层与 IPC 的逐键 S/R/U 证据；B 负责 UI dirty 提交。下列 `settings.json` 项经 `settings.set/get`，其他本机凭据/系统任务另列。当前 main 已含 [#747](https://github.com/henryliuwork/SiteIndex/pull/747)：合成单测确认未知顶层/browser/notify 字段保留、有效文件无操作保存逐字节不变。C 的 [#751](https://github.com/henryliuwork/SiteIndex/pull/751) 在隔离 GitHub Windows 安装环境用官方 v0.8.0 包保存虚构应用设置、覆盖安装候选包、运行 `views`、经打包 IPC 逐键读回，Windows 安装检查和三系统 CI 全绿；`settings.json` 在安装、Job、读回后逐字节不变。候选包的应用版本仍是 0.8.0，最终 v0.8.2 安装包待 G8.2-3 验收。下表 S/R/U 中的“CI 合成安装包通过”仅指这条打包 IPC 路径，**不代表 UI 控件逐项验收或旧草稿并发保护**。空数组/null 只证明空值维持，不能证明有值保存或显式清空。

| 设置项 | 页面/控件 | IPC/API | 写入文件与键 → 读回 | 不变量与当前结论 | 合成 S/R/U | W0 结论（仅已测路径） | 最终安装版 |
|---|---|---|---|---|---|---|
| 项目根目录 | 软件设置·选择/文本 | `settings.set/get` | `settings.json:projects_root` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 设备名 | 软件设置·文本 | `settings.set/get` | `device_name` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 缓存目录 | 软件设置·文本 | `settings.set/get` | `cache_dir` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 关闭到托盘 | 软件设置·勾选 | `settings.set/get` | `close_to_tray` → `settings.get` | I1/I4–I6：打包 IPC 保存 false；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 开机启动 | 软件设置·勾选 | `settings.set/get` | `launch_at_login` → `settings.get` | I1/I4–I6：打包 IPC 保存 true；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 浏览器通道 | 软件设置·路径联动 | `settings.set/get` | `browser.channel` → `settings.get` | I1/I6：打包 IPC 非空值保留；I2–I4/ UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 浏览器路径 | 软件设置·文本 | `settings.set/get` | `browser.executable_path` → `settings.get` | I1/I6：仅测试 null 保留；非空/清空与 UI 待验 | 待验(仅 null)/待验/待验 | 无法验证（仅空值保留，未测非空保存） | 待验 |
| 失败通知 | 软件设置·勾选 | `settings.set/get` | `notify.on_failure` → `settings.get` | I1/I6：打包 IPC 保存 false；#744 旧草稿风险待修 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 成功通知 | 软件设置·勾选 | `settings.set/get` | `notify.on_success` → `settings.get` | I1/I6：打包 IPC 保存 true；#744 旧草稿风险待修 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 新缺货阈值 | 软件设置·勾选/数字 | `settings.set/get` | `notify.oos_threshold` → `settings.get` | I1/I6：打包 IPC 保存 7；显式清空/ UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 通知 Webhook | 软件设置·密码框 | `settings.set/get` | `notify.dingtalk_webhook` → `settings.get` | I1/I6：仅测试 null 保留；不记录地址，非空/清空待验 | 待验(仅 null)/待验/待验 | 无法验证（仅空值保留，未测非空保存） | 待验 |
| Agent 平台目录 | 软件设置·列表 | `settings.set/get` | `skill_platforms` → `settings.get` | I1/I6：打包 IPC 合成非空列表保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 单独添加的项目 | 项目中心·添加 | `settings.set/get` | `extra_projects` → `settings.get` | I1/I6：仅测试空列表；非空/删除待验 | 待验(仅空)/待验/待验 | 无法验证（仅空值保留，未测非空保存） | 待验 |
| 隐藏项目 | 项目中心·移除 | `settings.set/get` | `hidden_projects` → `settings.get` | I1/I6：仅测试空列表；非空/删除待验 | 待验(仅空)/待验/待验 | 无法验证（仅空值保留，未测非空保存） | 待验 |
| 冲突文件模式 | 当前无设置控件 | `settings.set/get` | `conflict_patterns` → `settings.get` | I6：打包 IPC 合成非空列表保留 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| 本机设备 ID | 内部生成 | `settings.get` | `device_id` → `settings.get` | I6：打包 IPC 保持原 ID | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 通过（#751：合成打包 IPC 读回） | 待验 |
| WordPress 凭据 | 软件设置·凭据卡片 | 独立凭据 API | 本机加密 vault → 凭据状态读回 | C 所有权；不得在矩阵/日志记录密钥 | 待 C/待 C/待 E | 无法验证（W0 未做此路径） | 待验 |
| 系统计划任务登记 | 定时任务页 | `schedule.save/verify` | `site.json:schedule` + 系统计划任务 → `schedule.get/verify` | C 核对注册路径与重启读回；项目配置归 A | 待 C/待 C/待 E | 无法验证（W0 未做此路径） | 待验 |

## 待补证与交付边界

### 横向不变量证据门槛

上表的 I1–I8 编号只表示该行**适用**哪些不变量，不表示已通过。W0 列已逐项写明“通过”及其证据范围，或“无法验证”及缺口；它不等于正式 UI 的 S/R/U。仍有计划字段、待办、GSC、部分应用设置及系统任务无法验证，故按 roadmap §5.2“每项通过/缺陷”的原标准，**G8.2-0 目前不能判通过**。本 PR 可先审矩阵与已知缺陷，最终安装版另在 G8.2-3 验收。

E 对 JSON 编辑与执行设备的[隔离合成补证](https://github.com/henryliuwork/SiteIndex/pull/753#issuecomment-7096276776)只支持上表记录的 Core/Desktop handler 路径。它没有运行正式安装包，也没有验证 UI 退出重开、并发、显式清空或系统任务注册，因此 S/R/U 仍留待验。

| 不变量 | 当前结果与证据缺口 |
|---|---|
| I1 写后读回 | #762 受保护 Core 写后重读，D 的 C44/CAT/VAL、E 的 J1/RUN 及 #747/#751 应用设置均有**对应合成路径**读回；正式 UI 保存、计划、待办与打包版仍待验。 |
| I2 空值保护 | #762 Core 受保护路径拒绝无 `clear` 的非空→空值覆盖，旧两参仍可清空；D dirty 提交和正式 UI 显式清空待验。#751 空值保持不证明显式清空。 |
| I3 深合并 | R1 是旧版缺陷；#762 Core 合成回归覆盖 `seo` 子字段，D 的 C44 是全量提交读回。其他分区的局部提交及 UI 接线待验。 |
| I4 陈旧写入 | R4 是旧 UI 草稿覆盖；#762 Core 的 revision 冲突/空 revision 拒绝有合成测试，D 携带 revision 和刷新提示仍待验。 |
| I5 空保存字节不变 | #762 受保护 Core 空保存、#747/#751 应用设置合成路径已验证；README、分类、计划的正式 UI 空保存待验。 |
| I6 升级及任务保留 | A 的 v0.7.5/v0.7.6/当前 Core 隔离副本：daily/readme 成功、weekly partial、monthly/validate 失败后所选字段保持；E 的 v0.8.0 同源解包 CLI 在定向修正测试条件后五类任务均成功，所选字段保持。正式安装包覆盖升级、旧版完整成功路径及更多用户字段待验。 |
| I7 README 用户段 | #752/#759 Core 合成回归均已三系统 CI 通过并合并，E 已复验 Core 直接路径；B 页面缺段提示与正式 UI 读回待验。 |
| I8 输入保真 | R3 是旧版缺陷；#761 已将 7 个多行字段改为原始草稿至失焦/保存。站点地图为单行且未覆盖，正式 UI 输入与重启读回待验。 |

1. D：项目设置 C44 仅是完整 patch 的 Core 证据；dirty/revision 的真实 UI 提交、关键词与站点地图输入、README 缺段提示继续按各自 PR 验证。
2. C：#747/#751/#758 已提供应用设置的合成与打包 IPC 证据；空值显式清空、旧草稿并发及正式 v0.8.2 安装版仍待验，`revision` 不落盘。
3. E：已核对 J1/RUN 等合成路径；“升级后变空”在现有有限路径**未复现**。G8.2-3 仍须用各自可恢复的虚构副本完成 v0.8.0、v0.7.5、v0.7.6 与本版安装包的逐项 S/R/U，运行 daily/weekly/monthly 后对用户字段逐键比较；待验格不得提前改成通过。
4. A：#762 受保护 Core 保存、#752/#759 README Core 修复均已合并；A-2 升级 fixture 与更多任务路径回归仍待独立 PR。#745 已关闭；[#743](https://github.com/henryliuwork/SiteIndex/issues/743) 的 UI/安装版交叉验证仍待完成。

本矩阵已列出 roadmap §5.2 封闭范围的写入与读回入口，区分 `C44/J1/CAT/VAL/RUN/README` 合成 Core、#751 CI 合成安装包 IPC 与 G8.2-3 正式安装版证据。G8.2-0 可据此审核“范围与已知状态”，**不表示** G8.2-3 逐项验收通过。
