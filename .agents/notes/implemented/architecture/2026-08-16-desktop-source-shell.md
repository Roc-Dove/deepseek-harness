# Agent Note: Private Electron source shell

Status: implemented

English | [中文](2026-08-16-desktop-source-shell.zh.md)

## Problem

Developers need a native window around the shipped Web application without creating a second UI composition. An Electron entry also introduces machine-wide installation risk, privileged external-link handling, and a process-tree owner: a package lifecycle script can mutate the shared Electron bundle, renderer links can reach operating-system URL handlers, and killing only the pnpm wrapper can orphan the `dsh web` backend.

The repository has no desktop packaging, signing, notarization, update, or standalone runtime flow. Treating the development entry as a release member would make the dsh npm family require its unrelated version and attempt to publish a private package that cannot run outside a source checkout.

## Decision

`apps/desktop` is a private source-checkout development shell over the existing loopback Web carrier described by the [GUI layering decision](2026-07-19-gui-layering-and-rpc-protocol.md). It runs `pnpm dsh web --port 0` from `DSH_REPO_ROOT`, embeds the reported loopback URL, and stores its isolated `DSH_HOME` under Electron's application user-data directory. It requires an installed and built repository; it is not a packaged desktop application or a second Host/Client assembly. The operational contract lives in the [desktop README](../../../../apps/desktop/README.md).

Installation and startup run no repository-owned lifecycle hook. The shell never patches `Electron.app`, Electron package resources, application metadata, or a launcher under the user's Desktop, and it does not override Electron's download-control environment. Runtime window and Dock icons use Electron APIs only.

`DSH_DESKTOP_PATCHES` is an optional JSON array of non-empty paths. The launcher preserves array order as repeatable `dsh web --patch <path>` options and rejects malformed input before spawning. This gives the default-disabled Vision Bridge and other deployment overlays one reproducible desktop entry without teaching the shell plugin configuration.

Renderer navigation is parsed before use. Same-origin HTTP navigation and redirects stay in the existing main window; every `window.open` request is denied after an internal target is redirected there, so no secondary window bypasses the main window's policy. `will-navigate` and `will-redirect` share one handler: only credential-free, syntactically valid, cross-origin `http:` and `https:` URLs are cancelled and passed to `shell.openExternal`. File URLs, custom schemes, credential-bearing URLs, and malformed targets are cancelled without external dispatch.

The backend owns a dedicated process tree. POSIX launches pnpm detached, sends `SIGTERM` to the whole process group, escalates surviving members to `SIGKILL`, and waits for the group to disappear. Windows uses `taskkill /T /F` and waits for the root exit. Repeated quit paths share one stop promise, and Electron's `before-quit` is held until that promise settles. Startup diagnostics retain a bounded output tail; once the loopback URL is found, the accumulating data listeners are removed and both pipes remain in draining mode. A post-start process `error` or unexpected `exit` is reported once and enters the same orderly quit path, while events emitted after shutdown starts are silent.

The centralized release-directory policy in `scripts/release/workspace-members.ts` names `apps/desktop` as a local-only application. Release-family discovery, workspace constraints, and the legacy npm-baseline packer consume that same policy, so the shell remains private and its independent version does not enter the [npm release sequences](../process/2026-08-10-npm-release-sequences.md).

## Alternatives considered

**Patch the installed Electron application from `postinstall` or pre-launch hooks.** Rejected because it mutates a dependency shared through the package-manager store, invalidates platform signatures, overrides an operator's download controls, and can write outside the repository. Application branding belongs to a future package-and-sign pipeline.

**Publish the shell with the dsh npm family.** Rejected because its entry requires pnpm, a source checkout, and built workspace artifacts. A private local tool is explicitly excluded rather than temporarily made version-compatible with an artifact it cannot provide.

**Build an Electron IPC carrier immediately.** Rejected because the shipped Web carrier already provides the complete application and loopback trust checks. IPC becomes a separate carrier decision only with a standalone packaged runtime.

**Kill only the direct pnpm child.** Rejected because pnpm launches the CLI as a descendant and can exit before it; direct-child state cannot prove the owned tree is quiescent.

## Consequences

The desktop shell reuses the exact Web composition and can apply explicit local overlays, while installation remains free of repository-owned machine mutations. Its renderer-to-OS link surface is a small HTTP(S) allowlist, and window closure joins the backend tree before Electron exits.

Root Vitest discovers `apps/desktop/tests/**/*.spec.ts`. The runtime and main-integration suites cover patch parsing and argv order, navigation and redirect classification and wiring, bounded startup logging and pipe draining, post-start backend failures, single startup, POSIX escalation, Windows tree termination, and coalesced quit behavior. Release-family tests pin the local-only directory and negative pnpm filter.

The shell costs one local Electron dependency and still creates an application user-data directory at runtime. A force-kill or missing `taskkill` that cannot prove termination fails the quit operation visibly instead of claiming cleanup. Distribution remains absent: installers, standalone dependencies, code signing, notarization, auto-update, binary licenses, and platform packaging require a separate decision and release path.
