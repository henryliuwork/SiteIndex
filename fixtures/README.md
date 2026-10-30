# 测试数据与黄金输出

## 场景
Kingsyard 风格喂鸟器站点，16 个产品（2 个带颜色变体），见 `generate.py` 顶部说明。

| 输入 | 日期 | 覆盖的规则 |
|---|---|---|
| `feeds/day1.xml` | 2026-10-19 | 首次基线（不产生事件）；变体归组；有效与过期的 sale_price；backorder → preorder；非标准 availability → unknown；重复 id；缺价格条目；URL 去跟踪参数；`overrides` 改标题 |
| `feeds/day2.xml` | 2026-10-20 | 2 个转缺货、1 个到货、1 个调价、1 个上新；KYBF007 从 feed 消失（`missing_as=out_of_stock`，原本已缺货，不产生事件） |
| `feeds/day3.tsv` | 2026-10-21 | TSV 格式（表头带空格）；无变化 |
| `feeds/day4.xml` | 2026-10-22 | 8/18 个 SKU 消失 → 保护阈值中止（退出码 3），数据不变，runs 记录 failed |
| `www/` | — | weekly：sitemap index、首页、2 个分类页、noindex 页、canonical 指向别处的页、2 篇博客（meta 日期 / JSON-LD 作者 / `<time>`）、1 个 404 博客、导航与页脚链接需排除、变体 URL 匹配产品 |
| `inputs/site.json` | — | 站点配置（运行时 `crawl.feed_url` 指向当天 feed） |
| `inputs/ledgers/*.jsonl` | — | 台账写入（含大小写/www 规范化） |
| `inputs/edm/…/content.json` | — | EDM 渲染（含 1 个缺货产品应被跳过） |
| `invalid/*.json` | — | 校验失败样例：`file` 被替换为 `content` 后应得到 `expect_exit` 与 `expect_errors` |

## 期望输出
- `expected/snapshots/dayN.jsonl`：feed 解析结果（适配器输出）
- `expected/steps/dayN/`：每天合并后的 skus、latest、汇总、累计事件、退出码
- `expected/project/`：全部步骤（4 天 daily → weekly(day3 feed) → 台账 → 视图 → EDM）完成后的项目文件夹，**已是新目录结构**

## 1.1 变更
- `views/products.jsonl` 已按 1.1 取图规则重新生成：feed 首图优先 → 手动首图（sku_media）→ none，新增 `feed_image_url`、`manual_image_url`，`image_source` 取值 `feed`/`manual`/`none`

## SKU 分组 fixture
- `sku-grouping/193-skus.json` 是纯虚构的 193 条 SKU 样本，用于验证父子 SKU 规则的稳定分组与未匹配计数。

## 运行黄金测试时
1. 用 http 服务在 `http://127.0.0.1:8765/` 提供 `www/`（URL 已写死在 feed 与页面里）
2. 把"今天"固定为 **2026-10-21**（时区 America/Los_Angeles）。影响：`days_since_featured`、`last_crawled`、categories 的 `last_seen`、weekly 的 run_id、sale_price 有效期判断
3. 比较前把以下字段替换为固定值：`checked_at`、`started_at`、`finished_at`、`last_crawled`、categories 的 `last_seen`
4. `invalid/` 的 `expect_errors` 是参考实现（Python jsonschema）的文案，TS 实现不要求文案一致，要求：退出码一致；每条期望错误都有对应的错误（同一文件、同一规则类型：字段格式/枚举、排序、主键重复、引用缺失）

## 重新生成
修改场景后：`python3 fixtures/generate.py && bash fixtures/build_expected.sh`（需 Python ≥ 3.10 与 jsonschema）。
