# Agent Note: MCP image results use durable attachment projection

Status: implemented

English | [中文](2026-08-16-mcp-image-result-attachment-projection.zh.md)

## Problem

MCP tools can return ordered image content blocks, but the original [MCP client decision](2026-07-07-mcp-client-plugin.md) converted every image to a text placeholder because the harness had no production image path. The attachment service and image-capable model routes now exist, so unconditional discard loses useful screenshots and generated images even when the active route can consume them.

An MCP server is external input. Its declared media type, base64 bytes, image count, aggregate size, attachment-shaped fields, and text values cannot bypass local content policy, and a result must not claim that an image reached the model when storage failed before a durable reference existed. This note partially supersedes only the earlier result-mapping decision; the MCP package, transport, naming, discovery, and lifecycle decisions remain owned by the original note.

## Decision

### Admission and durable storage

`dsh-mcp-client` reads `ctx.attachments` with `ctx.get()` and declares `@deepseek-ai/dsh-attachment` as an optional peer with no runtime import. Without that service, raw MCP images remain in the execution-local value and render as text placeholders.

Before image admission, the executor sanitizes every external content block. An MCP-supplied `attachment` property is stripped and warned without reading or resolving the claimed ID; a valid-looking reference is not evidence that local storage owns it. If the same block carries base64 bytes, those bytes re-enter ordinary admission, and only the reference returned by this call's successful `saveImage()` becomes trusted. A non-string `text` field is removed and warned before the canonical value is published, while both rich and collapsed projection independently require a string and otherwise emit `[text: invalid content discarded]`.

The executor resolves the calling route from the latest request header, falling back to the agent's configured provider and model, then requires `ctx.llm.resolveModelInfo()` to report `image` input. A missing, text-only, or unresolvable route keeps every MCP image as a placeholder and performs no attachment write.

For an image-capable route, admission preserves MCP content order and applies the attachment service's accepted media types, `maxImagesPerMessage`, `maxImageBytes`, and `maxMessageImageBytes`. The encoded-size check runs before allocating decoded bytes. Successfully stored images alone consume the count and aggregate-byte ledgers, so an invalid or rejected block does not prevent a later admissible block from using the remaining budget. `saveImage()` remains authoritative for byte-format, declared-type, and decoded-pixel validation.

### Canonical value and model projection

Each admitted image is durably saved before the tool result can be committed. Its raw MCP `{ type: "image", data, mimeType }` entry is replaced in the execution-local canonical value by `{ type: "image", attachment }`; unchanged text and other MCP blocks, plus `structuredContent`, retain their protocol order and values. Native rendering emits the attachment-backed `ImageBlock` in that same position. A nested Code Mode dispatch also defers one plugin-sourced user message containing the ordered rich projection because the nested canonical value itself does not enter model history.

Unsupported media, configured count or byte overflow, and stable attachment validation failures affect only that image block: its sanitized raw block remains in the canonical value, model rendering emits the established `[image: …, content discarded]` placeholder, and the plugin logs a warning without image bytes. Model-route lookup failure also logs before using placeholders. An attachment infrastructure failure or unknown storage error is rethrown, so `ToolRuntime` produces an error result instead of presenting a successful call whose image was not committed.

## Alternatives considered

**Keep discarding every MCP image.** Rejected because durable image storage and image-capable routes are production capabilities; unconditional loss would make MCP screenshot and image-generation tools unusable on the routes designed to consume them.

**Inline MCP base64 in the session log or model request.** Rejected because logs own durable references rather than large binary payloads, and adapters resolve verified bytes from the attachment store. Inline bytes would duplicate storage, inflate history, and bypass content-addressed integrity checks.

**Attach images without checking the calling route.** Rejected because a text-only next request could not serialize the resulting history. Exact route admission keeps a tool result from making its own session unroutable.

**Fail the entire MCP tool call for every inadmissible image.** Rejected because text and other blocks in the same successful result remain useful when one remote block has an unsupported format or exceeds a configured limit. Per-block placeholders preserve that information. Durable-storage failures still fail the whole call because success without the promised reference would be false.

**Retain both MCP base64 and the attachment reference.** Rejected because the attachment object is the durable source of the verified bytes. Keeping both copies would expose the binary payload to Code Mode and retain an unbounded duplicate after admission.

**Trust an MCP-supplied attachment reference when its shape is valid.** Rejected because attachment IDs are local capabilities, not portable MCP data. Shape validation would still let a remote server bypass byte validation and configured limits or probe an object already present in the local store.

## Testing

Package unit coverage pins exact and exceeded count, per-image-byte, and aggregate-byte limits; mixed block order; route fallback and refusal; validation warnings; fail-closed storage errors; forged valid-looking attachment references; and object-valued text. A keyless stdio test calls a real fixture MCP server and proves ordered multi-image attachment projection, canonical base64 replacement, nested deferred context, and text-route placeholders. The `mcp-image-result` ACP snapshot boots the published MCP client through the real Loader composition, waits until the real MCP discovery path has registered the fixture tool, calls the local stdio MCP process, persists the content-addressed image result, and makes replay call two resolve that attachment ID through `fromRequest`; replay fails unless the subsequent assembled model request carries the image reference. Refresh, replay, and the snapshot fixture inventory cover the committed transcript.

## Consequences

Image-capable routes receive MCP screenshots and generated images in server order, while text-only or unconfigured deployments keep the previous explicit placeholder behavior. Admitted base64 is intentionally absent from the canonical result; callers receive durable attachment metadata and can resolve bytes through the attachment service.

Admission is per block rather than transactional across the whole MCP result. The first admissible images can attach while later blocks become placeholders. If storage infrastructure fails after an earlier content-addressed save, the call fails and that earlier object can remain unreferenced until attachment garbage collection exists; no failed call publishes its reference into session history.

The optional attachment peer keeps text-only installations loadable. Deployments that mount attachments but select a non-image route pay no decode or storage cost. Warning volume is proportional to rejected image blocks and stripped wire claims, while storage outages surface through the ordinary tool error path.
