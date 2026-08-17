# Agent Note: Self-contained desktop distribution

Status: implemented

English | [中文](2026-08-17-desktop-packaged-distribution.zh.md)

## Problem

The [desktop source shell](2026-08-16-desktop-source-shell.md) gives developers a native window over the shipped Web carrier, but it starts pnpm from an installed and built checkout. That is not a product a user can download and open. A distributable desktop application must carry the exact backend, Web assets, runtime dependencies, and platform-native modules that were verified together, without reaching into the build machine's checkout or asking the user to install Node.js.

A binary release adds two boundaries the source shell did not own. First, packaging must distinguish reviewed application defaults from machine-local state: the builder's credentials, `DSH_HOME`, sessions, patches, checkout path, and Node injection environment must not enter or redirect an installed application. Second, an artifact that merely launches on the build machine is not ready for public download. macOS distribution must cover both Apple Silicon and Intel and pass Developer ID signing and notarization; Windows x64 must be signed. Those operations require protected credentials that cannot be exposed to fork pull requests.

The desktop application remains an implementation detail of this repository rather than an npm library. Coupling installers to the dsh npm family would mix an operating-system artifact, independent version, signing ceremony, and GitHub Release with a registry sequence that publishes workspace packages.

## Decision

`apps/desktop` has two explicit launch modes over the same loopback Web carrier. Source mode preserves `pnpm run desktop:dev`, starts `pnpm dsh web --port 0` from a prepared checkout, and may consume ordered `DSH_DESKTOP_PATCHES`. Packaged mode starts the bundled `lib/bin.js` with Electron's executable in Node mode, from an application-owned workspace. It therefore needs neither a system Node executable nor pnpm. The backend reports its canonical `127.0.0.1` URL over child-process IPC; the text-output detector remains a source-mode compatibility path.

Packaging first builds the repository, then stages the desktop manifest and a production-only deployment closure. The backend and built Web frontend are copied under the application's resources; Electron application code stays in the application archive. Native dependencies are taken from the same operating system and architecture that produces the installer. The build does not rebuild or cross-copy native modules for another target. Release and staging output lives only below `.artifacts/desktop/`, and the installed-runtime verification drives the packaged CLI and loopback Web startup rather than resolving files from the checkout.

The private desktop manifest is deliberately the dependency-only `pnpm deploy` root. Its production dependencies describe the providers and non-optional peers required by the assembled backend even though the Electron shell does not import them directly. The desktop-scoped Knip exception records that manifest-level use; staging and artifact verification still traverse the deployed runtime graph and reject a missing dependency.

Packaged resources are immutable, so packaged mode does not mount the source-oriented live patch/HMR watchers. It still composes reviewed defaults and application-owned configuration during startup; watcher-dependent file changes take effect on the next launch. Source mode retains the live-watch contract.

Packaged state is new and application-owned. Electron's user-data directory contains an isolated `DSH_HOME` plus a workspace directory used as the backend current working directory. The package never includes a build machine's existing user data, credentials, sessions, local patch files, or checkout paths. Before spawn, packaged mode removes `DSH_REPO_ROOT`, `DSH_DESKTOP_PATCHES`, `NODE_OPTIONS`, and `NODE_PATH`; it supplies its own `DSH_HOME` and deployment marker. Installed releases have no `--patch` entry. Vision Bridge consequently ships disabled, like the reviewed repository default, until a user configures a compatible image-input route and explicitly enables it through product configuration.

The window and process ownership rules from the source-shell decision apply unchanged. Renderer navigation uses the narrow HTTP(S) policy. The desktop process owns the backend tree, requests an orderly shutdown over IPC, and falls back to bounded platform tree termination. IPC readiness accepts only the exact message shape and a credential-free root URL whose host is `127.0.0.1` and whose port is valid.

Desktop distribution is its own binary release lane:

| Target | Native builder | Public artifact requirement |
|---|---|---|
| macOS arm64 | Apple Silicon macOS runner | Developer ID signature and Apple notarization |
| macOS x64 | Intel macOS runner | Developer ID signature and Apple notarization |
| Windows x64 | Windows x64 runner | Windows code signature |

Pull requests and non-publishing manual runs build and verify all three targets without release secrets. Their unsigned artifacts are retained only as test evidence. A `desktop-v<version>` tag must equal the private desktop package version before signed jobs can enter the protected `desktop-release` environment. Those jobs rebuild natively with platform credentials, verify the resulting runtime, and publish DMG, ZIP, and installer files with per-target build manifests and `SHA256SUMS` to one GitHub Release. The macOS legs also require a valid deep code-signature check, Gatekeeper assessment, and stapled notarization ticket on the packaged application; the Windows leg requires valid Authenticode status on the unpacked main executable, installer, and any standalone uninstaller the packager materializes. Checkout credentials are not persisted, the workflow defaults to read-only repository permission, and only the final release job receives `contents: write`. Signed jobs cannot run for pull-request events, so a fork contribution cannot reach signing or notarization secrets.

The desktop package remains `private: true` and excluded from the [dsh npm release sequence](../process/2026-08-10-npm-release-sequences.md). Its version changes deliberately on its own line, and its release tag is `desktop-v<version>`. There is no automatic updater: a user explicitly installs a newer signed release.

## Alternatives considered

**Require users to run the source shell.** Rejected because it requires a checkout, Node.js, pnpm, installed dependencies, build outputs, and terminal knowledge. It remains the development entry, not the release product.

**Publish the desktop package to npm and install Electron on first run.** Rejected because that still delegates runtime acquisition and native dependency selection to the user's machine, does not create an operating-system installer, and entangles the desktop version with the dsh package family.

**Bundle a separate Node distribution.** Rejected because Electron already carries a compatible Node runtime. Starting the bundled CLI through Electron's executable in Node mode removes a second runtime download while retaining the existing Host and Web assembly.

**Cross-build every target from macOS.** Rejected because the production closure includes platform-native dependencies and because code signing, notarization, and installed-runtime verification are platform operations. Each artifact is built and verified on its target operating system and architecture.

**Copy the developer's `DSH_HOME` or patch into the image so the release looks preconfigured.** Rejected because it would distribute sessions, credentials, endpoints, local paths, and mutable machine state. The reproducible product is the reviewed code and default configuration; user data starts empty and remains outside the application image.

**Enable automatic updates in the first installer release.** Rejected because it adds an update feed, update-key ownership, rollback and downgrade policy, and another privileged network path. Signed manual installation is the smaller first release contract.

**Treat an unsigned DMG or executable as a public release.** Rejected because a successful build is not platform trust. Unsigned outputs are useful for CI rehearsal and local packaging tests only; public delivery is gated on signing, plus notarization on macOS.

## Consequences

A downloaded installer now contains the runtime needed to present the same Web composition that developers exercise from source. A clean machine can install and start it without Node.js, pnpm, a checkout, or a terminal. The boundary is reproducible: packaged verification uses files within the artifact, and local developer state is neither copied nor inherited into the installed backend.

The release owner must maintain three native build legs, a protected `desktop-release` environment, one Windows signing identity, and Apple Developer ID and notarization API credentials. Certificates and API keys are operational dependencies, not repository content. Losing or rotating them pauses public releases but does not prevent unsigned pull-request rehearsal.

Installer size is larger than the source shell because Electron, the backend dependency closure, native modules, and Web assets are all included. Platform and architecture artifacts can differ and must not overwrite one another in a release. The workflow records checksums so the downloaded bytes can be verified independently.

The installed application begins with repository defaults, including disabled Vision Bridge, and with a new application-owned data directory. Existing source-development patches do not carry over to it. Users must migrate or reconfigure product state intentionally. Updates are manual until a separate decision defines update signing, feed ownership, rollback, and compatibility policy.
