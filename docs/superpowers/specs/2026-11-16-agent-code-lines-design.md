# 按 Agent 统计文件增删行

用户已确认：统计成功写入文件的新增、删除行，按接入 Agent 区分；基于 fork 的 main 开发。

## 方案

采用采集端证据提取、统一事件字段、现有摘要汇总与看板展示的方案。相比直接统计 Token，文件差异能反映实际编辑；相比仅对整个工作区做 Git diff，操作级证据可避免把人工改动归给 Agent。没有成功结果或缺少前后内容时不猜测。

通用处理器关联 tool.call 与 tool.result，在脱敏前提取已成功应用的补丁/原生编辑差异。优先覆盖 Codex apply_patch 与 Claude 原生 Edit/Write 结果。其他接入工具使用相同的证据契约。任意 shell、code-mode exec 等无法证明文件差异的调用标记未测量；不得宣称所有 Agent、所有写文件方式已经完整覆盖。

## 事件契约

只在 tool.result 添加以下扩展字段：
- gen_ai.code.change_status：measured / unmeasured / failed / not_applicable。
- gen_ai.code.lines_added、gen_ai.code.lines_deleted：非负整数，仅 measured 时存在。
- gen_ai.code.files_changed：本次操作修改的文件数，仅 measured 时存在。
- gen_ai.code.change_reason：缺少证据等原因的稳定标签。

行数采用文本文件物理行，与 diff 的 +/- 一致，包括空行、注释和配置/文档；不是语义代码行、Git 留存或生产力。CRLF 与 LF 等价，文件末尾换行不产生额外空行。重复修改重复计入操作累计量；文件数为文件修改次数，不是跨操作去重文件数。失败、取消和无修改的读取不贡献行数。整个文件删除/覆盖缺少原内容时显示未测量。

审查实测确认：Codex `Add File` 和 `Move to` 可覆盖已有目标文件，其成功标识不是“创建前不存在”的证据。此类操作与整文件删除一样标记未测量。更新补丁采用每次操作最多 100 万单元的行级 LCS 消除共同内容，预算不足显示未测量。

## 汇总与界面

每个时间范围提供 codeChanges 数组，按 agentType 汇总 addedLines、deletedLines、filesChanged、measuredOperations、unmeasuredOperations、failedOperations。无观测证据显示未知，不显示零产出。按 Agent + Session + Call ID 去重结果，回退 Event ID；支持增量扫描、跨日、重启和旧缓存迁移。代码统计独立于原 Token 字段，保持现有消费者兼容。

看板增加代码增删表，支持今日、7 天、30 天；显示正负行数、净增、文件修改次数及已测量/未测量/失败次数。现有中英文切换保持兼容。

## 验证

先补失败测试，再实现解析、统计和展示。覆盖补丁新增/修改/失败/删除缺少原文、Claude 原生差异、脚本未知、Agent/会话隔离、重复结果、重启、历史摘要、旧数据和中英文。执行相关测试、类型检查、构建；用隔离测试数据验证，不改动正在运行的正式采集服务。
