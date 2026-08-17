# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 把现有的回环 Web 应用打包成原生桌面应用。发行安装包内含 Electron、构建完成的 Harness 后端、后端的生产依赖闭包与 Web 前端。用户安装发行版后，不需要 Node.js、pnpm、源码仓库或终端；打开应用就会在 `127.0.0.1` 启动内置后端，并在一个原生窗口中显示。

## 安装发行版

按电脑的操作系统和架构选择产物：

- macOS Apple Silicon：`macos-arm64` DMG 或 ZIP；
- macOS Intel：`macos-x64` DMG 或 ZIP；
- Windows x64：`windows-x64` 安装程序。

macOS 上打开 DMG，把应用移入“应用程序”；Windows 上运行安装程序。公开的 macOS 产物必须用 Developer ID 证书签名并通过 Apple 公证；公开的 Windows 产物必须完成代码签名。由拉取请求 CI 上传或本机生成的未签名产物只用于测试，不是公开下载件，操作系统可能阻止或警告其运行。

首次启动会在 Electron 的用户数据目录下创建全新的应用专属 `DSH_HOME` 与工作区。安装包不会包含或导入构建者本机的 `DSH_HOME`、凭据、会话、补丁文件、源码路径或环境配置。卸载后重新安装应用本身不承诺删除该用户数据目录。

当前安装版没有自动更新器。发布新的签名版本后，需要用户主动安装。

## 安装版配置

安装版刻意从仓库默认配置启动。尤其是随附的 Vision Bridge 行默认禁用；用户必须先配置一个声明 `image` 输入的视觉模型路由，并显式启用该行，`describe_image` 才可用。

打包后的启动器会从后端环境中移除 `DSH_REPO_ROOT`、`DSH_DESKTOP_PATCHES`、`NODE_OPTIONS` 与 `NODE_PATH`。这样，下载的应用不会被重定向到某个源码仓库，不会加载宿主注入的 Node 代码，也不会悄悄继承开发者的本机补丁。因此安装版不提供 `--patch` 入口。产品配置应放在应用专属用户数据中，发行默认值应留在经过审查的源码中。

安装资源不可变，因此打包模式不会挂载面向源码的实时补丁/HMR watcher。经过审查的默认值和应用专属配置仍会在启动时加载；依赖这些 watcher 的文件级变更会在应用重启后生效。源码开发模式继续保留现有的实时监听行为。

## 从源码开发

源码开发入口继续保留，并刻意采用另一套启动约定：

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

它从当前源码仓库启动 `pnpm dsh web --port 0`。`DSH_REPO_ROOT` 可以选择另一个已经安装依赖并构建完成的 Harness 仓库。`DSH_DESKTOP_PATCHES` 是 JSON 字符串数组，其中的路径按顺序转成 `--patch <路径>`；相对路径以 `DSH_REPO_ROOT` 为基准，非法 JSON、非数组值或空路径会在启动前失败。

```sh
DSH_DESKTOP_PATCHES='["./local/vision-bridge.patch.yml","./local/desktop.patch.yml"]' pnpm run desktop:dev
```

补丁文件属于本机部署配置；如果含有服务地址、凭据引用或其他私有设置，不要提交。它们绝不会复制进安装包。

## 构建与验证安装包

必须在目标操作系统和架构上构建；桌面运行时包含原生依赖，不做跨平台交叉构建：

```sh
pnpm run desktop:dist:mac
pnpm run desktop:dist:win
pnpm run desktop:verify
```

打包前先运行根构建，只暂存发行形状的生产依赖闭包，并把一次性暂存与发行输出写到 `.artifacts/desktop/` 下。验证针对打包后的运行时执行，不借用源码仓库。

`apps/desktop` 保持 `private: true`，继续排除在 dsh npm 发布族之外。桌面二进制使用本 package 自己的版本、`desktop-v<版本>` tag 和 `desktop-release.yml` workflow。拉取请求会在不接触发布凭据的情况下构建并验证未签名的 macOS arm64、macOS x64 与 Windows x64 产物。`desktop-v<版本>` tag，或从该 tag 发起的发布型手动运行，会进入受保护的 `desktop-release` environment，要求平台签名及 macOS 公证凭据，在原生平台重新构建并验证，再把安装包、逐目标构建清单和 `SHA256SUMS` 发布到 GitHub Release。

上传前，macOS 签名 job 会通过 `codesign`、Gatekeeper 评估和已装订公证票据来验证应用。Windows 签名 job 要求解包应用、安装程序，以及 packager 实际产出的任何独立卸载程序都具有有效 Authenticode 签名。

受保护环境需要这些 secrets：

- macOS 签名：`DESKTOP_MAC_CSC_LINK` 与 `DESKTOP_MAC_CSC_KEY_PASSWORD`；
- Apple 公证 API：`DESKTOP_APPLE_API_KEY_ID`、`DESKTOP_APPLE_API_ISSUER`，以及放在 `DESKTOP_APPLE_API_KEY_P8_BASE64` 中的 base64 编码密钥；
- Windows 签名：`DESKTOP_WIN_CSC_LINK` 与 `DESKTOP_WIN_CSC_KEY_PASSWORD`。

来自 fork 的拉取请求永远不会进入签名 job，也拿不到这些 secrets。启用公开发布前，应为 `desktop-release` environment 配置必要审批人与 tag 限制。

## 安全与生命周期

同源 `http` 导航与重定向留在现有主窗口中，`window.open` 不会创建缺少同等策略的次级窗口。不带凭据的异源 `http` 或 `https` 目标会在 Electron 内取消，再交给系统浏览器。应用会拒绝 `file:`、自定义 scheme、畸形 URL 与带凭据 URL，且不会把它们外部打开。

内置后端是桌面应用拥有的子进程，通过私有进程通道报告准确的回环 URL。退出时先请求后端有序停止，再回退到整棵进程树结束：POSIX 使用独立进程组，先发 `SIGTERM`，超时后在有限等待内升级为 `SIGKILL`；Windows 使用 `taskkill /T /F`。启动输出有界且会持续排空，因此后端日志不会阻塞桌面进程。
