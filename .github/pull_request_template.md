## 改了什么
<!-- 一两句话 -->

## 工作流
- [ ] docs
- [ ] A core/cli
- [ ] B ui
- [ ] C desktop
- [ ] contract（packages/shared，需另外两个工作流知会）

## 自检
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 只改了本工作流拥有的目录（见 docs/WORKSTREAMS.md）
- [ ] 对应任务清单（docs/tasks/*.md）已勾选
- [ ] 涉及界面：已附截图（Windows）
- [ ] 涉及界面：PR 描述附 `pnpm ui:check` 输出，且没有新增裸字号、裸色值、裸 px 间距或小于 10px 的字号
- [ ] 涉及界面：字体、控件高度、Tab 用法、日期时间格式符合 `docs/DESIGN.md`
- [ ] 涉及五个板块页：遵循 `docs/DESIGN.md` §3 骨架，摘要数字可点击且不重复；时间只在项目头可见，来源时间放提示
- [ ] 涉及五个板块页：附合并矩阵与 `ui:check` §3.5 指标（1280×800 表头 ≤200px、≥9 行、无相对时间/横向滚动条）
- [ ] v0.8.0 UI：按 `docs/DESIGN.md` §6 使用 PageFrame；项目头贴顶且 48px、全局标题行 56px、内容间距 16px，页面滚动容器符合规范
- [ ] v0.8.0 UI：页头按钮 32px、间距 12px；工具栏控件 32px、间距 8px；表格列序与固定标识列符合规范
- [ ] v0.8.0 UI：附 `pnpm ui:check` 输出，以及 1280×800 / 1920×1080 脱敏截图；若属于迁移页，标明当前基线与新增违例数
