# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是最初由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

本仓库是社区 fork，在保留上游插件架构的基础上，增加了自包含 Electron 桌面安装包、归档会话恢复、支持图片的模型与 MCP 流程，以及可选的 Vision Bridge。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 社区 fork 功能

- 打包流水线支持 macOS Apple Silicon、macOS Intel 与 Windows x64。每个平台的打包运行时均内含 Electron、构建完成的后端、生产依赖与 Web 前端，不依赖另行安装的 Node.js、pnpm 或源码仓库。
- 可以从设置中恢复归档会话；跨标签页排序会阻止较旧响应回滚较新的归档状态。
- DeepSeek 与纯文本模型路由会保留受控图片描述；可选 Vision Bridge 提供 `describe_image`；MCP 图片结果会作为经过验证的附件持久化。

## 桌面预览版

[桌面发行 workflow](https://github.com/Roc-Dove/deepseek-harness/actions/workflows/desktop-release.yml) 会在各原生平台构建打包产物，并使用其中的 Electron 可执行文件对内置后端做 smoke test。成功的拉取请求运行会提供未签名评估产物，macOS 与 Windows 可能警告或阻止其运行。公开下载件必须完成平台代码签名，macOS 下载件还必须通过公证。安装、配置、构建与发布说明见[桌面指南](apps/desktop/README.md)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/Roc-Dove/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 上游社区与支持

- 与基础 Harness 项目有关的讨论，请使用上游 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
