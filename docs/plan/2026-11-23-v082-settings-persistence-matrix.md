# v0.8.2 设置保存审计矩阵（W0）

> 基线：最初从 `origin/main` `7c44825` 取证，文档分支已变基至包含 #752 的当前 main。只用 `synthetic-shop.test` 虚构项目的临时副本取证。`S/R/U` 分别表示保存后读回、新建 service 或重启后读回、从 v0.8.0 覆盖升级后读回。`待验`不等于通过；D/E/C 的端到端证据到齐后逐行定案。
>
> 本矩阵按 roadmap §5.2 的封闭范围列设置项。项目配置写入共用 `projects.updateConfig` → `site.json` → `projects.get`；应用配置由 C 的 `settings.set/get` → `settings.json`；分类、计划、README、待办、GSC 的独立 API 单列。

## 已确认的复现与公共风险

| 编号 | 复现步骤与结果 | 归属 |
|---|---|---|
| R1 | 合成项目先有 `seo.core_keywords=["bird feeder"]`、`seo.competitors=["competitor.example.test"]`、`seo.title_range=[30,60]`；调用 `projects.updateConfig(id,{seo:{core_keywords:["new keyword"]}})` 后重读文件，`competitors` 与 `title_range` 消失。`service/index.ts:2190-2195` 顶层替换分区。 | [#743](https://github.com/henryliuwork/SiteIndex/issues/743)，D 类 |
| R2 | 旧版合成复现：README 缺 `## 当前重点` 时提交 `focus="Focus text"`，保存返回成功，重读仍无内容。#752 已修 Core 补标题并通过三系统 CI；打包 UI 保存与缺段提示仍待验。 | [#745](https://github.com/henryliuwork/SiteIndex/issues/745)，D 类 |
| R3 | D 在隔离 mock 页输入 `DEMO KEYWORD `，文本框立即回显为 `DEMO KEYWORD`；`fromLines` 每键 trim/filter 后回填，尾部空格与回车中的空行无法暂存。 | [#743 评论](https://github.com/henryliuwork/SiteIndex/issues/743)，D-4 输入保真 |
| R4 | D 在隔离 mock 页先加载旧草稿，再通过另一次调用更新 `brand.tagline`，只在页面改品牌名后保存；提交的 16 个顶层字段仍含旧 tagline，读回也回退为旧值。 | [#743 评论](https://github.com/henryliuwork/SiteIndex/issues/743)，D 类 |
| R5 | 旧版合成复现：README 模板初始含 5 个自动区块标记；保存工作规则后标记从 5 个变为 0 个。#752 已修 Core 读写边界并通过三系统 CI；打包 UI 待验。 | [#745 评论](https://github.com/henryliuwork/SiteIndex/issues/745#issuecomment-7094778905)，D 类 |

当前 `updateConfig` 没有写后重读比对、revision、显式 `clear` 或空 patch 字节不变判定。C 已在 [#747](https://github.com/henryliuwork/SiteIndex/pull/747) 修复 `settings.json` 未知字段丢失与无操作重写，通知旧草稿风险由 #744 跟进。受影响的真实项目写入暂停；A 的复现只写系统临时目录。#752 的修复已合并，#745 仍等待缺段标记、B 页面提示和 E 直接路径复验；不能以 Core 单测关闭问题。

### 升级路径的已验证范围

`v0.8.0` 标签中的 `fixtures/e-v050-w0/projects/legacy/index/site.json` 与 `templates/project/README.md` 曾和取证时 main 的对应文件 Git blob 相同。A 将其复制到系统临时目录，填入虚构 SEO 关键词、竞品域名、长度范围和博客识别配置，再由当时 Core 新建 service 加载并运行 `views`、`validate`、`readme`。加载与三个任务后，`site.json` 中这些用户字段逐键保留；`views` 和 `readme` 返回 `ok`，`validate` 因该轻量 fixture 缺校验所需文件返回 `failed`，但仍未改写上述字段。模板的三个用户段正文在 `readme` Job 后仍在；读回“工作规则”在 Job 前误含自动标记，见 R5（#752 已修）。

这只能证明**旧版文件经当前 Core 的上述路径**的行为。尚未完成 v0.8.0 安装包覆盖升级、v0.7.5/v0.7.6 顺序打开，以及 daily/weekly/monthly 的成功任务路径；“升级后变空”的准确步骤目前**未复现**，U 列仍为待验。

## 项目设置 · `site.json`

下表的 API `P` = `projects.updateConfig`；读回 `G` = `projects.get(id).config`。当前 UI 保存提交整份草稿，故各行均暴露于 R4；`S/R/U` 的逐项实测由 D/E 补证，不能用源码推断为通过。

| 设置项 | 页面/控件 | API | 写入文件与键 → 读回 | 不变量与当前结论 | S/R/U |
|---|---|---|---|---|---|
| 以 JSON 编辑整个配置 | 项目设置·JSON 草稿 | P | `site.json` 全部键 → G 与原文件 | I1–I6：整对象替换可删除未知/用户字段；须分别验证提交、无操作保存、显式清空和逐键读回 | 待验/待验/待验 |
| 域名 | 基本·域名 | P | `site.json:domain` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 网站地址 | 基本·网站地址 | P | `base_url` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 平台 | 基本·平台 | P | `platform` → G | I4：R4 风险 | 待验/待验/待验 |
| 币种 | 基本·币种 | P | `currency` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 语言 | 基本·语言 | P | `locale` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 时区 | 基本·时区 | P | `timezone` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 目标市场 | 基本·逗号列表 | P | `markets` → G | I2/I4：空列表与 R4 风险 | 待验/待验/待验 |
| 品牌名 | 品牌·名称 | P | `brand.name` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 |
| 一句话定位 | 品牌·定位 | P | `brand.tagline` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 |
| 文案调性 | 品牌·调性 | P | `brand.voice` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 |
| 目标人群 | 品牌·人群 | P | `brand.audience` → G | I2–I4：整块品牌替换风险 | 待验/待验/待验 |
| 核心卖点 | 品牌·多行 | P | `brand.usp` → G | I2/I8：空列表及 R3 | 待验/待验/待验 |
| Feed 地址 | 数据源·多行 | P | `crawl.feed_url` → G | I2/I8：空列表及 R3；Core 另作 feed 兼容归一化 | 待验/待验/待验 |
| SKU 字段 | 数据源·字段 | P | `crawl.sku_field` → G | I2/I4：R4 风险 | 待验/待验/待验 |
| 主分类层级 | 数据源·数字 | P | `crawl.category_depth` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 |
| 商品消失时 | 数据源·选择 | P | `crawl.missing_as` → G | I4：R4 风险 | 待验/待验/待验 |
| 移除保护阈值 | 数据源·数字 | P | `crawl.max_removed_ratio` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 |
| Feed 生成时间 | 数据源·文本 | P | `crawl.feed_generated_at` → G | I2/I4：空文本及 R4 风险 | 待验/待验/待验 |
| 站点地图 | 数据源·多行 | P | `sitemaps` → G | I2/I8：空列表及 R3 | 待验/待验/待验 |
| 数据修正 | 数据源·JSON | P | `crawl.overrides` → G | I2–I4：保存时总从文本重解析；R4 风险 | 待验/待验/待验 |
| 请求间隔 | 抓取·数字 | P | `crawl.rate_limit_ms` → G | I2/I4：空输入会变 0；R4 风险 | 待验/待验/待验 |
| 每周最多页面 | 抓取·数字 | P | `crawl.max_pages` → G | I2/I4：空输入及 R4 风险 | 待验/待验/待验 |
| 抓取产品页 | 抓取·勾选 | P | `crawl.crawl_product_pages` → G | I4：R4 风险 | 待验/待验/待验 |
| 无 Feed 自动采集 | 抓取·勾选 | P | `crawl.auto_collect_products` → G | I4：R4 风险 | 待验/待验/待验 |
| 排除 URL 规则 | 抓取·多行 | P | `crawl.exclude_url_patterns` → G | I2/I8：空列表及 R3 | 待验/待验/待验 |
| 博客 Sitemap | 博客识别·多行 | P | `content.blog_sitemaps` → G | I2–I4/I8：整块 content/R3 风险 | 待验/待验/待验 |
| 博客 URL 规则 | 博客识别·多行 | P | `content.blog_url_patterns` → G | I2–I4/I8：整块 content/R3 风险 | 待验/待验/待验 |
| 父子 SKU 开关 | 父子 SKU·勾选 | P | `sku_grouping.enabled` → G | I3/I4：整块分组替换风险 | 待验/待验/待验 |
| 父子 SKU 规则类型 | 父子 SKU·选择 | P | `sku_grouping.rule.type` → G | I3/I4：整块规则替换风险 | 待验/待验/待验 |
| 父子 SKU 规则值 | 父子 SKU·文本 | P | `sku_grouping.rule.value` → G | I2–I4：空文本及 R4 风险 | 待验/待验/待验 |
| 关注分类 | 关注分类·列表/手动添加 | P | `categories.watched` → G | I2–I4：整块分类替换风险 | 待验/待验/待验 |
| 核心关键词 | SEO·多行 | P | `seo.core_keywords` → G | **缺陷 R1/R3**：分区丢字段及输入保真 | 缺陷/待验/待验 |
| 竞品域名 | SEO·多行 | P | `seo.competitors` → G | **缺陷 R1**：局部 SEO patch 后消失；R3 输入风险 | 缺陷/待验/待验 |
| Title 长度范围 | SEO·数字对 | P | `seo.title_range` → G | **缺陷 R1**：局部 SEO patch 后消失 | 缺陷/待验/待验 |
| Description 长度范围 | SEO·数字对 | P | `seo.description_range` → G | I3/I4：R1 同一分区风险 | 待验/待验/待验 |
| 邮件平台 | EDM·选择 | P | `edm.platform` → G | I3/I4：整块 EDM 替换风险 | 待验/待验/待验 |
| 每封产品数 | EDM·数字 | P | `edm.max_products` → G | I2–I4：空输入及 R4 风险 | 待验/待验/待验 |
| 推荐冷却期 | EDM·数字 | P | `edm.cooldown_days` → G | I2–I4：空输入及 R4 风险 | 待验/待验/待验 |
| UTM source | EDM·文本 | P | `edm.utm.source` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 |
| UTM medium | EDM·文本 | P | `edm.utm.medium` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 |
| 图片优先级 | EDM·选择 | P | `edm.image_priority` → G | I3/I4：R4 风险 | 待验/待验/待验 |
| 默认受众 | EDM·文本 | P | `integrations.mailchimp.audience` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 |
| LinkFlow MCP 服务 | 集成·文本 | P | `integrations.linkflow.mcp_server` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 |
| LinkFlow 录入工具 | 集成·文本 | P | `integrations.linkflow.create_tool` → G | I2–I4：嵌套对象替换风险 | 待验/待验/待验 |

`site.json` 中还有由其他流程拥有、设置页不直接编辑的 `policies`、`crawl.stock_verify`、`crawl.stock_rules`、`crawl.allow_unpriced_products`、`crawl.max_removed_ratio` 以外的阈值、`edm.discount_tiers`、`edm.image_host`、`integrations.gsc`、`readme.disabled_blocks`、`workspace` 与 `schema_version`。这些键是 I6 的逐键保留断言对象；不能把“设置页没控件”解释为允许升级时删除。`workspace_folders` 是已废弃字段，按既有决策读取忽略、写回去掉，不列为用户拥有字段。

## 项目设置 · 独立保存入口

| 设置项 | 页面/控件 | IPC/API | 写入文件与键 → 读回 | 不变量与当前结论 | S/R/U |
|---|---|---|---|---|---|
| 分类模式 | 分类设置·选择 | `categories.save/get` | `site.json:categories.mode` → `categories.get` | I1/I4/I6：保存前读最新 watched，其余草稿陈旧风险待验 | 待验/待验/待验 |
| 分类 URL 规则 | 分类设置·规则 | `categories.save/get` | `categories.url_pattern` → `categories.get` | I1/I4/I6：同上 | 待验/待验/待验 |
| 手动分类名称 | 分类设置·表格 | `categories.save/get` | `categories.manual[].name` → `categories.get` | I1/I4/I6：逐项读回待验 | 待验/待验/待验 |
| 手动分类 slug | 分类设置·表格 | `categories.save/get` | `categories.manual[].slug` → `categories.get` | I1/I4/I6：逐项读回待验 | 待验/待验/待验 |
| 手动分类 URL | 分类设置·表格 | `categories.save/get` | `categories.manual[].url` → `categories.get` | I1/I4/I6：逐项读回待验 | 待验/待验/待验 |
| 手动分类匹配规则 | 分类设置·表格 | `categories.save/get` | `categories.manual[].match` → `categories.get` | I1/I4/I6：逐项读回待验 | 待验/待验/待验 |
| 每日计划 | 运行·计划弹窗 | `schedule.save/get` | `site.json:schedule.daily.enabled/time` → `schedule.get` | I1/I4/I6：两个字段均待逐项读回；全量草稿无 revision | 待验/待验/待验 |
| 校验计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.validate.enabled/time` → `schedule.get` | I1/I4/I6：两个字段均待逐项读回 | 待验/待验/待验 |
| 每周计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.weekly.enabled/time/days` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 |
| README 计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.readme.enabled/time/days` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 |
| 每月计划 | 运行·计划弹窗 | `schedule.save/get` | `schedule.monthly.enabled/time/day_of_month` → `schedule.get` | I1/I4/I6：三个字段均待逐项读回 | 待验/待验/待验 |
| 唤醒设备执行 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.wake_to_run` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 |
| 错过后补跑 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.run_if_missed` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 |
| 失败时通知 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.notify_on_failure` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 |
| 同步后校验 | 运行·高级勾选 | `schedule.save/get` | `schedule.options.validate_after_sync` → `schedule.get` | I1/I4/I6：待逐项读回 | 待验/待验/待验 |
| 执行设备改为本机 | 运行·设备操作 | `runner.claim/get` | `index/.runner.json` → `runner.get` | I1/I6：独立于计划保存与系统任务登记；重启读回待验 | 待验/待验/待验 |
| README 项目概况 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 项目概况` → `readme.get` | I7：#752 Core 合成回归通过，打包 UI 逐段读回待验 | 待验/待验/待验 |
| README 当前重点 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 当前重点` → `readme.get` | R2 旧版缺陷；#752 Core 已补标题，缺段提示和打包 UI 待验 | 待验/待验/待验 |
| README 工作规则 | README·用户段 | `readme.saveUserBlocks/get` | `README.md:## 工作规则与偏好` → `readme.get` | R5 旧版缺陷；#752 Core 已保留自动区块，打包 UI 待验 | 待验/待验/待验 |
| 待办人工状态 | 待办·状态 | `todos.update/list` | 本地待办人工状态与历史 → `todos.list` | I1/I6：API 仅提交状态字段；文件级复验待 E | 待验/待验/待验 |
| 待办备注 | 待办·备注 | `todos.update/list` | 本地待办人工备注与历史 → `todos.list` | I1/I2/I6：`null` 为显式清空；文件级复验待 E | 待验/待验/待验 |
| GSC 项目属性 | 项目设置·GSC 卡片 | 当前无可编辑入口 | `integrations.gsc` → `projects.get` | 卡片仅显示“暂未开放”；I6 仍须保留已有键 | 不适用/待验/待验 |

## 应用设置 · `settings.json` 与本机状态

C 负责存储层与 IPC 的逐键 S/R/U 证据；B 负责 UI dirty 提交。下列 `settings.json` 项经 `settings.set/get`，其他本机凭据/系统任务另列。当前 main 已含 [#747](https://github.com/henryliuwork/SiteIndex/pull/747)：合成单测确认未知顶层/browser/notify 字段保留、有效文件无操作保存逐字节不变。C 的 [#751](https://github.com/henryliuwork/SiteIndex/pull/751) 在隔离 GitHub Windows 安装环境用官方 v0.8.0 包保存虚构应用设置、覆盖安装候选包、运行 `views`、经打包 IPC 逐键读回，Windows 安装检查和三系统 CI 全绿；`settings.json` 在安装、Job、读回后逐字节不变。候选包的应用版本仍是 0.8.0，最终 v0.8.2 安装包待 G8.2-3 验收。下表 S/R/U 中的“CI 合成安装包通过”仅指这条打包 IPC 路径，**不代表 UI 控件逐项验收或旧草稿并发保护**。空数组/null 只证明空值维持，不能证明有值保存或显式清空。

| 设置项 | 页面/控件 | IPC/API | 写入文件与键 → 读回 | 不变量与当前结论 | S/R/U | 最终安装版 |
|---|---|---|---|---|---|---|
| 项目根目录 | 软件设置·选择/文本 | `settings.set/get` | `settings.json:projects_root` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 设备名 | 软件设置·文本 | `settings.set/get` | `device_name` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 缓存目录 | 软件设置·文本 | `settings.set/get` | `cache_dir` → `settings.get` | I1/I4–I6：打包 IPC 非空值保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 关闭到托盘 | 软件设置·勾选 | `settings.set/get` | `close_to_tray` → `settings.get` | I1/I4–I6：打包 IPC 保存 false；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 开机启动 | 软件设置·勾选 | `settings.set/get` | `launch_at_login` → `settings.get` | I1/I4–I6：打包 IPC 保存 true；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 浏览器通道 | 软件设置·路径联动 | `settings.set/get` | `browser.channel` → `settings.get` | I1/I6：打包 IPC 非空值保留；I2–I4/ UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 浏览器路径 | 软件设置·文本 | `settings.set/get` | `browser.executable_path` → `settings.get` | I1/I6：仅测试 null 保留；非空/清空与 UI 待验 | 待验(仅 null)/待验/待验 | 待验 |
| 失败通知 | 软件设置·勾选 | `settings.set/get` | `notify.on_failure` → `settings.get` | I1/I6：打包 IPC 保存 false；#744 旧草稿风险待修 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 成功通知 | 软件设置·勾选 | `settings.set/get` | `notify.on_success` → `settings.get` | I1/I6：打包 IPC 保存 true；#744 旧草稿风险待修 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 新缺货阈值 | 软件设置·勾选/数字 | `settings.set/get` | `notify.oos_threshold` → `settings.get` | I1/I6：打包 IPC 保存 7；显式清空/ UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 通知 Webhook | 软件设置·密码框 | `settings.set/get` | `notify.dingtalk_webhook` → `settings.get` | I1/I6：仅测试 null 保留；不记录地址，非空/清空待验 | 待验(仅 null)/待验/待验 | 待验 |
| Agent 平台目录 | 软件设置·列表 | `settings.set/get` | `skill_platforms` → `settings.get` | I1/I6：打包 IPC 合成非空列表保留；UI 待验 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 单独添加的项目 | 项目中心·添加 | `settings.set/get` | `extra_projects` → `settings.get` | I1/I6：仅测试空列表；非空/删除待验 | 待验(仅空)/待验/待验 | 待验 |
| 隐藏项目 | 项目中心·移除 | `settings.set/get` | `hidden_projects` → `settings.get` | I1/I6：仅测试空列表；非空/删除待验 | 待验(仅空)/待验/待验 | 待验 |
| 冲突文件模式 | 当前无设置控件 | `settings.set/get` | `conflict_patterns` → `settings.get` | I6：打包 IPC 合成非空列表保留 | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| 本机设备 ID | 内部生成 | `settings.get` | `device_id` → `settings.get` | I6：打包 IPC 保持原 ID | CI 合成安装包通过/CI 合成安装包通过/CI 合成安装包通过 | 待验 |
| WordPress 凭据 | 软件设置·凭据卡片 | 独立凭据 API | 本机加密 vault → 凭据状态读回 | C 所有权；不得在矩阵/日志记录密钥 | 待 C/待 C/待 E | 待验 |
| 系统计划任务登记 | 定时任务页 | `schedule.save/verify` | `site.json:schedule` + 系统计划任务 → `schedule.get/verify` | C 核对注册路径与重启读回；项目配置归 A | 待 C/待 C/待 E | 待验 |

## 待补证与交付边界

### 横向不变量证据门槛

上表的 I1–I8 编号只表示该行**适用**哪些不变量，不表示已通过。逐项结论仍须有对应 S/R/U 和最终安装版证据；当前门槛如下。

| 不变量 | 当前结果与证据缺口 |
|---|---|
| I1 写后读回 | #747/#751 仅覆盖应用设置的合成 IPC 路径；项目设置、分类、计划、README、待办的打包 UI 保存与读回待验。 |
| I2 空值保护 | 非空值、空数组/null、显式 `clear` 必须分别验；#751 的空值保持不证明显式清空。项目级待 #743 Core 与 D dirty 提交。 |
| I3 深合并 | R1 已证明旧 Core 的 `seo` 局部 patch 丢字段；其他分区与 JSON 全量编辑待逐项复验。 |
| I4 陈旧写入 | R4 已证明旧 UI 草稿覆盖；`revision` 冲突提示与刷新后的不丢字段待验。 |
| I5 空保存字节不变 | #747 合成测试和 #751 应用设置文件证据已覆盖一条路径；项目 `site.json`、README、分类和计划待验。 |
| I6 升级及任务保留 | A 的旧文件→当前 Core `views/readme` 合成路径只证明有限字段；v0.8.0、v0.7.5、v0.7.6 应各用独立可恢复副本，安装包覆盖及 daily/weekly/monthly 成功路径待验。 |
| I7 README 用户段 | #752 Core 合成回归已通过；缺段标记 Core PR #759 待 CI，B 页面提示及 E 直接路径读回待验。 |
| I8 输入保真 | R3 旧 UI 输入空格/回车丢失已复现；D 的原始草稿、保存解析及重启读回待验。 |

1. D：把项目设置全部控件的 dirty 提交路径、关键词输入组件复现、README 缺段提示补入本矩阵；不把源码风险冒充已完成 UI 验收。
2. C：按 C-1 提交 `settings.json` 逐键保存→新实例读回与升级脚本证据；`revision` 只作为 IPC 元数据，不落盘。
3. E：在隔离合成项目上按 roadmap §5.3 对 v0.8.0、v0.7.5、v0.7.6、当前 main 顺序复验，并给出升级后变空的准确步骤，或明确“未复现”。待证据齐全后逐行把 `待验` 改为“通过”或“缺陷”，再将矩阵标记完成。
4. A：contract 仅加可选字段/参数；旧两参语义保持。A-1 的受保护保存路径与 A-2 的 README、升级 fixture 分别进独立 PR；[#743](https://github.com/henryliuwork/SiteIndex/issues/743) 与 [#745](https://github.com/henryliuwork/SiteIndex/issues/745) 各按已归类 D 类的 ≤200 行修复门槛执行，不夹带其他缺陷。

Core 的 [#752](https://github.com/henryliuwork/SiteIndex/pull/752) 已在三系统 CI 通过后合并，覆盖缺标题补写、用户段/自动区块隔离与 refresh 回归；[#759](https://github.com/henryliuwork/SiteIndex/pull/759) 提交缺段标记 Core 实现，仍待三系统 CI 和审核。二者均不代替 B 的 UI 缺段提示或 E 的安装版直接路径复验。
