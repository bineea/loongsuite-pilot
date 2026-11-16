# Agent 代码增删行实施计划

> 使用 superpowers:subagent-driven-development 在当前会话完成。用户已授权源码增强，不再重复询问是否开始。

**目标：** 从成功编辑证据生成代码行指标，并按 Agent 汇总展示。

**架构：** 统一处理器在脱敏前丰富事件；摘要独立维护代码统计；看板展示覆盖范围。

**技术栈：** TypeScript、Node.js、Vitest、HTML。

## 全局约束

- 不用 Token 推算代码行，不把缺少证据视为零。
- 不读取当前文件冒充历史修改前内容；失败不计入成功编辑。
- 新增字段与旧消费者兼容；不修改本机正式服务、不自动推送远端。
- 中文说明；现有页面同时维护英文。

## 任务 1：采集证据

- [x] 在 tests/unit/normalization 添加行为测试并先验证失败。
- [x] 新增 src/normalization/code-change-processor.ts，处理配对和成功差异提取；在 src/core/input-manager.ts 脱敏前调用。
- [x] Claude transcript 保留原生编辑结果中必要的差异证据；测试对应 hook 链路。
- [x] 每个工具结果按设计输出 gen_ai.code.* 字段，未知/失败/读取分别处理。
- [x] 验证关注用例、类型和 schema 兼容。

## 任务 2：摘要

- [x] 先补 tests/unit/status-bar 的代码指标测试并验证失败。
- [x] src/status-bar 中实现 codeChanges 的幂等汇总，复用增量扫描机制。
- [x] 兼容历史记录、重启与按天持久化；按任意 Agent ID 分组。
- [x] 提供 codeChanges: Array<{agentType,addedLines,deletedLines,filesChanged,measuredOperations,unmeasuredOperations,failedOperations}>。
- [x] 验证重复、跨日、重启、旧缓存与现有测试。

## 任务 3：展示和集成

- [x] 先补页面渲染行为测试。
- [x] assets/dashboard/index.html 增加代码统计范围切换和表格；安全转义 Agent 名称。
- [x] 更新中英文 schema 和中文功能文档，标注覆盖限制与物理行口径。
- [x] 执行相关回归、typecheck、build，隔离数据验证，审查最终差异。
