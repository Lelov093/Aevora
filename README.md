# Aevora

简体中文 | [English](README.en.md)

Aevora 是一款桌面 AI 助手。你可以用文字或语音对话、为助手设置角色、管理长期记忆，并在授权范围内让它搜索网页或使用工作区工具。

## 从源码启动

请准备 Git、Node.js **24.9.0 或更新版本**、pnpm **11.28.5** 和 Rust 工具链。Windows 还需要 MSVC C++ 生成工具和 Windows SDK，用于编译原生组件。首次安装可能下载桌面运行时和平台依赖。

在 PowerShell 中运行以下命令。

```powershell
git clone https://github.com/Lelov093/Aevora.git
cd Aevora
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

构建完成后，日常打开用 `pnpm run start:desktop`，退出时关闭 Aevora 窗口。想在浏览器中体验时，用 `pnpm run start:web`，并打开终端给出的本地地址。

默认源码 Desktop 把配置和会话存放在 `apps/desktop/.desktop-build/development/home` 下。持续使用同一个 checkout 和启动命令即可沿用之前的配置。首次使用时，在应用中配置自己的服务。

## 第一次对话

1. 进入工作区，打开 **设置 → 模型**。
2. 选择 DeepSeek，或添加已有的兼容提供方。按提供方填写模型、API 端点和 API Key。使用本地模型时，先在本机启动兼容的推理服务，再填写 API 地址与模型 ID。
3. 选择对话模型，新建会话并发送一条消息。工具按当前工作区和所选权限运行。请通过应用设置管理凭据。

## 主要功能

| 功能 | 如何使用 |
| --- | --- |
| 角色卡 | 启用 Aevora 插件后，在 **设置 → Aevora 角色卡** 编辑助手的身份、表达方式和边界。新会话会捕获当前生效版本。 |
| 记忆与意识空间 | 在 **插件 → Aevora** 管理记忆与意识空间。意识空间可以浏览会话轨迹、当前上下文和回放。 |
| 听写 | 启用 **语音输入** 插件并准备所选识别服务。在输入框旁点击麦克风，完成后，文字回填到可编辑草稿。听写支持本地 SenseVoice，可从插件详情准备模型。 |
| 实时语音 | 在 **设置 → 语音** 配置流式识别和语音合成，按提示准备本地轮次资源。清空输入框后点击语音聊天。可设置回复时继续收音，语音期间仍可输入文字或随时结束。 |
| 联网搜索 | 在 **设置 → 联网搜索** 配置 DeepSeek、Exa、Perplexity 或 Tavily。添加 Tavily 时，填写名称、端点和 API Key，再显式选择默认搜索配置。 |
| 会话管理 | 在会话菜单归档会话。符合 Host 托管条件的会话可以预览影响范围并确认永久删除。旧存储下的会话可能只提供归档。 |

云语音按所选服务上传音频或待合成文字，可能产生用量费用。

## 启用 Aevora 插件

1. 启动过 Desktop 后退出应用。
2. 进入终端显示的 `DSH_HOME`，打开 `profiles/desktop/cordis.patch.yml`。使用默认启动命令时，`DSH_HOME` 位于本仓库的 `apps/desktop/.desktop-build/development/home`。
3. 文件为空时复制整份配置示例。文件已有配置时，将示例的 `insert` 段作为新 YAML 列表项添加，并复用已有的同 ID 条目。[Aevora 插件配置示例](apps/cli/config/examples/aevora-desktop.cordis.yml)
4. 运行 `pnpm run start:desktop`，在 **插件 → Aevora** 管理各项能力。

## 来源与许可

Aevora 基于 DeepSeek Harness 和 Cordis 架构开发，保留原始 MIT 许可和第三方声明。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [MIT 许可](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
