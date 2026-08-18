# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop packages the existing loopback Web application as a native desktop application. A release installer contains Electron, the built Harness backend, its production dependency closure, and the Web frontend. Someone installing a release does not need Node.js, pnpm, a source checkout, or a terminal: opening the application starts the bundled backend on `127.0.0.1` and displays it in one native window.

## Install a release

Choose the artifact built for the computer's operating system and architecture:

- macOS Apple Silicon: the `macos-arm64` DMG or ZIP;
- macOS Intel: the `macos-x64` DMG or ZIP;
- Windows x64: the `windows-x64` installer.

On macOS, open the DMG and move the application into Applications. On Windows, run the installer. Public macOS artifacts must be signed with a Developer ID certificate and notarized by Apple; public Windows artifacts must be code-signed. An unsigned artifact uploaded by pull-request CI or produced locally is a test artifact, not a public download, and the operating system may block or warn about it.

The first launch creates a fresh application-owned `DSH_HOME` and workspace beneath Electron's user-data directory. The installer does not contain or import the builder's local `DSH_HOME`, credentials, sessions, patch files, checkout paths, or environment configuration. Removing and reinstalling the application does not itself promise to delete that user-data directory.

The installed application has no automatic updater. Install a newer signed release explicitly when one is published.

## Installed configuration

The installed application deliberately starts from the repository defaults. In particular, the shipped Vision Bridge row is disabled. A user must configure a vision-model route that declares `image` input and explicitly enable the row before `describe_image` becomes available.

The packaged launcher removes `DSH_REPO_ROOT`, `DSH_DESKTOP_PATCHES`, `NODE_OPTIONS`, and `NODE_PATH` from the backend environment. This prevents a downloaded application from being redirected into a source checkout, loading host-provided Node code, or silently inheriting a developer's local patch. The installed mode therefore does not offer a `--patch` entry. Product configuration belongs in the application-owned user data; release defaults belong in reviewed source.

Because installed resources are immutable, packaged mode does not mount the source-oriented live patch/HMR watchers. Reviewed defaults and application-owned configuration still load at startup; file-level changes that rely on those watchers take effect after restarting the application. Source development keeps the existing live-watch behavior.

## Computer use with KimiCU on macOS

The installed application includes the reviewed `computer-use` agent preset, so **Computer use (macOS)** appears in the preset picker on a clean install. The preset is configuration only. KimiCU itself is not included in the DeepSeek Harness installer or its production dependency closure.

This integration has been verified with KimiCU 0.5.8. That build is arm64-only and declares macOS 14.0 as its minimum, so it requires an Apple silicon Mac running macOS 14 or later. The macOS Intel Desktop package can still display the preset because roster discovery is shared, but the verified KimiCU build cannot run there. This repository does not redistribute KimiCU or provide a general download mirror. Obtain it only from a publisher source you trust, keep macOS security checks enabled, and do not bypass a signature or Gatekeeper warning merely to use this preset.

Move `KimiCU.app` into `/Applications` before starting a session with this preset. In macOS System Settings, open **Privacy & Security** and grant KimiCU both **Screen Recording** and **Accessibility** access. These are broad operating-system permissions granted directly to the KimiCU process. Restart DeepSeek Harness after installing KimiCU or changing either permission.

When an interactive approval policy is active, every call routed through a registered `mcp__kimi-cu__*` tool asks for explicit Harness approval before `callTool`; rejecting it prevents that MCP request. A policy such as `danger-full-access` that resolves approval as `never` rejects these computer-use calls instead of showing a prompt. This definition-owned gate cannot be weakened by plugin listener order, but it covers only calls routed through the registered Harness MCP tools. It does not sandbox KimiCU, revoke its macOS permissions, or constrain another path. In particular, this preset retains Standard mode shell access; a separately approved shell command can start external programs without becoming a KimiCU tool call.

KimiCU may return screenshots, visible application content, and accessibility-tree text. Harness can send those results to the selected model provider as conversation context and can persist images or related content in session history and attachments. The default DeepSeek route is text-only, so it can use accessibility text but cannot inspect screenshot pixels; a screenshot becomes visual model input only on a route that declares image support. The disabled-by-default Vision Bridge does not automatically describe KimiCU screenshots. Use the mode only around applications and data you are willing to expose to that provider. The first use mounts this preset as a process-lifetime generation: leaving the session or choosing Standard mode for another session does not stop its managed KimiCU MCP child. Quit DeepSeek Harness to stop that managed process. Quit KimiCU and revoke its Screen Recording or Accessibility access when you no longer want it to retain those operating-system permissions.

If KimiCU is absent or cannot connect, the preset remains selectable and keeps the Standard mode coding tools, but it registers no `mcp__kimi-cu__*` computer-control tools. The system prompt tells the agent not to claim screen access when those tools are absent or to start KimiCU through the shell. Automatic reconnect is disabled; restart DeepSeek Harness after installing KimiCU, changing permissions, or manually stopping the managed child. Because preset discovery is platform-neutral, Windows and macOS Intel builds can still show the row even though the verified KimiCU build cannot connect there. If you duplicate this preset for concurrent use, give the copied MCP row a unique `serverName`; two live MCP instances in one Host cannot reserve the same namespace.

## Develop from source

The source development entry remains available and intentionally has a different launch contract:

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

It starts `pnpm dsh web --port 0` from the current checkout. `DSH_REPO_ROOT` can select another installed and built Harness checkout. `DSH_DESKTOP_PATCHES` is a JSON string array whose paths become ordered `--patch <path>` options; relative paths resolve from `DSH_REPO_ROOT`, and malformed JSON, a non-array value, or an empty path fails before startup.

```sh
DSH_DESKTOP_PATCHES='["./local/vision-bridge.patch.yml","./local/desktop.patch.yml"]' pnpm run desktop:dev
```

Patch files are local deployment configuration. Do not commit them when they contain service endpoints, credential references, or other private settings. They are never copied into an installer.

## Build and verify installers

Build on the target operating system and architecture; the desktop runtime includes native dependencies and is not cross-built:

```sh
pnpm run desktop:dist:mac
pnpm run desktop:dist:win
pnpm run desktop:verify
```

The root build runs before packaging, stages only the release-shaped production closure, and writes disposable staging and release output beneath `.artifacts/desktop/`. Verification runs against the packaged runtime rather than the source checkout.

`apps/desktop` remains `private: true` and stays outside the dsh npm release family. Desktop binaries use their own version from this package, `desktop-v<version>` tags, and the `desktop-release.yml` workflow. Pull requests build and verify unsigned macOS arm64, macOS x64, and Windows x64 artifacts without release credentials. A `desktop-v<version>` tag, or a publishing manual run from that tag, enters the protected `desktop-release` environment, requires platform signing and macOS notarization credentials, rebuilds and verifies natively, and publishes the installers with per-target build manifests and `SHA256SUMS` to a GitHub release.

Before upload, macOS signed jobs verify the application with `codesign`, Gatekeeper assessment, and the stapled notarization ticket. The Windows signed job requires a valid Authenticode signature on the unpacked application, installer, and any standalone uninstaller materialized by the packager.

Required protected secrets are:

- macOS signing: `DESKTOP_MAC_CSC_LINK` and `DESKTOP_MAC_CSC_KEY_PASSWORD`;
- Apple notarization API: `DESKTOP_APPLE_API_KEY_ID`, `DESKTOP_APPLE_API_ISSUER`, and a base64-encoded key in `DESKTOP_APPLE_API_KEY_P8_BASE64`;
- Windows signing: `DESKTOP_WIN_CSC_LINK` and `DESKTOP_WIN_CSC_KEY_PASSWORD`.

Fork pull requests never enter the signed jobs and receive none of these secrets. Configure required reviewers and tag restrictions on the `desktop-release` environment before enabling public releases.

## Security and lifecycle

Same-origin `http` navigation and redirects stay in the existing main window, and `window.open` never creates a secondary window without equivalent policy. Cross-origin credential-free `http` or `https` targets are cancelled in Electron and handed to the system browser. The application rejects `file:`, custom schemes, malformed URLs, and URLs containing credentials without opening them externally.

The bundled backend is a child process owned by the desktop application. It reports its exact loopback URL over a private process channel. Quit first requests an orderly backend shutdown, then falls back to complete process-tree termination: POSIX uses the detached process group with `SIGTERM` and bounded `SIGKILL` escalation, while Windows uses `taskkill /T /F`. Startup output is bounded and drained so backend logging cannot block the desktop process.
