# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This is an Electron shell for development from a source checkout, not a packaged desktop application. It starts `pnpm dsh web --port 0` from the selected Harness source repository and hosts the loopback-only `127.0.0.1` page in a native window. The environment must already provide Node.js, pnpm, installed repository dependencies, and the required build outputs.

## Start

Prepare dependencies and build outputs from the repository root, then start the shell:

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

You can also run `pnpm dev` from this directory. `DSH_REPO_ROOT` can point to another Harness source repository whose dependencies and build outputs are ready; when unset, it uses the current repository root.

The shell stores its isolated `DSH_HOME` under Electron's application user-data directory. It does not modify `Electron.app`, files inside the Electron package, or desktop launchers. Dependency installation follows Electron's standard install controls, including `ELECTRON_SKIP_BINARY_DOWNLOAD`.

## Configuration patches

`DSH_DESKTOP_PATCHES` is a JSON string array. Each path becomes one ordered `--patch <path>` option on the Web subcommand. Relative paths resolve from `DSH_REPO_ROOT`; an empty value applies no patches, while malformed JSON, a non-array value, or an empty path fails explicitly before startup.

```sh
DSH_DESKTOP_PATCHES='["./local/vision-bridge.patch.yml","./local/desktop.patch.yml"]' pnpm run desktop:dev
```

The shipped Vision Bridge row is disabled by default. An operator must first configure a vision-model route that declares `image` input, then explicitly enable the row through a patch, for example:

```yaml
- id: vision-bridge
  disabled: false
  config:
    provider: my-vision-provider
    model: my-vision-model
```

Patch files are local deployment configuration. Do not commit them when they contain service endpoints, credential references, or other private settings.

## Security and lifecycle

Same-origin `http` navigation and redirects stay in the existing main window, and `window.open` never creates a secondary window without equivalent policy. Direct navigation and server redirects use the same rule: cross-origin `http` or `https` targets without a URL username or password are cancelled in Electron and handed to the system browser. The shell cancels `file:`, custom schemes, malformed URLs, and URLs containing credentials without opening them externally.

On POSIX, the shell starts pnpm/dsh as a detached process group. During shutdown it sends `SIGTERM` to the whole group, escalates to `SIGKILL` after the grace period, and waits for the group to disappear. On Windows it terminates the complete tree with `taskkill /T /F`. Repeated window-close and quit events share one cleanup operation.

During startup the shell retains only a bounded tail of backend output for diagnostics. Once it recognizes the loopback URL, it removes the accumulating listeners and continues draining both output pipes so backend logging cannot block. An unexpected backend process error or exit after startup is reported visibly and enters the same orderly tree cleanup; events caused by an already-started shutdown are not reported as failures.

## Release limitations

This directory's package remains `private: true` and is explicitly excluded from both the dsh npm release family and the legacy npm baseline pack flow. The repository provides no Electron installer, code signing, notarization, automatic updates, or standalone runtime bundle. `icon.icns` and `icon.ico` are only assets that a future packager might use. Until those release capabilities exist, treat this directory only as a source development tool.
