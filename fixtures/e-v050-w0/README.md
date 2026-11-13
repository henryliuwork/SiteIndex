# v0.5 W0 · E 合成验收夹具

本目录只包含虚构数据与可复用期望，不执行 SiteIndex 产品代码，不连接任何站点或凭据服务。

## 覆盖范围

- A · SEO 只读结果 envelope：完整、部分缺字段、来源不可用三种质量场景；记录安全来源标识、采集时间、缺失字段和脱敏异常。
- A · 两种数据布局：相同 SEO 输入分别放在 `projects/legacy/index/` 与 `projects/workspace/_site-index/`。
- D · Products / Inventory 一致性：2 个变体 SKU 组成一个父组，另有 1 个独立 SKU；保存视图仅含真实 SKU，查询期望展示合成父行与独立 SKU。
- D · 保留现有路由与基础功能检查清单见 `expected.json`。

## 本地夹具自检

从仓库根目录运行：

```powershell
node --test fixtures/e-v050-w0/fixture-consistency.test.mjs
```

自检只比较夹具、布局路径、唯一 SKU 集和期望行覆盖；不导入 Core、UI、Desktop，不证明 IPC、页面或安装包行为。

## 后续定向验收

等 A/D 对应 PR 出现后，把 `projects/legacy` 与 `projects/workspace` 复制到系统临时目录下的非同步测试根，再按 `expected.json` 逐项比较实际 Core / UI 输出。实际 PR 未出现前，不把任何结果记为产品通过。
