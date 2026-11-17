# 按 Agent 统计实际文件增删行

本 fork 在采集端、摘要和本地 Dashboard 增加文件增删行统计。指标按 `gen_ai.agent.type` 分组，因此汇总与展示不需要为新 Agent 单独写分支。**接入 Agent 不等于其全部编辑方式已具备可测量证据。**

## 统计口径

- 只统计已成功执行且有可核验差异证据的文件编辑，不从 Token 数换算。
- 统计文本文件物理行，包含空行、注释、配置文件及文档；不是语义代码行或最终 Git 留存行数。
- 新增与删除分别累计，净增为新增减删除。同一文件反复修改会重复计入；回滚也是一次新的修改。
- 文件数显示为“文件修改次数”，不能解释为独立文件总数。
- 使用采集日志的日期分桶，与现有 Token 摘要的日期一致。
- “—”表示没有已测量的操作；“0”只有在有已测量操作且该项确实为零时出现。
- “未测量操作”表示工具记录不足以确定文件差异，不表示这些操作一定写过文件，也不能当作漏采的代码行数。

## 证据与边界

| 来源 | 可测量证据 | 无法确认时 |
|---|---|---|
| Codex `apply_patch` | 调用中的完整 `Update File` 补丁 + 对应结果明确成功；统计更新补丁中的新增、删除行 | `Add File` 与 `Move to` 均可能覆盖已有目标文件，缺少目标原文时与整文件删除一样标为未测量；失败不计 |
| Claude Code `Edit` | 成功结果中的原生 `structuredPatch` | 只有替换参数而没有实际应用结果，不猜测替换次数 |
| Claude Code `Write` | 明确的原生创建结果及内容，或覆盖结果中的差异 | 旧文件覆盖缺少原文/差异，标为未测量 |
| 其他 Agent | 相同的成功编辑证据格式由统一处理器识别 | 不支持的工具格式标为未测量，可继续扩展解析器 |
| Shell / Bash / PowerShell / code-mode `exec` | 当前不执行脚本，也不推断脚本是否写入 | 标为未测量；嵌套在 `exec` 中的编辑不能等同于独立 `apply_patch` |

处理器不读取工作区当前文件来猜测历史修改前内容，也不把整个 Git 工作区的人工修改归给 AI。终端脚本和未支持 Agent 的完整覆盖，需要后续增加可靠的操作前后快照或原生编辑事件。

更新补丁使用行级差异消除替换块中的共同内容，包括重复行和空行。每次操作最多计算 100 万个差异单元，单份证据上限 2 MiB；超出预算标为未测量，不退回不准确的估算。一份混合补丁中若有无法测量的文件，整个操作标为未测量，避免把局部计数伪装成完整结果。

Claude hook 会从原生 transcript 中保留统计必要的编辑结果。使用已有安装时需要重新部署增强版 hook，旧 hook 已丢弃的差异无法自动恢复。采集器在脱敏前计算数值，随后沿用现有脱敏与输出管道，不新增源码快照库。

## 事件和看板

每条工具结果增加 `gen_ai.code.change_status`，以及已测量操作的 `gen_ai.code.lines_added`、`gen_ai.code.lines_deleted`、`gen_ai.code.files_changed`。字段定义见[输出事件 Schema](output-event-schema.md)。

Dashboard 的“AI 文件增删行 · 按 Agent”表支持自选开始日期和结束日期（包含首尾两天，日期相同表示查询单日）。默认选择采集器当前日期；刷新和语言切换保留用户选择。选择范围只作用于代码统计，页面上标注“今日”或“最近 30 天”的 Token 等指标保持其标示的口径。

`metrics-summary.json` 新增 `codeChangeHistory`，包含 `startDate`、`endDate` 和 `days: [{ day, codeChanges }]`。仅发布按日、按 Agent 的数值汇总，不暴露事件或调用身份。前端对选定日期区间合计。当前保留窗口为采集器今日及此前 200 天；缺少采集记录的日期无法补齐。超范围、非法日期或开始晚于结束会提示错误；没有对应记录显示无数据。旧采集器不提供历史汇总时会提示升级，不会以今日数据冒充所选日期结果。

原有 `ranges.<range>.codeChanges` 固定范围字段继续保留，兼容已有消费者。单个 Agent 的数据结构为：

```json
{
  "agentType": "codex",
  "addedLines": 12,
  "deletedLines": 5,
  "filesChanged": 2,
  "measuredOperations": 2,
  "unmeasuredOperations": 1,
  "failedOperations": 0
}
```

以上仅是格式示例，不是用户真实统计。旧版日志没有新增数值字段，已知的编辑/执行工具只标为未测量，不能还原完整历史代码量。采集进程重启后若缺少先前调用的补丁，结果也可能无法测量。

## 构建与验证

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test -- tests/unit/normalization/code-change-processor.test.ts tests/unit/status-bar/code-change-summary.test.ts tests/unit/status-bar/metrics-summary-writer.test.ts tests/unit/dashboard
npm.cmd run build
```

依赖和构建均在源码目录进行。安装构建产物时，沿用项目的打包/部署流程，备份现有配置后替换运行版本，并重新部署 Agent hook。仅拉取代码或构建不会改变正在运行的 Pilot 服务。
