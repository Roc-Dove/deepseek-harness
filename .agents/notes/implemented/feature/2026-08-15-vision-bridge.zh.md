# Agent Note: 识图桥把附带图片转为文字，供纯文本模型消费

Status: implemented

[English](2026-08-15-vision-bridge.md) | 中文

## 问题

Web 默认 Agent 跑在官方 DeepSeek 路由上，而该路由只支持文本：其序列化器无法发送像素，且当所选模型未声明 `image` 输入时，提示准入会拒绝含图片的消息。可识图的模型只是另外的可选路由，要理解一张图片就意味着把整个会话切到识图模型——任务失去推理模型。识图桥的第一版随后引入了一项发布阻断：它把服务存在当成所有旧图片都已描述的证明，通用文本适配器因此可能静默丢弃更早的未覆盖图片。

## 决策

新增 `@deepseek-ai/dsh-llm-vision-bridge` 包，在两个模型之间架起一座可选的桥：`visionBridge` 服务通过配置的识图路由描述一张持久化图片，`describe_image` 工具则按需回答关于工作区图片文件的问题。

描述在提示准入时就写入持久化历史，而不是在请求时改写。当所选模型不支持图片输入且桥已组合时，`dsh-host-apiproxy` 放行图片，通过桥生成描述（以 `describeTimeoutMs` 为上界），并把 dsh-llm 共享的 `imageDescriptionBlock()` 紧接着图片追加到同一条持久化用户消息。它是 `imageDescriptionText()` 信封内的普通模型可见文字，同时携带点名确切附件的 `imageDescriptionOf` 标记；该标记可穿过 JSON 持久化。纯投影 seam 与最小 `VisionBridgeService` 契约都留在 core，使 Host 与通用适配器无需依赖本插件，也不会继承其文件系统／工具／不变式 peer。于是 loop 构建的请求仍是会话日志的纯函数：模型可见文字已记录，图片仍在 UI 中渲染。桥调用失败时以 `attachment-error`（reason `VISION_DESCRIPTION_FAILED`）拒绝提示，而不是悄悄丢弃图片。

桥请求本身是一次性手工构建的 `llm.stream` 调用，携带 `source: { kind: 'plugin', plugin: 'llm-vision-bridge' }`；它不进入会话历史。路由存在性与图片模态每次调用都重新检查，HMR 或设置变更不会让准入决策过期。

模型选择只有在覆盖可证时才放宽，绝不会因为桥服务恰好存在而放宽。每张可见图片（包括嵌套在工具结果中的图片）都必须紧接着带有针对该确切附件的非空受控描述。`dsh-llm-pi-ai` 持有当前通用纯文本请求边界：只移除已覆盖图片块，保留其持久描述文字，并在任何未覆盖图片上于 provider I/O 前抛出 `UNSUPPORTED_CONTENT`。因此最终 provider 请求含对应描述而不含图片内容。`deepseek-official` 保持另一项由提供方拥有的投影，输出显式的非视觉占位符。

该行在 web-app bundle 中默认禁用；部署方在后续补丁层启用，并显式给出 provider/model 路由。配置了不存在的路由或未声明 `image` 输入的模型，会在第一次描述调用时大声失败。

该设计遵循[每个 LLM 请求都可从会话日志重建](../architecture/2026-07-05-reconstructable-requests.md)的不变量：描述是日志的一部分，而不是请求时的改写。

`describe_image` 工具会在调用识图路由前拒绝空路径、不受支持的扩展名、非普通文件、部署禁用的媒体类型，以及扩展名／内容不一致。它以会话工作区解析相对路径、发出文件系统观察，并像 `read_image` 一样展示通用读文件调用意图。

配置的识图路由是一条明确的第三方数据边界：每次准入描述或工具调用都会把图片字节、配置的提示词和可选问题发送给该提供方。部署方必须选择可接受的数据留存／地域政策，并确认调用方有权披露图片；该行保持禁用时不会经桥发送任何内容。

## 备选方案

**在 `llm/stream` 瀑布里描述** — 否决。loop 构建的请求到达时已深度冻结，必须保持为会话日志的纯函数；在那里改写图片块会让模型可见文本脱离日志。

**把整个 Agent 切到识图模型** — 本功能所替代的现状；它失去推理模型，且图片一旦进入历史就锁死了纯文本路由。

**每张图片派生一个识图子 Agent** — 否决。为一次有界的转写付出整套 Agent 循环与工具面，而且子 Agent 从父提示中拿不到图片字节。

## 后果

描述发生在附件存储提交之后、持久化用户消息创建之前，所以描述失败会拒绝提示，而不会把图片留在会话日志里——与"provider 能力声明直到请求时才失败"的路径不同。

每张准入图片消耗一次以 `describeTimeoutMs` 为上界的辅助识图调用；因此带图片时准入延迟受 provider 速度约束，且没有重试。

不启用该行的部署对纯文本路由保持图片准入安全拒绝。桥只读取自己配置里点名的内容；它从不根据设置文档去推断识图路由。

## 测试

`packages/llm/llm-vision-bridge/tests/loader-composition.spec.ts` 通过 Loader 装配真实 tools/fs/attachment 三件套启动插件：描述请求携带配置的路由与图片块；有效工作区文件返回文字；空路径、不支持、目录、媒体禁用与内容不匹配输入都在 provider I/O 前失败；路由配置错误则大声失败。`projection.spec.ts` 固定受控相邻关系、附件身份、嵌套工具结果、伪造／空白标记、安全拒绝投影，以及标记穿过 JSON 往返后的存活。

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` 覆盖准入与选择两个接缝：纯文本选择 + 桥存在时准入新图片并持久化受控块，无桥时保持原有拒绝，服务存在时未覆盖历史仍被拒绝，覆盖完整历史才获放行。PiAI context 与 adapter 测试证明最终纯文本 provider 请求收到描述但没有图片块。无密钥 `apps/web/tests/vision-admission-deepseek-projection.e2e.ts` transcript 快照运行已发布 Web 组合，固定从纯图片准入、识图请求和受控持久块到真实 DeepSeek 适配器纯文本协议请求的完整序列；replay、refresh、record 和场景自身的封闭文件清单断言共同覆盖已提交 golden 文件。

## 后续

- 桥启用前入库的历史没有受控描述；这类会话切到通用纯文本路由会被拒绝，绝不会静默投影。旧历史回填属于暂缓工作。
- 准入不做重试；一次瞬时 provider 失败会拒绝提示，由用户重试。
