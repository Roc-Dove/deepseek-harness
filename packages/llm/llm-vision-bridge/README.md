# dsh-llm-vision-bridge

English | [中文](README.zh.md)

Image-to-text bridge: converts attached images into model-visible text descriptions through a configured vision-capable model route, so an agent whose selected model is text-only still consumes images in the same task. The composing plugin provides the optional `visionBridge` service and registers the model-facing `describe_image` tool.

## Configuration

The plugin row is disabled by default; a deployment enables it with an explicit route that declares `image` input.

| Field | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `provider` | string | yes | — | Registered provider route owning the vision model (e.g. a `llm-pi-ai` settings profile). |
| `model` | string | yes | — | Exact model id on that route. |
| `describePrompt` | string | no | `DEFAULT_DESCRIBE_PROMPT` | Instruction sent with every description request. |
| `maxTokens` | number | no | `2048` | Per-description output cap. |
| `describeTimeoutMs` | number | no | `60000` | Cooperative per-description budget: the tool-call limit and the admission wait bound. |

Enabling the row without a registered route, or with a model that does not declare `image` input, fails loud on the first description call.

## Service: `visionBridge`

- `describeImage(ref, options?)` — describes one durable `ImageAttachmentRef` through the configured route and returns plain text. `options.question` appends a targeted question after the configured prompt; `options.signal` cancels the model call. Throws when the route is missing, the model is not image-capable, or the provider call fails or is aborted.

Admission consumers (dsh-host-apiproxy) read the service with `ctx.get('visionBridge')` and persist dsh-llm's shared `imageDescriptionBlock()` immediately after its image. That ordinary text block carries both the `imageDescriptionText()` envelope and an `imageDescriptionOf` marker naming the exact durable attachment; the marker survives the session log's JSON round trip. Core dsh-llm owns the minimal `VisionBridgeService` face and Context augmentation; this package implements and re-exports that face plus the projection helpers. Host and generic adapters therefore depend only on core and do not inherit this plugin's filesystem/tool/invariant peers.

## Tool: `describe_image`

Reads a PNG/JPEG/WebP/GIF workspace file through the filesystem and attachment services, saves it durably, and returns the vision model's text description — the companion of `read_image` for text-only routes. Like `read_image`, it rejects a blank path, an unsupported or deployment-disabled media type, a non-regular file, and extension/content mismatch before asking the vision provider. It resolves relative paths against the session workspace and reports the filesystem observation and display path without exposing image bytes. The tool is registered only while the `tools` service is mounted; each execution re-checks `fs` and `attachments`.

The configured vision route is a third-party data boundary: every admission description or `describe_image` call sends the image bytes plus the configured prompt and optional question to that provider. Operators must enable only a provider whose data handling, retention, and regional routing are acceptable for the workspace, and users must be authorized to disclose the selected image. Leaving the row disabled sends no image through this bridge.


## Design notes

- Descriptions are baked into the durable user message at admission, not rewritten at request time: the loop-built request stays a pure function of the session log (model-visible ⟺ logged).
- A text-only selection is allowed only when every visible image is immediately followed by the controlled description for that exact attachment. Service presence is not coverage: history admitted before the bridge fails closed at selection.
- `dsh-llm-pi-ai` performs the current generic text-only boundary projection. It removes only covered image blocks, keeps their persisted description text, and rejects any uncovered image before provider I/O; the provider request therefore contains no image block.
- The vision request is a hand-built one-shot call carrying `source: { kind: 'plugin', plugin: 'llm-vision-bridge' }`; it never enters session history itself.
- Route capability is re-checked per call so an HMR or settings change cannot stale the admission decision.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`describe_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-llm-vision-bridge). The output cap and tool budget are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request while the plugin row is enabled.

#### KV Cache effect

Prefix-stable while the definition is unchanged. Plugin lifecycle or schema changes may invalidate reuse from the first changed schema token.

### Image description

#### What the model sees

A description produced for an admitted image is appended to the same durable user message as this exact envelope; the vision model receives the configured description prompt, and a targeted question appends one line after it.

##### Verbatim description envelope

```markdown
[image-description]
<vision model text>
```

##### Verbatim question line

```markdown
User question: <question>
```

##### Verbatim default description prompt

```markdown
Describe the image in detail and accurately: the main subject, any text content (transcribe it verbatim), and key details. Answer in Chinese.
```

#### Token effect

Data-dependent description text replaces the covered image at the text-only adapter boundary and is retained with the message like any other user text. An uncovered image is rejected rather than dropped.

#### KV Cache effect

Independent auxiliary model request; the main conversation prefix is unaffected until the description text enters durable history.

## Known Limitations and Deferred Work

- **History admitted before the bridge** — images persisted under an image-capable model carry no controlled description. Switching that session to a generic text-only route is refused until every image has durable coverage; the adapter never silently drops an uncovered image. Backfilling old history is deferred.
- **Provider latency** — an admission with images waits for the vision call; the deployment's provider speed bounds prompt latency, and no admission-level retry is performed.
