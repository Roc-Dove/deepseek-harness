# @deepseek-ai/dsh-mcp-client

[English](README.md) | 中文

MCP 客户端桥接插件：连接外部 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，把它们的工具注册到 `ctx.tools`，使模型能够通过服务器限定名称（`mcp__<serverName>__<rawName>`）将其作为原生工具使用。

## 用法

`cordis.yml` 中每个 MCP 服务器使用一个插件实例：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

模型会看到 `mcp__github__create_issue`、`mcp__web__search` 等工具，这与 Claude Code 和 Codex 使用的服务器限定形状相同。HMR（热模块替换）支持热替换：编辑配置项会触发断开 + 重新连接，无需重启进程；`serverName` 不变时会生成完全相同的工具名称。

## 配置

| 字段 | 传输 | 必填 | 描述 |
|---|---|---|---|
| `transport` | 两者 | 是 | `"stdio"` 或 `"streamable-http"` |
| `serverName` | 两者 | 是 | 该服务器面向模型工具名称的 namespace；`[A-Za-z0-9_-]{1,32}`，在存活实例中唯一 |
| `command` | stdio | 是 | 要 spawn 的可执行文件 |
| `args` | stdio | 否 | 传给命令的参数 |
| `env` | stdio | 否 | 合并到已清理环境中的额外环境变量 |
| `cwd` | stdio | 否 | 子进程工作目录 |
| `url` | http | 是 | MCP 服务器 URL |
| `headers` | http | 否 | 额外标头（例如认证 token） |
| `toolCallTimeoutMs` | 两者 | 否 | 每次 `callTool` 调用的超时（默认 60000） |
| `requireApproval` | 两者 | 否 | 把该服务器注册的每个工具标记为分发前必须通过 Harness 审批（默认 `false`） |
| `failOnStartupError` | 两者 | 否 | 初始连接或工具同步失败时拒绝插件激活（默认 `false`） |
| `reconnect.enabled` | 两者 | 否 | 连接丢失后自动重新连接（默认 `true`） |
| `reconnect.initialDelayMs` | 两者 | 否 | 首次重连延迟（毫秒）；每次连续失败尝试翻倍（默认 500） |
| `reconnect.maxDelayMs` | 两者 | 否 | 退避上限（毫秒）；同时也是重置尝试预算所需的正常运行时长（默认 30000） |
| `reconnect.maxAttempts` | 两者 | 否 | 每次中断期间连续失败尝试次数上限，超出后彻底放弃（默认 10） |

## 工具命名

每个 MCP 工具都有两个名称：通过 `tools/call` 在协议上传送的原始 MCP 名称，以及公开名称 `mcp__<serverName>__<rawName>`，后者注册到 `ctx.tools`。公开名称会规范化为 DeepSeek 函数名称约定（64 个字符、`[A-Za-z0-9_-]`）；如果替换或截断改变名称，就会追加 `(serverName, rawName)` 的确定性 12 位十六进制 hash，确保不同工具绝不会折叠为同一个名称。名称是 `(serverName, rawName)` 的纯函数：连接顺序、重新同步和其他服务器永远不会重命名工具。

- 发布相同原始名称（例如 `search`）的两个服务器会在各自 namespace 下共存。
- 存活实例中的重复 `serverName` 会使后加载的插件实例失败。
- 服务器在工具列表中两次列出同一工具名称时，该列表会作为无效工具列表被拒绝。
- 外部注册抢占该服务器 namespace 时，会回滚整个世代（绝不保留部分集合），并明确报错。

## 行为

- 连接时：插件激活会等待 `listTools()`，并在组合开始首个轮次前通过 `ctx.tools.register()` 以公开名称注册每个工具。初始连接、发现或注册失败始终会记录日志；`failOnStartupError` 为 true 时拒绝激活，否则插件仍会激活但不注册工具。
- 监听 `notifications/tools/list_changed` → 重新同步；获取阶段失败时保留上一世代的注册，注册冲突则会回滚本次尝试的世代，并且不保留该服务器的任何工具。
- 工具执行：`client.callTool({ name: rawName, arguments }, { signal })`，支持超时 + 中止；公开名称绝不会发给服务器。
- `requireApproval` 为 true 时，每个已注册定义都会在 `callTool` 前持有最终审批要求。注册表在可重排的 pre-execute waterfall 之后应用它，因此外层允许无法绕过；拒绝仍然更强，部署没有可用审批应答器时会关闭式失败，不会联系 MCP 服务器。这项要求只覆盖经该已注册 MCP 工具路由的调用；它不是进程沙箱，无法阻止另一个 Shell 或插件通过其他路径启动同一可执行文件。
- 规范成功值是 `{ content: JsonValue[], structuredContent? }`。非图片 MCP 块保持不变，但非字符串 `text` 值会被移除，并渲染为明确的无效内容占位符。每个通过准入的图片块在持久化保存后会替换为 `{ type: "image", attachment }`，因此其 base64 载荷不会保留在规范值中；`structuredContent` 保持不变。受支持且已声明的 `outputSchema` 会验证 `structuredContent`；不受支持的 schema 词汇会回退为不受约束的 `JsonValue`。
- Native／模型渲染按协议顺序保留文本块；音频、资源、不受支持的块和未通过准入的图片块会变成占位符。部署挂载 `attachments` 且调用路由声明支持 `image` 输入时，通过准入的图片块会通过持久化附件进入模型。媒体类型不受支持、图片字节无效，或触发图片数量／字节限制时，受影响的块会降级并记录警告；附件存储失败会使工具调用失败。
- MCP 服务器不能提供本地附件能力。入站 `attachment` 字段会被剥离并记录警告，且不会读取或解析其中的 ID。携带图片字节的块必须重新经过普通准入，只有该次调用成功执行 `saveImage()` 后返回的引用才能进入规范结果或模型上下文。
- 断开／崩溃时：supervisor 以指数退避（`reconnect.initialDelayMs` 逐次翻倍，上限 `reconnect.maxDelayMs`）重启原始服务器配置，成功后重新执行发现——恢复的世代会替换前一个，因此工具既不会重复也不会泄漏。中断期间最后一个正常世代保持注册；针对它的调用在恢复前会失败。
- 重连按中断预算控制：连续失败达到 `reconnect.maxAttempts` 次后，该服务器的工具会被注销，重连停止，直到 HMR 重载或重启 Host。连接存活超过 `maxDelayMs` 会重置预算，因此偶尔崩溃的服务器可以无限恢复，而崩溃循环的服务器——即使短暂连接成功——仍会耗尽上限而非永远重启。
- 重连状态在日志中对用户可见：reconnecting（warn，含尝试次数和延迟）、recovered（info）、最终失败和 disabled-loss（error）。dispose（资源释放）会取消任何待执行的重连。设置 `reconnect.enabled: false` 时，连接丢失后工具保持注册但调用失败，直到重载——即手动恢复行为。

## 消费的服务

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 注册／注销 MCP 工具 |
| `ctx.attachments`（可选） | 持久化图片块，使其进入模型上下文；缺失时使用图片占位符 |
| `ctx.llm`（可选） | 解析调用路由的输入模态以执行图片准入；缺失时使用图片占位符 |

## 模型体验

### 已发现的 MCP 工具

#### 模型看到的内容

初始发现成功后，每个已声明的 MCP 工具都会显示为名为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）的原生工具，并携带服务器提供的描述和输入 schema。成功的重新同步——包括自动重连后的同步——会替换整个世代；对插件执行 dispose（资源释放）或重连预算耗尽会移除该世代。

#### Token 影响

工具注册期间，每次请求都会承担数据相关的 schema 成本。重新同步会替换而非累积 schema，服务器限定名称也会为每个工具定义和调用增加 token。

#### KV Cache 影响

只要已发现工具集合及其 schema 不变，前缀就保持稳定。增加、移除、重命名或更改工具的重新同步会替换定义，并可能使从第一个变化的 schema token 起的复用失效；恢复了未变列表的重连会生成完全相同的定义，前缀保持稳定。

### 工具调用历史与结果

#### 模型看到的内容

公开工具名称和 JSON 参数会保留在 assistant 历史中。文本结果块保留 MCP 协议顺序；无效文本字段、音频、资源、不受支持的块和未通过准入的图片块会变成简短占位符。部署挂载 `attachments` 且调用路由声明支持 `image` 输入时，通过准入的图片块会持久化为附件并作为图片块保留。执行局部的规范值保留经过清理的 MCP 块和可选结构化内容；通过准入的图片则以附件引用取代原始 base64 载荷。MCP `isError` 和附件存储失败会通过注册表的错误路径拒绝调用。

#### Token 影响

参数和映射后的文本会保留到压缩（compaction）发生时。已挂载图片保留持久化附件引用，图片字节存放在附件存储而非日志中；其他二进制与资源载荷会被丢弃，不会加入上下文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **只桥接 MCP 的工具能力**：资源和提示词没有 harness 消费接口，暂缓实现。
- **启动超时继承自 MCP SDK**：DSH 尚未公开连接／发现超时。每次 initialize 请求或分页 `tools/list` 请求都使用 SDK 默认的 60 秒，因此在初始同步完成期间，无响应的 server 或 cursor chain 可能同时延迟激活与 teardown。
- **重连在传输关闭时触发**：崩溃的 stdio 子进程会触发重连；Streamable HTTP 失败通过每次请求以及 SDK 传输自身的 SSE（Server-Sent Events）流恢复机制暴露，因此不可达的 HTTP 服务器会按调用重试，而非由 supervisor 重新 spawn。
- **音频与资源渲染有损**：这些载荷在模型上下文中会变成占位符，即使执行局部的规范值保留了其 JSON 块。只有同时具备 `attachments`、支持图片的路由、受支持字节和符合全部图片限制时，图片才会作为附件进入模型；通过准入的图片条目保留附件引用而非 MCP base64。更丰富的 Native 音频／资源投影暂缓实现。
- **不强制执行不受支持的 MCP 输出 schema**：已声明 schema 使用 harness 子集之外的词汇时，`structuredContent` 会回退到 `JsonValue`。
