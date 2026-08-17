# Agent Note: 私有 Electron 源码壳

Status: implemented

[English](2026-08-16-desktop-source-shell.md) | 中文

范围更新：本决策继续负责源码开发约定。自包含安装模式及其独立发布通道由[自包含桌面发行](2026-08-17-desktop-packaged-distribution.md)负责。

## 问题

开发者需要在原生窗口中承载已交付的 Web 应用，同时不建立第二套 UI 组装。Electron 入口也会带来机器级安装风险、特权外链处理和进程树所有权：package 生命周期脚本可以修改共享 Electron bundle，renderer 链接可以触达操作系统 URL handler，而只杀 pnpm 包装进程会遗留 `dsh web` 后端。

源码开发入口必须与桌面打包、签名、公证和独立运行时发行保持分离。若把该入口当作 npm 发布成员，dsh 族就会要求它采用无关的统一版本，并尝试发布一个源码模式离开仓库便无法运行的私有 package。

## 决策

在源码模式下，`apps/desktop` 是现有回环 Web 载体之上的私有源码仓库开发壳；该载体由 [GUI 分层决策](2026-07-19-gui-layering-and-rpc-protocol.md)描述。它从 `DSH_REPO_ROOT` 运行 `pnpm dsh web --port 0`，嵌入进程报告的回环 URL，并把隔离的 `DSH_HOME` 放在 Electron 应用用户数据目录下。这个模式要求仓库已安装依赖并完成构建；它既不是打包启动路径，也不是第二套 Host/Client 组装。操作约定见[桌面 README](../../../../apps/desktop/README.md)。

安装和启动不运行仓库自有的生命周期 hook。桌面壳不修改 `Electron.app`、Electron package 资源、应用元数据或用户 Desktop 下的启动器，也不覆盖 Electron 下载控制环境变量。运行时窗口与 Dock 图标仅使用 Electron API。

`DSH_DESKTOP_PATCHES` 是可选的非空路径 JSON 数组。启动器按数组顺序保留为可重复的 `dsh web --patch <path>` 选项，并在 spawn 前拒绝畸形输入。默认禁用的 Vision Bridge 及其他部署 overlay 因而具有可重复的桌面入口，桌面壳本身无需理解插件配置。

renderer 导航在使用前解析。同源 HTTP 导航与重定向留在现有主窗口；所有 `window.open` 请求均被拒绝，其中内部目标会重定向到主窗口，因此没有次级窗口可以绕过主窗口策略。`will-navigate` 与 `will-redirect` 共用一个 handler：只有不带凭据、语法有效且跨源的 `http:` 与 `https:` URL 会在 Electron 内取消，再传给 `shell.openExternal`。文件 URL、自定义 scheme、带凭据 URL 与畸形目标会被取消，且不会外部派发。

后端拥有一棵独立进程树。POSIX 上以 detached 方式启动 pnpm，先向整个进程组发送 `SIGTERM`，再对存活成员升级为 `SIGKILL`，并等待进程组消失。Windows 使用 `taskkill /T /F` 并等待根进程退出。重复退出路径共享同一个 stop promise，Electron 的 `before-quit` 会保持阻止状态直至该 promise 收敛。启动诊断只保留有界的输出尾部；找到回环 URL 后，累积数据的 listener 会被移除，而两路管道保持排空。启动后的进程 `error` 或意外 `exit` 只报告一次，并进入同一有序退出路径；退出已经开始后产生的事件保持静默。

`scripts/release/workspace-members.ts` 中的集中发布目录策略把 `apps/desktop` 命名为 local-only 应用。发布族发现、workspace constraints 和旧 npm-baseline packer 读取同一策略，因此桌面壳保持私有，其独立版本不进入 [npm 发布序列](../process/2026-08-10-npm-release-sequences.md)。

## 曾考虑的替代方案

**由 `postinstall` 或启动前 hook 修改已安装的 Electron 应用。** 拒绝，因为这会改变 package manager store 共享的依赖、破坏平台签名、覆盖操作者的下载控制，并可能写入仓库外路径。应用品牌化属于未来的打包与签名流程。

**随 dsh npm 族发布桌面壳。** 拒绝，因为其入口依赖 pnpm、源码仓库和已构建 workspace 产物。私有本地工具被显式排除，而不是为了一个它无法提供的产物暂时对齐版本。

**构建 Electron renderer-to-main IPC 载体。** 拒绝，因为已交付的 Web 载体已经提供完整应用和回环信任检查。打包发行保留该载体，子进程 IPC 只用于就绪通知与有序停止。

**只结束直接 pnpm 子进程。** 拒绝，因为 pnpm 把 CLI 作为后代进程启动，而且可能先于它退出；直接子进程状态不能证明自有进程树已经完全停稳。

## 结果

桌面壳复用完全相同的 Web 组装，并可应用显式本机 overlay，而安装过程没有仓库自有的机器修改。renderer 到操作系统的链接面是一份小型 HTTP(S) allowlist，窗口关闭则会在 Electron 退出前 join 后端进程树。

根 Vitest 会发现 `apps/desktop/tests/**/*.spec.ts`。runtime 与 main 集成测试覆盖 patch 解析和 argv 顺序、导航与重定向分类及接线、有界启动日志与管道排空、启动后的后端故障、单次启动、POSIX 升级、Windows 进程树结束和退出合并。发布族测试固定 local-only 目录与 pnpm 负 filter。

源码壳的代价是一份本地 Electron 依赖，运行时仍会创建应用用户数据目录。若强杀或缺失的 `taskkill` 无法证明进程已经结束，退出操作会明确失败，而不会声称清理成功。安装器组装、独立依赖、签名、公证、原生验证与发行 tag 不属于本决策，由打包发行决策负责。自动更新仍不存在。
