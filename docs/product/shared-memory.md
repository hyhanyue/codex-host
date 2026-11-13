# 共用 Codex 记忆

CodexHost 可将本机所有 Harness 接入同一个 Codex 记忆入口。主库为 Codex home 下的 `memories/shared-memory.sqlite`，不复制各 Harness 的私有记忆目录。此层共享长期事实和历史检索；各会话的活动上下文、压缩策略和原生执行能力仍由各 Harness 管理。

## 开启与入口

在 `~/.codexhost/shared-memory.json` 设置 `enabled: true` 和绝对 `codexHome`。Host 将普通发送、排队发送、配置委派和交接接入公共上下文，并记录已完成的 Agent 消息与已接受的追问。上下文包含 Codex 全局和项目 AGENTS 规则、原生 `MEMORY.md` / `memory_summary.md` 及当前项目的公共记忆。

原生 Codex 可配置 stdio MCP server：使用本机受信任 Node 启动 `app/shared-memory/cli.mjs mcp --home <Codex home>`。其他 Harness 使用上下文中的同一 CLI 入口，不需要复制数据库。Host 进程加载了旧代码时必须重启；重启会中断其任务，应在空闲时执行。

## 读写与一致性

`memory_context`、`memory_search`、`memory_list` 读取统一资料；`memory_remember` 保存已确认事实，支持显式 ID 修正。相同内容和作用域跨 Agent 去重。全局偏好使用 `global: true`；项目事实以绝对工作目录为作用域，并供子目录继承。SQLite WAL、短事务和 busy timeout 序列化并发写入；审计表保留来源 Agent、聊天 ID、时间和修改记录。`memory_forget` 删除有效记忆并保留本地审计记录。

使用模型判断何时保存稳定事实，而不是把全部聊天直接升级为长期规则。用户修正优先于旧事实，应先搜索后更新同一 ID。原生 Codex 的记忆文件只读接入；原生记忆生成开关保持由 Codex 自身管理。

## 历史检索

`history_search` 返回来源、Agent、聊天 ID 和引用片段；`history_read` 按结果 ID 读取对应正文片段。索引支持本机 Codex 的 `thread_history_1.sqlite` 和旧版、归档 JSONL，CodexHost Antigravity 历史以及 Claude Code 本地聊天。未来经过 Host 的其他 Harness 对话也写入同一个索引。

原生数据库和历史文件只读。当前 Codex 数据库按每个聊天的 rollout/update ordinal 增量更新；旧文件按指纹跳过未变内容。长消息分段检索，保留来源。只索引可见用户和 Agent 文本，不把工具输出、隐藏推理或认证文件作为历史资料。索引按需更新；显式 `refresh: true` 可立即同步。

历史摘录属于引用资料，不是当前指令。主库支持中英文关键词检索，没有额外付费模型调用。ChatGPT 云端聊天及未同步到本机的远端历史不属于这些本地来源。

## 验证与部署

模块只依赖 Node 内置库，包括 `node:sqlite`。部署需携带 `store.mjs`、`history.mjs`、`bridge.mjs`、`cli.mjs`；打包脚本将其复制到 `app/shared-memory`。隔离验证应使用独立 Codex home、Host home 和 Claude home，不调用真实模型，不修改用户的原生数据。
