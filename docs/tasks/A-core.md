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
- [ ] 合并：首次基线、事件（restock/oos/price/new/removed）、`missing_as`、保护阈值（退出码 3，数据不变，runs 记 failed）
- [ ] `daily_summary.csv`、日报 Markdown、`logs/runs.jsonl`
- [ ] 分类计算：`categories.mode` = `url_rule` / `feed` / `manual`（DATA_SPEC §4.1），写入 `category` 与 `category_source`
- **验收**：黄金测试——依次跑 day1–4，每步与 `fixtures/expected/steps/dayN/` 一致，退出码一致（固定"今天"与时区见 fixtures/README）

## M2 · 全部 Job、查询服务与命令行

### A4 视图 `core/src/views/`
- [ ] `views/products.jsonl`：**图片规则 feed 优先 → 手动（`ledgers/sku_media.csv`）→ none**，写 `image_source`/`feed_image_url`/`manual_image_url`
- [ ] `views/sku_stock.jsonl`：在线率、`history_30d`（字符 i/o/p/u/-）
- **验收**：products 与 `fixtures/expected/project/index/views/products.jsonl` 一致（该黄金文件已按 feed 优先重新生成；fixtures 中只有 feed 图场景，manual 与 none 场景自行补单测）；sku_stock 补单测

### A5 每周同步 `core/src/jobs/weekly.ts`
- [ ] sitemap index 展开、限速抓取（默认 1 req/s，可配置）
- [ ] `seo/pages.jsonl`、`seo/issues.jsonl`（DATA_SPEC §5.8 规则表，长度规则用 shared/seo.ts 的 grade 函数）、`seo/links.jsonl`（排除导航/页脚）
- [ ] `content/blog_index.jsonl`（日期三种来源、作者、404 处理）
- [ ] `catalog/product_details.jsonl`、`catalog/categories.json`（url_rule 模式识别分类页）
- [ ] `--only <step>`：只跑某一步（用于校验页"重新生成"）
- **验收**：用 http 服务托管 `fixtures/www/` 后结果与 `expected/project/` 一致；1.1 新表补单测

### A6 校验与修复 `core/src/validate/`
- [ ] 按 DATA_SPEC §6 规则产出 `logs/validation.json`（`ValidationReport`）
- [ ] 修复映射：`regenerate:{job}.{step}`、`autofix`（排序/去重/换行）、`restore_archive`、`delete_copy`
- [ ] ajv 校验用 `schemas/`；补齐 1.1 新 schema（seo_page、seo_issue、seo_link、product_details、sku_stock、validation，并更新 site/category/sku_media/sku_tags/edm_campaign）
- **验收**：`fixtures/invalid/*` 退出码一致、每条期望错误都有对应项；人为损坏 links.jsonl → repair → 恢复

### A7 README、台账、分类、文件夹
- [ ] README 区块解析/替换（`<!-- siteindex:auto:{id} -->`），6 个自动区块 + 用户区块保留
- [ ] 台账 upsert/delete（keywords、sku_media、sku_tags、edm_campaigns、outreach），含规范化（大小写、www）
- [ ] categories preview/apply（返回 `CategoryPreview`）
- [ ] folders：create/describe（写 `_about.md`、`site.json.workspace_folders`，刷新 README folder-map），默认文件夹不可删
- [ ] EDM 渲染（`edm render`，缺货跳过，`--allow-oos`）
- [ ] 新建项目：`detect(url)`、`inspectFeed`、`createProject`（复制 `templates/project`、写 site.json、_about.md、首次 daily）

### A8 查询服务 `core/src/service/`
- [ ] `createCoreService(ctx: { resolveProject(id): string; deviceId: string; cacheDir: string })`，实现 WORKSTREAMS §2 中 core 列的全部方法，签名与 `SiteIndexApi` 一致
- [ ] 列表统一分页/排序/筛选/搜索；内存缓存，`invalidate(projectPath)` 由 C 在文件变化时调用
- [ ] `runJob(req: JobRequest, report: ProgressReporter): Promise<JobResult>` —— 统一入口，含执行前检查（项目可读 → 执行设备 → 锁）与 runs.jsonl
- **验收**：用 `fixtures/expected/project` 作为项目，对每个查询方法写单测；1 万 SKU 合成数据下列表查询 < 50ms

### A9 命令行 `packages/cli/`
- [ ] ARCHITECTURE §6 全部命令；`--json` 输出 `CliJsonOutput`；退出码用 `EXIT`
- [ ] `tsup` 打包为单文件 `packages/cli/dist/cli.js`（C 把它放进 `resources/`）
- [ ] `schedule list` 读 site.json；`schedule install/remove` 在命令行中只更新 site.json 并提示"打开 SiteIndex 软件后自动注册到系统"（系统注册只在 desktop 实现，避免 core 依赖操作系统）
- **验收**：每个命令有测试（用 fixtures 项目）；`node dist/cli.js query <p> products --json` 可用

## M3 · 浏览器相关与性能

### A10 design 与 index-check
- [ ] 使用 `playwright-core`，`executablePath` 由调用方传入（C 负责检测系统 Edge/Chrome）；没有浏览器 → 退出码 7
- [ ] design：首页/分类页/产品页（1440、390 宽）→ `design/tokens.json`、`brand.md`、截图
- [ ] index-check：ARCHITECTURE §10.1（间隔 20–40 秒随机、单次 ≤ 50、遇验证码停止，剩余标未检查）
### A11 性能
- [ ] 合成 1 万 SKU feed：daily（不含下载）< 30 秒；写 benchmark 脚本 `pnpm --filter @siteindex/core bench`

## 交付给其他工作流
- 给 B：无直接依赖（B 用 mock）。但请在 M2 前把 `fixtures/expected/project` 保持最新，B 的 mock 数据从这里生成
- 给 C：`createCoreService`、`runJob`、`dist/cli.js`；每次改动签名先走契约流程
