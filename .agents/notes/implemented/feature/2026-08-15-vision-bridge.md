# Agent Note: Vision bridge converts attached images to text for text-only models

Status: implemented

English | [中文](2026-08-15-vision-bridge.zh.md)

## Problem

The default Web agent runs on the official DeepSeek route, which is text-only: its serializer cannot send pixels, and prompt admission rejects an image message when the selected model does not declare `image` input. Vision-capable models exist as separately selectable routes, so understanding an image meant switching the whole session to a vision model — losing the reasoning model for the task. The first bridge implementation then introduced a release blocker: it treated service presence as proof that all prior images were described, so a generic text adapter could silently drop older uncovered images.

## Decision

A new `@deepseek-ai/dsh-llm-vision-bridge` package adds an opt-in bridge between the two: the `visionBridge` service describes one durable image through a configured vision-capable route, and the `describe_image` tool answers on-demand questions about workspace image files.

Descriptions are baked into durable history at prompt admission, not rewritten at request time. When the selected model lacks image input and a bridge is composed, `dsh-host-apiproxy` admits the image, describes it through the bridge (bounded by `describeTimeoutMs`), and appends dsh-llm's shared `imageDescriptionBlock()` immediately after the image in the same durable user message. This is ordinary model-visible text in the `imageDescriptionText()` envelope plus an `imageDescriptionOf` marker naming the exact attachment; the marker survives JSON persistence. Keeping both the pure projection seam and minimal `VisionBridgeService` contract in core means Host and generic adapters do not depend on this plugin or inherit its filesystem/tool/invariant peers. The loop-built request therefore stays a pure function of the session log: the model-visible text is logged and the image still renders in the UI. A bridge failure rejects the prompt with `attachment-error` reason `VISION_DESCRIPTION_FAILED` instead of silently dropping the image.

The bridge request itself is a hand-built one-shot `llm.stream` call carrying `source: { kind: 'plugin', plugin: 'llm-vision-bridge' }`; it never enters session history. Route presence and image modality are re-checked per call, so HMR or settings changes cannot stale an admission decision.

Model selection relaxes only with proven coverage, never because a bridge service happens to exist. Every visible image, including one nested in a tool result, must be immediately followed by a nonblank controlled description for that exact attachment. `dsh-llm-pi-ai` owns the current generic text-only request boundary: it removes only covered image blocks, retains their persisted description text, and throws `UNSUPPORTED_CONTENT` before provider I/O for any uncovered image. The final provider request therefore contains the corresponding description and no image content. `deepseek-official` remains a separate provider-owned projection that emits an explicit non-vision placeholder.

The row ships disabled in the web-app bundle; a deployment enables it in a later patch layer with an explicit provider/model route. Configuration naming a missing route or a model without `image` input fails loud on the first description call.

The design preserves the [reconstructable-requests invariant](../architecture/2026-07-05-reconstructable-requests.md): descriptions are part of the log, not request-time rewrites.

The `describe_image` tool rejects blank paths, unsupported extensions, non-regular files, deployment-disabled media types, and extension/content mismatch before invoking the vision route. It resolves relative paths against the session workspace, emits filesystem observations, and presents the same generic file-read call intent as `read_image`.

The configured vision route is an explicit third-party data boundary: every admission description or tool call sends the image bytes, configured prompt, and optional question to that provider. Operators must choose an acceptable retention/region policy and ensure the caller may disclose the image; a disabled row sends nothing through the bridge.

## Alternatives considered

**Describe inside the `llm/stream` waterfall** — rejected. Loop-built requests arrive deep-frozen and must stay a pure function of the session log; rewriting image blocks there would put model-visible text outside the log.

**Switch the whole agent to a vision model** — the status quo the feature replaces; it loses the reasoning model and locks the session away from text-only routes once images exist.

**A separate vision subagent per image** — rejected. It costs a full agent loop and its own tool surface for a single bounded transcription, and child agents receive no image bytes from the parent prompt.

## Consequences

Describing runs after attachment storage commits but before the durable user message is created, so a failed description rejects the prompt without leaving the image in the session log — unlike a provider-side capability claim that only fails at request time.

Each admitted image costs one auxiliary vision call bounded by `describeTimeoutMs`; admission latency is therefore provider-bound when images are present, and there is no retry.

Deployments that leave the row disabled keep fail-closed image admission for text-only routes. The bridge reads only what its own configuration names; it never infers a vision route from the settings document.

## Testing

`packages/llm/llm-vision-bridge/tests/loader-composition.spec.ts` boots the plugin through the Loader with the real tools/fs/attachment seams: description requests carry the configured route and image block; valid workspace files return text; blank/unsupported/directory/media-disabled/content-mismatch inputs fail before provider I/O; and route misconfiguration fails loud. `projection.spec.ts` pins controlled adjacency, attachment identity, nested tool results, forged or blank markers, fail-closed projection, and marker survival through a JSON round trip.

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` covers the admission and selection seams: a text-only selection with the bridge admits a new image and persists its controlled block, without the bridge the existing rejection holds, uncovered history stays refused even while the service exists, and completely covered history is allowed. PiAI context and adapter tests prove the final text-only provider request receives the description but no image block. The keyless `apps/web/tests/vision-admission-deepseek-projection.e2e.ts` transcript snapshot runs the shipped Web composition and pins the assembled sequence from pure-image admission, through the vision request and controlled durable block, to the real DeepSeek adapter's text-only wire request; replay, refresh, record, and the scenario's closed-inventory assertion cover the committed golden.

## Follow-ups

- History admitted before the bridge carries no controlled descriptions; switching such a session to a generic text-only route is refused, never silently projected. Backfilling old history is deferred work.
- Admission performs no retry; a transient provider failure rejects the prompt and the user retries.
