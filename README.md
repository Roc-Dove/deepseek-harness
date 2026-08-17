# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness originally developed by [DeepSeek AI](https://deepseek.com).

This repository is a community fork. It keeps the upstream plugin architecture and adds self-contained Electron desktop packages, archived-session recovery, image-aware model and MCP flows, and an optional Vision Bridge.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Community fork highlights

- The packaging pipeline targets macOS Apple Silicon, macOS Intel, and Windows x64. Each packaged runtime includes Electron, the built backend, its production dependencies, and the Web frontend, without depending on a separately installed Node.js, pnpm, or source checkout.
- Archived sessions can be restored from Settings, with cross-tab ordering that prevents an older response from reverting a newer archive state.
- DeepSeek and text-only model routes retain controlled image descriptions, the optional Vision Bridge provides `describe_image`, and MCP image results persist as validated attachments.

## Desktop preview

The [desktop distribution workflow](https://github.com/Roc-Dove/deepseek-harness/actions/workflows/desktop-release.yml) builds each native package and smoke-tests its bundled backend with the packaged Electron executable. Successful pull-request runs provide unsigned evaluation artifacts; macOS and Windows may warn about or block them. Public downloads require platform code signing, and macOS downloads also require notarization. See the [desktop guide](apps/desktop/README.md) for installation, configuration, build, and release details.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/Roc-Dove/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Upstream community and support

- Use the upstream [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) for the base Harness project.
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
