# 工作流 A · Core + CLI

**负责目录**：`packages/core/`、`packages/cli/`、`schemas/`、`fixtures/`、`reference/`
**必读**：`docs/DATA_SPEC.md`（全文）、`docs/ARCHITECTURE.md` §6–§10、`fixtures/README.md`、`reference/scripts/`（Python 参考实现，行为以它为准；1.1 新增部分以 DATA_SPEC 为准）
**原则**：纯 Node（≥ 20），不 import electron；所有输出与参考实现**逐字节一致**；所有路径来自 `@siteindex/shared` 的 `PATHS`。

建议依赖：`fast-xml-parser`（feed/sitemap）、`htmlparser2` + `css-select`（页面解析）、`ajv`（schema 校验）、`undici`/内置 fetch（抓取）、`p-limit`、`playwright-core`（仅 design/index-check，M3）、`tsup`（打包 cli.js）。

---

## M1 · 基础与每日同步

### A1 文件基础 `core/src/io/`
- [x] `atomicWrite(path, data)`：同目录临时文件 → fsync → rename；Windows `EPERM/EBUSY` 重试 10 次（200ms 递增）
- [x] JSONL 读写：按主键排序（`compareKeys`，不用 localeCompare）、键顺序固定、末尾换行，与参考实现逐字节一致
- [x] CSV 读写：表头来自 `CSV_HEADERS`，引号规则与 Python `csv` 模块一致
- [x] `index/.lock`：`wx` 创建、30 秒心跳、10 分钟僵尸锁回收；`withLock(project, fn)`
- [x] `.runner.json` 读写；`assertRunner(project, deviceId, trigger)`（定时模式下非执行设备 → 退出码 5）
- [x] 云盘冲突副本检测（`DEFAULT_CONFLICT_PATTERNS`）
- **验收**：单测覆盖并发写同一文件、锁超时、冲突副本识别

### A2 feed 解析 `core/src/crawl/gmc-feed.ts`
- [x] XML（RSS/Atom，g: 命名空间）与 TSV（表头带空格）
- [x] 变体归组、sale_price 有效期、availability 映射（backorder→preorder，非标准→unknown）、重复 id、缺价格、URL 去跟踪参数、overrides
- **验收**：`fixtures/feeds/day1–4` 的解析结果等于 `fixtures/expected/snapshots/dayN.jsonl`

### A3 每日同步 `core/src/jobs/daily.ts`
- [x] 合并：首次基线、事件（restock/oos/price/new/removed）、`missing_as`、保护阈值（退出码 3，数据不变，runs 记 failed）
- [x] `daily_summary.csv`、日报 Markdown、`logs/runs.jsonl`
- [x] 分类计算：`categories.mode` = `url_rule` / `feed` / `manual`（DATA_SPEC §4.1），写入 `category` 与 `category_source`
- **验收**：黄金测试——依次跑 day1–4，每步与 `fixtures/expected/steps/dayN/` 一致，退出码一致（固定"今天"与时区见 fixtures/README）

## M2 · 全部 Job、查询服务与命令行

### A4 视图 `core/src/views/`
- [x] `views/products.jsonl`：**图片规则 feed 优先 → 手动（`ledgers/sku_media.csv`）→ none**，写 `image_source`/`feed_image_url`/`manual_image_url`
- [x] `views/sku_stock.jsonl`：在线率、`history_30d`（字符 i/o/p/u/-）
- **验收**：products 与 `fixtures/expected/project/index/views/products.jsonl` 一致（该黄金文件已按 feed 优先重新生成；fixtures 中只有 feed 图场景，manual 与 none 场景自行补单测）；sku_stock 补单测

### A5 每周同步 `core/src/jobs/weekly.ts`
- [x] sitemap index 展开、限速抓取（默认 1 req/s，可配置）
- [x] `seo/pages.jsonl`、`seo/issues.jsonl`（DATA_SPEC §5.8 规则表，长度规则用 shared/seo.ts 的 grade 函数）、`seo/links.jsonl`（排除导航/页脚）
- [x] `content/blog_index.jsonl`（日期来源、作者、404 处理）
- [x] `catalog/product_details.jsonl`、`catalog/categories.json`（url_rule 模式识别分类页）
- [x] `--only <step>`：只跑某一步（用于校验页"重新生成"）
- **验收**：用 http 服务托管 `fixtures/www/` 后结果与 `expected/project/` 一致；1.1 新表补单测

### A6 校验与修复 `core/src/validate/`
- [x] 按 DATA_SPEC §6 规则产出 `logs/validation.json`（`ValidationReport`）
- [x] 修复映射：`regenerate:{job}.{step}`、`autofix`（排序/去重/换行）、`restore_archive`、`delete_copy`
- [x] ajv 校验用 `schemas/`；补齐 1.1 新 schema（seo_page、seo_issue、seo_link、product_details、sku_stock、validation，并更新 site/category/sku_media/sku_tags/edm_campaign）
- **验收**：`fixtures/invalid/*` 退出码一致、每条期望错误都有对应项；人为损坏 links.jsonl → repair → 恢复

### A7 README、台账、分类、文件夹
- [x] README 区块解析/替换（`<!-- siteindex:auto:{id} -->`），6 个自动区块 + 用户区块保留
- [x] 台账 upsert/delete（keywords、sku_media、sku_tags、edm_campaigns、outreach），含规范化（大小写、www）
- [x] categories preview/apply（返回 `CategoryPreview`）
- [x] folders：create/describe（写 `_about.md`、`site.json.workspace_folders`，刷新 README folder-map），默认文件夹不可删（删除保护由 Desktop C 实现）
- [x] EDM 渲染（`edm render`，缺货跳过，`--allow-oos`）
- [x] 新建项目：`detect(url)`、`inspectFeed`、`createProject`（复制 `templates/project`、写 site.json、_about.md、首次 daily）

### A8 查询服务 `core/src/service/`
- [x] `createCoreService(ctx: { resolveProject(id): string; deviceId: string; cacheDir: string })` 覆盖 WORKSTREAMS §2 分配给 core 的项目、概览、库存、产品、SEO、内容、EDM、设计、README、分类、文件夹、文件、计划与执行设备方法；桌面专属方法留给 C
- [x] 已实现方法使用统一分页/排序/筛选/搜索和内存缓存；暴露 `invalidate(projectPath)` 供 C 在文件变化时调用
- [x] `projects.detect`、`inspectFeed`、`create`；新建项目复制模板、写配置与工作区、触发首次 daily
- [x] `runJob(req: JobRequest, report: ProgressReporter): Promise<JobResult>` —— 统一入口、执行前检查、锁、runs.jsonl；daily、views、readme、weekly、monthly、validate、design、index-check 已接入
- [x] monthly、design、index-check 等 Job 在对应模块完成后接入统一入口
- **首批验收已通过**：用 `fixtures/expected/project` 覆盖 projects/inventory/products 查询与台账写入；1 万 SKU 合成数据下热缓存列表查询 < 50ms

### A9 命令行 `packages/cli/`
- [x] ARCHITECTURE §6 全部命令；`--json` 输出 `CliJsonOutput`；退出码用 `EXIT`
- [x] `tsup` 打包为单文件 `packages/cli/dist/cli.js`（C 把它放进 `resources/`）
- [x] `schedule list` 读 site.json；`schedule install/remove` 在命令行中只更新 site.json 并提示"打开 SiteIndex 软件后自动注册到系统"（系统注册只在 desktop 实现，避免 core 依赖操作系统）
- **验收**：每个命令有测试（用 fixtures 项目）；`node dist/cli.js query <p> products --json` 可用

## M3 · 浏览器相关与性能

### A10 design 与 index-check
- [x] 使用 `playwright-core`，`executablePath` 由调用方传入（C 负责检测系统 Edge/Chrome）；没有浏览器 → 退出码 7
- [x] design：首页/分类页/产品页（1440、390 宽）→ `design/tokens.json`、`brand.md`、截图
- [x] index-check：ARCHITECTURE §10.1（间隔 20–40 秒随机、单次 ≤ 50、遇验证码停止，剩余标未检查）
### A11 性能
- [x] 合成 1 万 SKU feed：daily（不含下载）< 30 秒；写 benchmark 脚本 `pnpm --filter @siteindex/core bench`

### 2026-10-27 · 数据索引聚焦（#113）
- [x] 新建项目不创建工作区文件夹、`_about.md` 或 `site.json.workspace_folders`；旧项目的文件和说明原样保留
- [x] README 停止生成 `folder-map`；旧标记内容保留，校验忽略该废弃区块
- [x] core 停止读取工作区文件夹；旧配置字段读取忽略、配置写回去掉；CLI 移除 folders 命令
- [x] 安装包中的 CLI 可从 `resources/app.asar.unpacked/node_modules` 载入 `playwright-core`

## 交付给其他工作流
- 给 B：无直接依赖（B 用 mock）。但请在 M2 前把 `fixtures/expected/project` 保持最新，B 的 mock 数据从这里生成
- 给 C：`createCoreService`、`runJob`、`dist/cli.js`；每次改动签名先走契约流程
