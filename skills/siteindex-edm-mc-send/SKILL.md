---
name: siteindex-edm-mc-send
version: 1.0.0
description: 校验并提交用户授权的 EDM 草稿。所有路径从 workspace.json 的逻辑键读取。
reads:
  - _site-index/workspace.json
  - edm.sku_index
  - edm.profile
writes:
  - ledgers/edm_campaigns
---

# siteindex-edm-mc-send

## 数据目录与路径

- 首先读取 `_site-index/workspace.json`。所有板块和 EDM 文件路径必须按其中的逻辑键解析，不得硬编码目录名或根据旧项目习惯推断位置。
- 商品清单使用 `edm.sku_index`；运行配置使用 `edm.profile`；邮件模板、策略和成品目录分别使用 `edm.templates`、`edm.strategy`、`edm.emails`。
- 无法读取映射或配置缺失时先询问用户，不创建猜测的目录。
- 缺少必要运行参数时先向用户提问，并将用户确认的信息写入 `edm.profile` 对应文件。
- 外部邮件服务和连接信息一律视为项目配置项；不记录账号、连接标识或受众 ID。
- 运行结果写入 `ledgers/edm_campaigns` 台账；不得改写自动导出的 SKU 清单。

## 职责边界
- 输入：一个邮件 HTML（`*-ready.html`，正文片段或完整件皆可），或直接贴在对话里的 HTML。
- 输出：邮件或平台服务 里一个**状态为草稿**的 campaign（settings + content 全部写好并回读验证），本地文件状态改为 `-scheduled`，一份可复核的推送汇报。
- **不做**：不排期（`workspace.json` 中的逻辑路径）、不发送（`workspace.json` 中的逻辑路径）、不改订阅者、不动其他受众。只有用户明确说"帮我预设/排期/发送"时，才走第 8 步，且要先逐项复述受众/主题/时间拿到确认。
- 不制作内容、不校验 HTML —— 那些是 `邮件或平台服务-edm-build`。校验未通过（仍是 `-draft`）的文件不推。
## 第 0 步（强制）：读项目配置
```
<project root>/_site-index/edm/edm-profile.md
```
需要拿到：受众 `list_id`workspace.json` 中的逻辑路径emails_dir`、`templates_dir`。
不存在或缺字段 → **停下来要值**，绝不凭接口默认值或其他项目配置代填。
> ⚠️ **项目硬边界**：同一 ESP 账号下可能挂多个品牌受众。不传 `list_id` 时 邮件或平台服务 会落到账号里的第一个受众，**一旦建错品牌就是真实事故**（草稿列表混入他人 campaign、误排期会真发出去）。除用户本轮明确点名的受众，其他受众一律不读、不列、不建、不发。
## 开工前必须确认
1. **发送日期**：没给就先问。日期写进 campaign 的 `settings.title`，方便在草稿列表定位。
2. **发送时间**：没指定用配置里的默认时间（常见 20:00），时区按配置（常见 PT）。汇报里同时给出 UTC 换算值。
3. 要推的是哪个文件/哪段 HTML；同批多个文件**逐个建 campaign**，不合并。
## 执行流程
### 1. 读文件、判断形态
```powershell
该项按项目配置处理，不包含固定站点资料。
"size=$($c.Length)"
"doctype=$($c -match '(?i)<!DOCTYPE')  html=$($c -match '(?i)<html')  body=$($c -match '(?i)<body')  unsub=$($c -match 'UNSUB')  style=$($c -match '(?i)<style')  footer=$($c -match '(?i)footer')"
```
- body-only（无 doctype/html/body、无 `*|UNSUB|*`）→ 需要拼 `workspace.json` 中的逻辑路径 + 正文 + `footer-v4.1.html`（取最新 `-vN`）。**正式拼接交给 `邮件或平台服务-edm-build` 模式 C**；若用户只要快速推送，可只做最小拼接并如实说明该件未经 build 校验。
- 已是完整邮件（含 `*|UNSUB|*`）→ 原样推送，**不要重复拼页眉页脚**（会双份 logo/双份退订）。
- 批量清洗或改写一律生成副本，不覆盖用户原始文件。
### 2. 写 subject 与 preview text（从内容里来，不凭空编）
- `subject_line`：10–70 字符为主（最佳 35–50），讲清"利益点 + 品类/对象"。带折扣时把折扣写进主题。
- `preview_text`：40–150 字符，与主题互补、不重复主题原话；有优惠码就写明码与截止语义。
- 文件头部注释常有 `Subject:`workspace.json` 中的逻辑路径Campaign:`workspace.json` 中的逻辑路径Discount Code:`workspace.json` 中的逻辑路径Date:` 元信息——当线索但**必须核对**注释里的日期与时限用语（如 "This Weekend"、某月活动日）与本次发送日期是否仍成立；不成立要改写。实测：11/7 的正文推 12/1，原注释主题被重写。
- 不编造折扣、价格、库存、运费、认证、时效。文件里没写的数字不进主题/预览。禁全大写堆砌与过多 emoji。
### 3. 创建 campaign（草稿）
工具入口：`mcp__maton__api` 透传（懒加载模式下先取 schema 再调用，不能直接按名字调）。
```json
{
  "method": "POST",
  "path": "/邮件或平台服务/3.0/campaigns",
  "connection": "<配置里的 connection>",
  "json": {
    "type": "regular",
    "recipients": { "list_id": "<配置里的 list_id>" },
    "settings": {
      "title": "[{PREFIX}-{TYPE}] 活动简称 - `{sku}` HH:MM PT",
      "subject_line": "...",
      "preview_text": "...",
      "from_name": "<配置>",
      "reply_to": "<配置>",
      "to_name": "<配置，通常是 *|FNAME|*>",
      "authenticate": true,
      "auto_footer": false,
      "inline_css": false
    }
  }
}
```
- `settings.title` 是**内部名称**（草稿列表可见可搜），类型前缀必须写入——`邮件或平台服务-edm-plan` 靠它区分邮件类型做分析。
- `auto_footer` 保持配置值（一般 `false`：页脚由项目 `footer-v4.1.html`（最新 `-vN`）自己拼，开了会再加一份 邮件或平台服务 页脚）。
- 记下返回的 `id` 与 `status`（新建为 `save`workspace.json` 中的逻辑路径draft`）。
- 上面 `settings` 里全部字段构成**完整必要字段集**，任何后续修改都必须整份带上（见坑 14）。
### 4. 填 HTML 内容
```json
{ "method": "PUT", "path": "/邮件或平台服务/3.0/campaigns/{id}/content",
  "connection": "<配置>", "json": { "html": "<完整邮件 HTML>" } }
```
只传 `html`，`plain_text` 由 邮件或平台服务 自动生成。单封 25–35 KB 直接放进 `json` 可行，实测无需分段。
### 5. 回读验证（必做，不能只看接口 200）
```json
{ "method": "GET", "path": "/邮件或平台服务/3.0/campaigns/{id}/content", "connection": "<配置>",
  "jq": "{html_len: (.html|length), has_UNSUB: (.html | contains(\"*|UNSUB|*\")), has_ARCHIVE: (.html | contains(\"*|ARCHIVE|*\")), has_logo: (.html | contains(\"<品牌标识串>\"))}" }
```
再 `workspace.json` 中的逻辑路径（`exclude_fields=content,report_summary`）核对：`status`、`subject_line`、`preview_text`、`to_name`、`recipients.list_id`、`from_name`、`reply_to`。
任何一项不符 → `workspace.json` 中的逻辑路径，**`json.settings` 整份带上步骤 3 全部字段**，改完再读回。**只凭 2xx 不算验证通过**，必须看回读出的实际值。
### 6. 大 HTML 的 token 完整性比对
`html_len` 只能看量级，**不能判定"内容一致"**——邮件或平台服务 会把 `&amp;` 归一化为 `&`（实测 28 处，33,315 → 33,148，差 −167）。用分类 token 计数代替总长度：
```json
{ "method": "GET", "path": "/邮件或平台服务/3.0/campaigns/{id}/content", "connection": "<配置>",
  "jq": "{len: (.html|length), utm_email: (.html | split(\"utm_medium=email\") | length - 1), sku_links: (.html | split(\"/products/\") | length - 1), table_open: (.html | split(\"<table\") | length - 1), table_close: (.html | split(\"</table>\") | length - 1), img: (.html | split(\"<img \") | length - 1)}" }
```
期望值从**本地拼接文件**同口径统计（`([regex]::Matches($c,'utm_medium=email')).Count`），逐类对齐即可，不要求总字符相等。另加字体名与主色 hex 的分块计数，以及反斜杠计数（期望 0）。token 名按当轮正文实际链接形态调整（不是每封都有 `workspace.json` 中的逻辑路径）。V4 邮件另加：Trust 图标地址（`workspace.json` 中的逻辑路径 下 `9adc61f2`、`af3e1b8d`、`ab0c5e30`、`0f21c0cb` 各 1 次，见 `workspace.json` 中的逻辑路径）、`UNSUB` 计数 1、`ARCHIVE` 计数 1。mso 条件注释配对（`[if ` 与 `[endif]`）在本地数即可，读回侧不必进 `jq`。
### 7. 改文件状态 + 汇报
推送并验证通过后把 `-ready.html` 改名为 `-scheduled.html`（状态流转：`draft` → `ready` → `scheduled` → `sent`）。用户随后取消排期时，状态名按实际情况回退并在汇报里说明。
汇报逐封给出：campaign ID、内部标题、subject、preview、受众（list 名 + id）、当前状态、内容字节数与 token 比对结论、**预定发送时间（本地时区 + UTC 双写）**、archive_url，以及"请在后台审核后手动排期"。原样贴关键 JSON 字段值，不做美化。
### 8. 仅当用户明确要求排期时
走完第 5–6 步验证、把受众/主题/时间逐项复述拿到确认后，才允许：
```json
{ "method": "POST", "path": "/邮件或平台服务/3.0/campaigns/{id}/actions/schedule",
  "connection": "<配置>", "json": { "schedule_time": "`{sku}`:MM:SS+00:00" } }
```
- `schedule_time` 必须是 **UTC** ISO8601（PT 20:00 冬令时 → 次日 `04:00+00:00`，夏令时 `03:00`）。
- 成功返回 **204 空响应体**，透传侧表现为 `null` —— 这**不是失败，也不能当证据**。立刻 `workspace.json` 中的逻辑路径 回读：`status == "schedule"` 且 `send_time` 与传入值逐字符一致才算成功。
- 事后撤销：`workspace.json` 中的逻辑路径（具体动作路径以 `workspace.json` 中的逻辑路径 返回的 `_links` 为准，实测可见 `cancel-send`workspace.json` 中的逻辑路径pause`workspace.json` 中的逻辑路径resume`），状态变 `paused`、**不回 `draft`**，`send_time` 仍残留显示。
- `paused` 恢复排期用 `workspace.json` 中的逻辑路径，再回读验证。**已 `paused` 不能再调 `workspace.json` 中的逻辑路径。**
- 排期后的设置改动同样受坑 14 约束，改完必回读。
## 已踩过的坑（实测证据，别再犯）
1. **`search_actions(app="邮件或平台服务")` 返回 0 条** —— 邮件或平台服务 没有预建动作，别以为连不上；必须走 `mcp__maton__api` 透传 `workspace.json` 中的逻辑路径，且显式带 `connection`（不指定会落到同应用最旧的一条连接）。
2. **不传 `list_id` 就发到别的品牌**。
3. **`邮件或平台服务` 工具在懒加载模式下不能直接按 `mcp__maton__api` 调用**，要走 list → get → call 三件套；直接调报工具不存在。
4. **排期/发送状态不可逆降级**：`schedule` 成功后取消只会变 `paused`，不回 `draft`，且 `paused` 不能重新 `schedule`（要 `resume`）。所以默认停在草稿，把排期交给用户。实测测试单最终就是 `paused`（`send_time` 残留）。
5. **时区**：接口写入 `schedule_time` 与读回 `send_time` 都是 UTC，用户说的"晚上 8 点"通常是本地时间，汇报必须双写，否则差 7–8 小时。
6. **草稿态 `send_time` 读回 `null` 是正常**，不是出错。
7. **这三项 API 配不了，别再试**（实测 `settings` 全集里根本没有，`long_url` 恒为 `null`）：自动最优发送时间、Automatic resend、Email URL 别名。只能在后台 UI 设。报错形态：`workspace.json` 中的逻辑路径 → 405 "method and resource are not compatible"；`create-resend`（带 `shortcut_type`）对未发送单 → 400 "The campaign was never sent"；`settings.timewarp` 塞文案被静默转成 `false`；`settings.url` 被丢弃。
   `settings` 里能写的只有：`title`、`subject_line`、`preview_text`、`from_name`、`reply_to`、`to_name`、`authenticate`、`auto_footer`、`auto_tweet`、`fb_comments`、`folder_id`、`inline_css`、`template_id`、`timewarp`、`drag_and_drop`、`use_conversation`。
8. **HTML 允许是片段**：不写 DOCTYPE/html/head/body 也能创建成功，读回 `content_type` 为 `html`，`<style>` 块（含 `@import` 引字体）能保留。**但必须有 `*|UNSUB|*`**，否则后台发送检查拦住。
9. **`jq` 里别用正则 `test(...)` 判断 merge tag** —— 多层转义会编译失败；判断包含一律用 `contains("...")`。含 `[` 的模式容易和 jq 字符串转义打架。
10. **`workspace.json` 中的逻辑路径 返回整段 HTML（3 万+ 字符）**，别直接读进上下文；用 `jq` 只取需要的布尔值与计数。列表查询加 `exclude_fields=content,report_summary,total_sent_to`。
11. **文件头注释的 subject/日期可能是上一个活动的**，照抄会把过期限时发进本期邮件，按本期发送日期重写。
12. **send-checklist 常报两类 warning**（未含 referral link、内容疑似 AI 生成需人工确认），是账号级常态，不影响建草稿，如实转达，不必反复重试。
13. **不要凭 POST 返回 200 就宣布"已推送完成"** —— 必须走第 5 步回读（坑 14、15 说明写操作可以返回成功却把内容改坏，或什么都没写进去）。
14. **`settings` 是整体替换，不是增量合并 —— 代价最大的坑**。实测两次 `PATCH` 只传 `settings.url`workspace.json` 中的逻辑路径settings.timewarp`，都返回成功，回读却发现 `to_name` 从 `*|FNAME|*` 变成空字符串 —— 称呼个性化被静默清空。若不回读，正式发出的邮件会整封丢掉收件人姓名。规则：**改任何设置必须整份带上步骤 3 的全部字段**，写完立刻 `GET` 回读逐项比对，修复办法也是整份回写。排期后的修改同样适用。
15. **未知/类型不符字段被静默丢弃仍返回 2xx**（`settings.url` → `null`；`settings.timewarp` 传字符串 → 布尔 `false`）。结论：**状态码不能证明字段写进去了**，只有回读的实际值算数（`workspace.json` 中的逻辑路径 的 204 空体同理）。
16. **排期动作返回 204 空体**：当失败会重复排期，当成功又缺证据 —— 唯一正确做法是回读 `status` 与 `send_time`。`paused` 恢复用 `workspace.json` 中的逻辑路径，不要重新 `schedule`。
17. **大 HTML 写入后别拿总长度判断完整性**：要求字节级相等是错的，用第 6 步分类 token 逐类对齐。
该项按项目配置处理，不包含固定站点资料。
19. **禁止把 HTML 属性引号批量换成单引号来"省 JSON 转义"**。内联样式里已有 `'[字体名已省略]'` 这类单引号，属性改用单引号定界后值被提前截断：读回 `[字体名已省略]` 从 32 掉到 2、主色 hex 从 17 掉到 11，而 PUT 依然返回成功。保持源文件 `"` 定界不动。
20. **转义只做一层**。载荷准备顺序：① 非 ASCII → 数字实体（`©`→`&#x00A9;`、`—`→`&#x2014;`、`’`→`&#x2019;`，注释里的制表符一并转），整段变纯 ASCII；② 把 `"` 预转义为 `workspace.json` 中的逻辑路径 存成 `.esc.txt`，按约 1500 字符分块（**分块边界不得落在反斜杠后面**）；③ 发 `json.html` 时**逐字复制 `.esc.txt` 内容**（单反斜杠 `workspace.json` 中的逻辑路径）。多写一层（`workspace.json` 中的逻辑路径）邮件或平台服务 会收到字面反斜杠：读回开头变成 `workspace.json` 中的逻辑路径、反斜杠计数 928、`utm_medium=email` 20→6、`href=` 29→11，PUT 仍然返回成功。
21. **shell 输出过大会被宿主摘要成文字**（不是原文），不能用 `Get-Content` 直接把 3 万字符 HTML 取回上下文。只能走"定长分块文件 + 逐块 `read` + 原序拼接"，每行 ≤ 2000 字符，否则读取会截断该行。
22. **第 5/6 步校验必须包含反斜杠与样式完整性计数**，只看 `*|UNSUB|*`workspace.json` 中的逻辑路径jq` 里加反斜杠计数（期望 0）、字体名与主色 hex 的分块计数（与本地同口径）、每个产品 slug 的 `contains()`。本地基线用 `([regex]::Matches($t,'[字体名已省略]')).Count` 统计。
23. **重复推送同一段 HTML 会生成多个 campaign**：写入类调用结果不明时（超时、连接中断），先 `workspace.json` 中的逻辑路径 或按内部标题搜草稿确认是否已存在，再决定是否重试；不要盲目重发，否则草稿列表堆积同名单，误排期就发两遍。
## 排错入口
透传报 4xx / 权限类错误时，读 邮件或平台服务 路由说明：
`[站点地址已省略]
多连接选择与透传规则见 `api-gateway` 技能。
**凭据一律不进聊天、不写进文件、不回显**；配置文件只存连接标识与环境变量名。
## 验收标准
- 状态是草稿（`save`workspace.json` 中的逻辑路径draft`），且 `recipients.list_id` == 配置的受众；
- subject、preview text、title、from_name、reply_to、to_name 全部非空且与内容一致；
该项按项目配置处理，不包含固定站点资料。
- 回读内容里 `*|UNSUB|*` 与 `*|ARCHIVE|*` 均为 true、无重复页眉页脚、第 6 步各分类 token 与本地文件逐类对齐（总字符允许因 `&amp;` 归一化变短，见坑 17）；
- `settings.to_name` 回读确认为配置值（曾被部分写入清空过，必须显式核对，见坑 14）；
- 反斜杠计数为 0、字体与主色 token 计数与本地一致（坑 19/20/22）；
- 已向用户报告发送日期时间（本地时区 + UTC 双写）；默认未执行任何排期或发送调用；
- 本地文件已从 `-ready` 改名为 `-scheduled`；
- **仅当本轮用户明确要求排期**：回读 `status == "schedule"` 且 `send_time`workspace.json` 中的逻辑路径null` 本身不作证据（坑 16）。

## 数据与安全边界

- SKU、商品名、价格、库存、图片 URL、受众与连接标识必须来自当前项目数据或用户明确提供；不得编造、借用其他项目的数据或写入示例真值。
- 凭据由 SiteIndex 或用户配置读取；不要请求、复制、记录或输出密码、密钥、受众 ID、连接 ID。
- 创建草稿和改写台账前先读取现有内容；写入后回读核对。没有用户明确授权时不排期、不发送。
