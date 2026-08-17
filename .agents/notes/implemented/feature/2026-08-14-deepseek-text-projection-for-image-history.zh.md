# Agent Note: DeepSeek 对含图历史的文字投影

Status: implemented

[English](2026-08-14-deepseek-text-projection-for-image-history.md) | 中文

## Problem

官方 DeepSeek 路由接受文字但不接受图片。因此，只要会话任意位置存在持久图片，即使周围文字已包含后续工作所需的全部上下文，用户也无法选择 DeepSeek。在图片出现前分支或新建会话会丢失有用的文字连续性，而删除图片事件会破坏回放和 UI 保真度。

## Decision

`deepseek-official` 适配器会序列化持久消息历史的文字投影。它把每个核心图片块映射为稳定且模型可见的文字 `[image omitted: DeepSeek cannot inspect this image]`，保留相邻文字（包括任何持久化桥描述）与工具内容，并保持会话日志和附件存储不变。因此，纯图片 user 消息或工具结果不会坍缩成无意义的空协议内容。

`session.selectModel` 识别这项由提供方拥有的行为，并在持久或待处理消息含图片时允许选择 `deepseek-official`。通用纯文本路由遵循更严格的[识图桥覆盖决策](2026-08-15-vision-bridge.md)：每张图片都必须带有受控持久描述，否则模型选择会安全拒绝。选择 DeepSeek 后，新提交图片仍会在 prompt 准入阶段被拒绝，除非可选识图桥先持久化其描述，因此这项例外并不宣称 DeepSeek 具备视觉能力。

## Alternatives considered

**切换前从会话表面移除图片。** 放弃，因为这会仅为满足一个提供方路由而改变 UI 历史、分支、导出和之后视觉模型的回放。

**允许所有纯文本适配器接收混合历史。** 放弃，因为其他适配器可能失败，或以不同方式静默解释非文字内容。这项例外应由定义投影的适配器拥有。

**继续要求分支或新建会话。** 放弃，因为纯文本协议请求可以保留有用上下文，而无需削弱持久历史。

## Consequences

用户可以把含图会话切换到 DeepSeek V4 Flash 或 Pro，并沿用其中的文字继续工作。DeepSeek 会看到显式占位符，但无法理解像素，因此依赖未描述图片的文字可能不完整；切回视觉路由后，仍可访问未变化的图片块。占位符会消耗输入 token，但让信息损失变得明确，并保证纯图片消息非空。单元与适配器级测试固定模型切换准入、混合／纯图片序列化、嵌套工具结果和最终 provider 协议 body。无密钥 `vision-admission-deepseek-projection` Web 快照启动已发布组合，把纯图片准入固定为持久图片加受控描述，再捕获真实 DeepSeek 适配器向本机回环端点发出的协议请求，其中包含显式占位符和该描述。
