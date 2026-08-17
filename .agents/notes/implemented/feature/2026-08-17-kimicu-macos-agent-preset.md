# Agent Note: A shipped computer-use preset connects to separately installed KimiCU

Status: implemented

English | [中文](2026-08-17-kimicu-macos-agent-preset.zh.md)

## Problem

The working computer-use composition existed only below one developer's `DSH_HOME`. That explains the local picker, but it cannot produce the same surface on a clean installation: packaged Desktop creates a new application-owned home, strips source patch variables, and never copies a builder's presets. Copying that home into an installer would also cross the desktop distribution boundary by carrying machine-local state instead of reviewed product configuration.

KimiCU is not a Harness dependency. It is a separate macOS application with its own release, executable, and Screen Recording and Accessibility grants. A visible preset therefore cannot mean that KimiCU is installed or authorized. Its tools can click, type, press keys, scroll, and read the screen, so exposing them without an explicit Harness approval boundary would turn a macOS permission grant into unattended model authority.

## Decision

The CLI ships `config/agent-presets/computer-use` as a system preset. It follows the [standing preset composition](../architecture/2026-08-08-per-preset-standing-mounts.md): the complete Standard mode composition remains readable in one file, and one additional `@deepseek-ai/dsh-mcp-client` row connects `/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp -s user`. The metadata order places **Computer use** after the four existing modes, and the Web locale table supplies authoritative English and Chinese names and descriptions.

The installer carries only that reviewed configuration and the generic MCP client. It does not carry `KimiCU.app`, a download URL, macOS privacy grants, or any developer user data. The build verified for this integration is KimiCU 0.5.8, an arm64 application requiring macOS 14 or later. The menu copy and desktop guide therefore identify Apple silicon and macOS 14 as the verified boundary, explain that both Screen Recording and Accessibility must be granted directly to KimiCU, and require a Harness restart after installation or permission changes. The repository does not invent a download mirror or tell users to bypass Gatekeeper when no publisher source has been verified.

A missing KimiCU is a non-fatal optional dependency. The MCP row sets `failOnStartupError: false`, so the preset still supplies its Standard mode tools when the executable cannot connect, and it sets `reconnect.enabled: false` so one selection does not launch a repeated failure loop. No `mcp__kimi-cu__*` tools are registered in that state; restarting the Host is the recovery path after KimiCU becomes available.

The MCP client gains an opt-in `requireApproval` setting, enabled by this preset. Each resulting MCP `ToolDefinition` owns `requiresApproval`; `ToolRuntime` applies that requirement after the reorderable `tools/pre-execute` waterfall, so an allow result cannot weaken it. Registration captures an internal immutable execution, output, schema, and approval contract while `get()` preserves the public definition identity required by existing consumers. Each call also snapshots and runtime-seals its name and arguments. Replacement definitions, callback mutation, argument mutation, or a definition swap while approval is pending therefore fail closed or continue under the exact approved contract instead of changing what the approval authorizes. When no approval answerer is composed, the call fails before `callTool`; rejection likewise prevents the external request.

The persona uses KimiCU only when its qualified tools are actually present and explicitly forbids launching or driving KimiCU through the Standard-mode shell. It relies on accessibility text for a text-only route and treats a returned screenshot as visual evidence only when the active model route declares image input. This is capability guidance, not an operating-system sandbox: a separately approved shell command remains able to launch external software, and macOS grants remain attached to the KimiCU process rather than to one Harness tool call.

Preset discovery is currently platform-neutral. The reviewed directory consequently ships in the CLI tarball and every Desktop backend. Windows and macOS Intel can list the row even though the verified arm64-only KimiCU build cannot connect there. The product copy states that limitation instead of pretending the row is available only on supported Macs. Desktop artifact verification requires all five preset pairs, and the dsh npm payload gate requires both computer-use files.

## Alternatives considered

**Copy the developer's `DSH_HOME/.agent-presets/computer-use` into the installer.** Rejected because it makes a local mutable directory the release source and weakens the rule that credentials, sessions, endpoints, patches, and builder paths do not enter a Desktop artifact.

**Bundle KimiCU with DeepSeek Harness.** Rejected because KimiCU has its own distribution, license, signature, update lifecycle, and macOS privacy onboarding. This repository has no reviewed right or mechanism to redistribute it, and the user explicitly accepts installing it separately.

**Fail the whole preset when KimiCU is absent.** Rejected because the picker is meant to show the capability before the external prerequisite is installed. Keeping Standard mode available gives the row an honest degraded state; its description and guide explain why the computer tools are absent.

**Keep automatic reconnect enabled.** Rejected for an absent application. Ten exponential-backoff spawn attempts add log noise and background work without helping a user who must install an application or change system permissions. Restart is explicit and deterministic.

**Let macOS permissions stand in for Harness approval.** Rejected because Accessibility and Screen Recording authorize the KimiCU process broadly; they do not express consent for a particular model-generated click, keystroke, or screen read.

## Consequences

A clean installation now shows the computer-use preset without importing any developer files. On a prepared Mac, selecting it composes the Standard mode capabilities plus the KimiCU MCP tools. On a Mac without KimiCU, or on another platform, it remains Standard mode with no KimiCU tools. This distinction is visible in localized copy and documented as an external prerequisite rather than hidden behind a failed session.

Computer-use calls add an approval round trip. That is deliberate friction at the registered MCP boundary where model output becomes operating-system input. Deployments that set approval policy to never reject these calls; deployments with an interactive answerer can allow them one at a time. An assembled keyless transcript proves both sides of the boundary: the external fixture receives no call while approval is pending or rejected, and receives exactly one call after `allowed-once`.

KimiCU can return accessibility-tree text, visible application content, and screenshots. These results can reach the selected model provider and durable session history. The default DeepSeek route is text-only and cannot inspect screenshot pixels; image understanding requires a route that declares image input, and the disabled Vision Bridge does not automatically describe KimiCU screenshots. The standing preset generation and its managed MCP child live until the Harness process exits, not merely until the user changes sessions or presets. These data-flow and lifecycle facts remain explicit user-facing constraints.

The composition duplicates Standard mode, following the existing shipped-preset convention. Changes to the Standard roster must therefore consider computer-use too, and the shell-platform test covers both copies. A future platform-availability schema could remove the row from non-macOS rosters and offer install/permission health in the picker, but that is a separate product change rather than an inaccurate claim in this one.
