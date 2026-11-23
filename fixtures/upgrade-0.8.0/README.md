# v0.8.0 升级回归样例

`site.json` 和 `project-README.md` 是以 v0.8.0 tag 中的虚构项目配置与 README 模板为基底，填入虚构用户字段的固定样例。测试将其覆盖到隔离临时项目，其他旧版索引行取自 `fixtures/e-v050-w0/projects/legacy`；两者在 v0.8.0 tag 与本测试基线中的 Git blob 相同。`feed.xml` 和页面响应仅用于让 Job 执行，不代表真实站点。

断言每个 Job 后 `site.json` 字节不变、README 三个用户段逐字保留。既有 `fixtures/expected/` 不修改。
