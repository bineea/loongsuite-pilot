# 文件增删行统计验证记录

验证日期：2026-11-16。环境：Windows，Node.js 22.17.1。基于 fork 的 main，功能分支 `feat/agent-code-line-metrics`。

## 最终相关验证

| 验证 | 结果 |
|---|---|
| 代码证据处理器 | 24 项通过 |
| Claude transcript parser | 26 项通过 |
| 代码摘要 + 原有摘要 | 7 + 24 项通过 |
| Dashboard 渲染与 HTTP 服务 | 3 + 7 项通过 |
| InputManager → 脱敏 → JSONL → 摘要重启的集成测试 | 1 项通过 |
| 原有 Dashboard 静态页面行为 | 13 项通过 |
| Claude 原生 Edit/Write 经真实 hook 程序到统一处理器 | 2 项通过 |
| `npm.cmd run typecheck` | 退出码 0 |
| `npm.cmd run build` | 退出码 0 |

以上相关测试合计 107 项。新测试先验证功能缺失或计数错误，再实现修复；最后再次运行通过。浏览器使用明确的示例摘要验证中文表格、7 天范围切换、英文切换保留范围、未知值和 Agent 名称转义；示例不是用户实际产量。

最终独立审查还重新执行了 24 项处理器测试，确认无剩余必须修复的问题（限定于已披露支持范围）。

## 审查中修正的实际误算

1. 替换块中的部分共同内容：采用有界行级 LCS，避免将没有变化的行重复计入新增/删除。
2. `apply_patch` 的 `Add File`：真实工具可覆盖已有文件，不能仅凭成功的 A 标识断定是创建；缺少原文时整操作未知。
3. `Move to`：真实工具可覆盖已有目标文件，缺少目标原文时整操作未知。
4. Claude 创建结果可能同时包含空 `structuredPatch`：优先使用明确创建类型与内容。
5. 多个 tool_result 共用一个原生结果对象时，不猜测归属。

## 基线问题与验证限制

扩展回归曾运行到 559 项通过、2 项失败，另有 1 个测试文件加载失败。加载失败来自工作树 CRLF 与带 shebang 的 `scripts/validate-trace.mjs` 在测试加载器中的兼容问题；将工作树换行恢复为仓库 LF 后，该文件 4 项测试通过，未产生源码差异。

其余 2 项是未修改的 `status-bar-app-manager.test.ts` 在 Windows 上的进程匹配预期；已单独重现并确认实现和测试内容与 HEAD 一致。

另行运行原有 `dashboard-lifecycle.test.mjs` 的安装/服务部分有 25 项失败，涉及 Bash 配置解析、进程匹配及 PowerShell 安装配置。已从 HEAD 提取原始测试重新运行，得到相同 25 项失败，并确认对应脚本未修改。因此不宣称全仓库测试通过，也未在本次功能中扩展修复安装与状态栏行为。

构建保留原有 `deploy-command.ts` 的 CommonJS / `import.meta` 警告；本次未修改该代码。

本次没有重新安装系统服务、没有使用真实模型执行新编码任务、没有推送远端。现有 Pilot 仍运行原安装版本；使用增强版需要后续打包/部署并更新 Claude hook。完整支持范围和统计口径见[功能说明](code-line-metrics.md)。
