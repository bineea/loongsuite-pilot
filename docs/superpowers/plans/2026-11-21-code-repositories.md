# 仓库代码量明细 Implementation Plan

> 执行方式：在本会话使用 superpowers:executing-plans 与 test-driven-development 逐项实现。用户已确认设计和本机更新。

**Goal:** Agent 总计默认不变，展开可见按实际文件归属的仓库明细。

**Architecture:** CodeChangeProcessor 保留有界逐文件数字证据，通过异步仓库解析生成安全的仓库数字分项；汇总按操作去重后分别聚合 Agent 与 Agent × 仓库；前端延迟展开仓库表。

**Tech Stack:** TypeScript、Node.js、Git CLI、Vitest、原生 HTML/JavaScript。

## 约束

不改变既有增删行口径；不猜测未知归属；不把补采计为新增操作；无新增依赖；所有路径/远端信息清理凭据；保留现有 Agent 和日期控件。

## 任务 1：文件归属与数字分项

- [ ] 新建 `tests/unit/normalization/code-repositories.test.ts`：用两个真实 Git 仓库与 worktree 验证一条 FileChange 跨仓库、合并、无远端与未知。
- [ ] 运行 `npm.cmd test -- tests/unit/normalization/code-repositories.test.ts`，确认缺失仓库分项导致失败。
- [ ] 新建 `src/normalization/code-repositories.ts`：`resolveCodeRepository(filePath, workspace)` 返回 `{id,name}`，未知返回固定身份；Git 调用带超时和缓存。
- [ ] 修改 `code-change-processor.ts`，Evidence 增加逐文件数字，`enrichRepositories(entries)` 输出 `gen_ai.code.repositories`；两处 input-manager dispatch 在 masking 前 await。
- [ ] 重跑新增及现有 processor 测试，确认不再保留源码差异。

## 任务 2：历史与汇总

- [ ] 增加 summary 测试：分项和总计一致；旧缓存升级；相同操作从未知升级有归属后不重复；损坏分项回落未知。
- [ ] 修改 `code-change-summary.ts`，新增 `repositoryChanges` 到每日历史，Agent 总计保持接口；缓存迁移并有条件补齐分项。
- [ ] Codex 原生游标增加版本，升级后自动重扫；操作 ID 不变。
- [ ] 运行 summary、native-file-changes、integration 相关测试。

## 任务 3：展开明细与交付

- [ ] 增加 dashboard 测试，验证默认无仓库明细、点击展开、仓库筛选、跨日期、刷新保留与名称转义。
- [ ] 更新 `assets/dashboard/index.html`，每个 Agent 行增加展开按钮；新增翻译和仓库筛选，不改变总计。
- [ ] 更新中英文 README 和 `docs/zh-CN/code-line-metrics.md`，说明历史范围和跨仓库操作次数。
- [ ] 执行 typecheck、相关 Vitest、build；提交、备份配置、打包并安装本机。
- [ ] 核验生产汇总行数守恒和真实网页展开效果，记录验证结果。
