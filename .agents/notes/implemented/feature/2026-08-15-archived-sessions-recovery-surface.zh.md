# Agent Note：已归档会话获得设置页恢复入口与取消归档 RPC

Status: implemented

[English](2026-08-15-archived-sessions-recovery-surface.md) | 中文

## 问题

[注册表级全局归档集合决策](2026-07-31-session-archive-global-set.md)刻意保留了会话日志和 workspace 记账槽位，同时将会话从所有分组界面隐藏；但第一版没有任何界面列出归档集合，也没有逆向操作。用户归档会话后就再也找不到、也无法恢复它——数据还在，回去的路却没有。

## 决策

**取消归档是注册表级全局展示集合的写入，而非会话操作。** 工作区注册表新增 `unarchiveSession(sessionId)`：把该 id 从 `archivedSessionIds` 移除，并经由既有 `setState` 路径提交，使 `domain/changed` 监听器广播与归档相同的 `host/archived-sessions-changed` 帧。不执行会话存在性校验——取消归档根本不需要会话数据，缺失 id 的陈旧标记只需清除一个展示位。不在集合中的 id 直接无写入地成功返回（与归档的幂等语义互为镜像）。

**线上接口与 `workspace.archiveSession` 对称。** `workspace.unarchiveSession` 携带相同的载荷并返回完整的更新后集合，因此客户端的回显安装（`installArchived`）与变更帧处理器与归档共用一条路径。请求与帧代数会阻止较旧的完整集合 unary 回声覆盖较新的帧或本地请求。客户端 `IWorkspaces` 接口、运行时 manager/service、apiproxy 的 schema/handler/client 行以及所有测试替身都以同一形状扩展。

**恢复界面以 `settings.section` 形式放在 ui-workspace。** 工作区领域本就拥有归档菜单项、其语言包与浏览界面，因此「已归档会话」设置页留在该包内而不是新建一个包。该分区通过标准框架钩子读取数据（`useSessions` 取行——列表存储仍携带已归档会话，浏览器只是过滤掉了它们；`useWorkspaces` 取归档集合）。点击行会先等待 `ctx.workspaces.unarchiveSession`，再经 `ctx.sessions.open` 打开会话并关闭设置面板；该顺序不可颠倒，因为 runtime 会清除仍处于归档集合中的当前选择。独立的「取消归档」操作只恢复而不打开。行序遵循 Host 的追加式归档集合顺序；空态只在会话列表基线就绪后渲染，基线未就绪时分区保持静默。

## 已考虑的替代方案

**把取消归档作为 Session 操作，并拒绝缺失会话。** 否决，因为归档集合是注册表级全局展示元数据，不是会话自有状态。即使对应的会话日志已经消失，也必须能够清除陈旧标记。

**打开归档行但不恢复。** 否决，因为 runtime 会清除仍在归档集合中的当前选择。因此点击行会组合恢复与打开，而独立的「取消归档」操作保留只恢复、不打开的意图。

**为恢复界面新建独立 UI 包。** 否决，因为 ui-workspace 已拥有归档操作、locale namespace、分组语义和 workspace hooks。通过既有设置槽贡献一个分区，可以把领域所有权放在一起，也无需扩展 settings shell。

## 后果

- 取消归档能把会话恢复到原分组位置，因为归档从未改动工作区的 `sessionIds` 记账。
- 变更帧会到达每个已连接标签页，因此在一个标签页里恢复，其他标签页无需刷新即重新显示该行。
- 该分区为 ui-workspace 增加 `@deepseek-ai/dsh-client-ui-settings` 的 peer/dev 依赖边与 tsconfig 引用（槽由 ui-settings-general 的壳声明；注册与所有跨包槽一样经由 `slots.inject` 挂载）。
- 动态 Cordis 插件不受影响：归档集合与设置槽的形态均无变化；新增一个 RPC 与一个列表条目纯属增量。
