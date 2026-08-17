# dsh-llm-vision-bridge

[English](README.md) | 中文

图像转文字桥：通过配置的识图模型路由，把附带的图片转成模型可见的文字描述，让选中的模型即使只支持文本，也能在同一个任务里消费图片。该插件提供可选的 `visionBridge` 服务，并注册面向模型的 `describe_image` 工具。

## 配置

插件行默认禁用；部署方启用时需显式指定声明了 `image` 输入的路由。

| 字段 | 类型 | 必填 | 默认值 | 用途 |
|---|---|---|---|---|
| `provider` | string | 是 | — | 拥有识图模型的已注册 provider 路由（如 `llm-pi-ai` 设置中的某个 profile）。 |
| `model` | string | 是 | — | 该路由上的精确模型 id。 |
| `describePrompt` | string | 否 | `DEFAULT_DESCRIBE_PROMPT` | 每次描述请求附带的下达指令。 |
| `maxTokens` | number | 否 | `2048` | 每次描述的输出上限。 |
| `describeTimeoutMs` | number | 否 | `60000` | 每次描述的协作预算：工具调用限制与准入等待上界。 |

启用后若路由未注册，或模型未声明 `image` 输入，会在第一次描述调用时大声失败。

## 服务：`visionBridge`

- `describeImage(ref, options?)` — 通过配置的路由描述一个持久化的 `ImageAttachmentRef`，返回纯文本。`options.question` 在配置的下达指令后追加针对性问题；`options.signal` 取消模型调用。路由缺失、模型不支持图片或 provider 调用失败/中止时抛错。

准入消费方（dsh-host-apiproxy）通过 `ctx.get('visionBridge')` 读取服务，并把 dsh-llm 共享的 `imageDescriptionBlock()` 紧接在对应图片之后持久化。该普通文本块同时携带 `imageDescriptionText()` 信封与点名确切持久附件的 `imageDescriptionOf` 标记；标记可穿过会话日志的 JSON 往返。Core dsh-llm 持有最小 `VisionBridgeService` 服务面与 Context 类型合并；本包实现并重导出该服务面及投影 helper。Host 与通用适配器因此只依赖 core，不会继承本插件的文件系统／工具／不变式 peer。

## 工具：`describe_image`

通过文件系统与附件服务读取 PNG/JPEG/WebP/GIF 工作区文件，持久化保存后返回识图模型的文字描述——它是 `read_image` 在纯文本路由下的伴侣。与 `read_image` 一样，它会在调用识图提供方前拒绝空路径、不受支持或被部署禁用的媒体类型、非普通文件，以及扩展名与内容不一致；相对路径以会话工作区解析，并报告文件系统观察结果与展示路径，不暴露图片字节。仅当 `tools` 服务挂载时注册该工具；每次执行都会重新检查 `fs` 与 `attachments`。

配置的识图路由是一条第三方数据边界：每次准入描述或 `describe_image` 调用都会把图片字节、配置的提示词和可选问题发送给该提供方。部署方只能启用其数据处理、留存与地域路由符合工作区要求的提供方，用户也必须有权披露所选图片。该行保持禁用时，不会有图片经这座桥发送。


## 设计说明

- 描述在准入时写入持久化用户消息，而不是在请求时改写：loop 构建的请求仍是会话日志的纯函数（模型可见 ⟺ 已记录）。
- 只有每张可见图片都紧接着带有针对该确切附件的受控描述时，才允许切换到纯文本模型。服务存在不等于覆盖完整：桥启用前入库的历史会在模型选择时安全拒绝。
- `dsh-llm-pi-ai` 实现当前通用的纯文本边界投影：只移除已覆盖的图片块，保留其持久描述文本；任何未覆盖图片都会在 provider I/O 前被拒绝，因此最终请求不含图片块。
- 识图请求是一次性手工构建的调用，携带 `source: { kind: 'plugin', plugin: 'llm-vision-bridge' }`；它本身不进入会话历史。
- 路由能力每次调用都重新检查，HMR 或设置变更不会使准入决策过期。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型可见生成的 [`describe_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-llm-vision-bridge)。输出上限与工具预算属于部署设置，不是模型参数。

#### Token 影响

插件行启用期间，每次请求付出固定的 schema 开销。

#### KV Cache 影响

定义不变时前缀稳定。插件生命周期或 schema 变化可能使缓存自第一个变化的 schema token 起失效。

### 图片描述

#### 模型看到的内容

为准入图片生成的描述以如下精确信封追加到同一条持久化用户消息；识图模型会收到配置的描述下达指令，针对性问题在其后追加一行。

##### 描述信封（逐字引用）

```markdown
[image-description]
<vision model text>
```

##### 问题行（逐字引用）

```markdown
User question: <question>
```

##### 默认描述下达指令（逐字引用）

```markdown
Describe the image in detail and accurately: the main subject, any text content (transcribe it verbatim), and key details. Answer in Chinese.
```

#### Token 影响

数据相关的描述文本会在纯文本适配器边界取代已覆盖图片，并与其他用户文本一样随消息保留。未覆盖图片会被拒绝，而不是被丢弃。

#### KV Cache 影响

独立的辅助模型请求；主会话前缀不受影响，直到描述文本进入持久化历史。

## 已知限制与暂缓事项

- **桥启用前已入库的历史** — 在支持图片的模型下持久化的图片没有受控描述。只有每张图片都有持久覆盖后才能切换到通用纯文本路由；适配器绝不会静默丢弃未覆盖图片。旧历史回填仍属暂缓工作。
- **Provider 延迟** — 带图片的准入会等待识图调用；部署所用 provider 的速度决定提示延迟上限，且准入层不做重试。
