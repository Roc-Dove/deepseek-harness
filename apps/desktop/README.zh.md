# DeepSeek Harness Desktop

[English](README.md) | 中文

这是一个仅供源码仓库开发使用的 Electron 外壳，不是已打包的桌面应用。它从指定的 Harness 源码仓库启动 `pnpm dsh web --port 0`，把只监听 `127.0.0.1` 的页面装进原生窗口；运行环境必须已经具备 Node.js、pnpm、仓库依赖与所需构建产物。

## 启动

在仓库根目录准备依赖和构建产物，然后启动：

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

也可以在本目录执行 `pnpm dev`。`DSH_REPO_ROOT` 可指向另一个已经安装依赖并完成构建的 Harness 源码仓库；未设置时使用当前仓库根目录。

外壳把独立的 `DSH_HOME` 放在 Electron 的应用用户数据目录下。它不会修改 `Electron.app`、Electron 包内文件或桌面启动器；依赖安装完全遵循 Electron 包本身的安装选项，包括 `ELECTRON_SKIP_BINARY_DOWNLOAD`。

## 配置补丁

`DSH_DESKTOP_PATCHES` 是一个 JSON 字符串数组。数组中的每个路径按顺序转换成 Web 子命令的一个 `--patch <path>`，相对路径以 `DSH_REPO_ROOT` 为基准；空值表示不加补丁，非法 JSON、非数组或空路径会在启动前明确报错。

```sh
DSH_DESKTOP_PATCHES='["./local/vision-bridge.patch.yml","./local/desktop.patch.yml"]' pnpm run desktop:dev
```

Vision Bridge 的随附行默认禁用。部署者先配置一个声明 `image` 输入的视觉模型路由，再通过补丁显式启用，例如：

```yaml
- id: vision-bridge
  disabled: false
  config:
    provider: my-vision-provider
    model: my-vision-model
```

补丁文件属于本机部署配置；其中若包含服务地址、凭据引用或其他私有设置，不应提交到仓库。

## 安全与生命周期

同源的 `http` 页面导航与重定向留在当前主窗口；`window.open` 不会创建缺少同等策略的次级窗口。直接导航与服务端重定向使用同一规则：不带 URL 用户名或密码的异源 `http`/`https` 目标会在 Electron 内取消，再交给系统浏览器。`file:`、自定义 scheme、畸形 URL 和带凭据地址都会被取消，且不会外开。

外壳在 POSIX 上把 pnpm/dsh 启动为独立进程组，退出时先向整组发送 `SIGTERM`，超时后发送 `SIGKILL` 并等待进程组消失；Windows 使用 `taskkill /T /F` 结束整棵树。重复的窗口关闭和退出事件共享同一次清理。

启动期间，外壳只保留有界的后端输出尾部用于诊断。识别出回环 URL 后，它会移除累积日志的监听器，并继续排空两路输出管道，避免后端日志写满后阻塞。启动成功后的意外进程错误或退出会明确展示，并进入同一套有序进程树清理；已经开始的正常退出所产生的事件不会被误报为故障。

## 发行限制

本目录的 package 保持 `private: true`，并明确排除在 dsh npm release family 和旧的 npm baseline 打包流程之外。仓库没有 Electron 安装器、代码签名、公证、自动更新或独立运行时封装；`icon.icns` 与 `icon.ico` 仅是未来打包可能使用的素材。完成这些发行能力之前，只把本目录视为源码开发工具。
