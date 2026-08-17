# Agent Note: DeepSeek text projection for image history

Status: implemented

English | [中文](2026-08-14-deepseek-text-projection-for-image-history.zh.md)

## Problem

The official DeepSeek route accepts text but not images. A durable image anywhere in a session therefore prevented users from selecting DeepSeek even when the surrounding text held all context needed for later work. Forking before the image or starting a new session discarded useful textual continuity, while deleting image events would damage replay and UI fidelity.

## Decision

The `deepseek-official` adapter serializes the text projection of durable message history. It maps every core image block to the stable, model-visible text `[image omitted: DeepSeek cannot inspect this image]`, preserves adjacent text (including any durable bridge description) and tool content, and leaves the session log and attachment store unchanged. A pure-image user message or tool result therefore cannot collapse to meaningless empty wire content.

`session.selectModel` recognizes this provider-owned behavior and permits `deepseek-official` selection when durable or pending messages contain images. Generic text-only routes use the stricter [vision-bridge coverage decision](2026-08-15-vision-bridge.md): every image must carry its controlled durable description, otherwise selection fails closed. Prompt admission still rejects a newly submitted image while DeepSeek is selected unless the optional bridge first persists its description, so the exception does not claim vision support.

## Alternatives considered

**Remove images from the session surface before switching.** Rejected because it would change UI history, fork behavior, export, and later vision-model replay merely to satisfy one provider route.

**Allow every text-only adapter to receive mixed history.** Rejected because other adapters may fail or silently interpret non-text content differently. The exception belongs to the adapter whose serializer defines the projection.

**Keep requiring a fork or new session.** Rejected because the text-only wire request can preserve useful context without weakening durable history.

## Consequences

Users can switch an image-bearing session to DeepSeek V4 Flash or Pro and continue from its text. DeepSeek sees the explicit placeholder but cannot reason about the pixels, so text that depends on an undescribed image may be incomplete; switching back to a vision-capable route restores access to the unchanged image blocks. The marker costs input tokens but makes the loss explicit and keeps pure-image messages non-empty. Unit and adapter-level coverage pin model-selection admission, mixed and pure-image serialization, nested tool results, and the final provider wire body. The keyless `vision-admission-deepseek-projection` Web snapshot boots the shipped composition and pins a pure-image admission as a durable image plus controlled description, then captures the real DeepSeek adapter's loopback wire request with the explicit placeholder and that description.
