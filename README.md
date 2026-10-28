# Aevora

[简体中文](README.md) | [English](README.en.md)

Aevora 是一款正在开发的个人 AI，结合伙伴交流与通用事务处理能力。你可以与它聊天，也可以让它在授权范围内使用工具完成工作。

## 当前功能

- 本地进入工作区，在设置中配置模型提供方和凭据。
- Azure Bloom 独立外观，以及原生浅色、深色外观。
- 双层导航与主页入口。
- 过程概览和详细轨迹：查看真实会话记录，搜索、折叠并通过轮次索引定位；历史按从早到晚排列，可自由滚动。
- 支持原生工具、会话历史和人格配置，并可调整上下文压缩指令。

长期记忆、实时语音和自主社交仍在规划中。账号、更新、命令行工具、产品反馈与回答评价目前为占位，评价尚未用于学习。联网搜索只保留已接入的 DeepSeek 官方配置，其他提供方和自定义端点尚未接入。

## 从源码运行

当前提供源码开发版，未提供独立安装包。请先准备 **Node.js 24.9 或更新版本**和 **pnpm 11.28.5**。

```powershell
git clone https://github.com/Lelov093/Aevora.git
cd Aevora
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

构建后也可运行 `pnpm run start:web` 使用 Web 界面。首次安装或启动可能需要下载平台依赖和桌面运行时；请等待终端提示，不要重复启动。模型凭据通过应用设置配置，工具执行仍受所选权限约束。

公开仓库只提供运行源码、必要构建文件与使用说明，不包含预装依赖、个人配置或聊天数据。

## 来源与许可

Aevora 直接基于完整 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 源码二次开发，底座 revision 为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，沿用 Node.js、pnpm、Electron、React 与 Cordis 架构。

原始 [MIT 许可](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)及依赖源码中的适用许可均予保留。技术包名和上游来源保持真实；Aevora 不是 DeepSeek 官方产品。
