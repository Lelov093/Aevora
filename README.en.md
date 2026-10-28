# Aevora

[简体中文](README.md) | [English](README.en.md)

Aevora is a Personal AI in development, combining companion conversation with general agency. Chat with it or let it use tools to work within the permissions you grant.

## Current features

- Enter the local workspace and configure model providers and credentials in Settings.
- Use Azure Bloom alongside the native light and dark appearances.
- Navigate through the two-level sidebar and home entry.
- Read real session activity in the process overview or detailed trajectory. Search, fold, and locate turns in chronological history without restricting scrolling.
- Use native tools, session history, and persona configuration, with customizable history-compaction instructions.

Long-term memory, realtime voice, and autonomous social interaction are planned. Accounts, updates, command-line integration, product feedback, and answer ratings are placeholders; ratings do not enable learning. Search retains the DeepSeek official configuration, while other providers and custom endpoints are not connected.

## Run from source

This is a development source distribution, without a standalone installer. Prepare **Node.js 24.9 or newer** and **pnpm 11.28.5**.

```powershell
git clone https://github.com/Lelov093/Aevora.git
cd Aevora
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

After building, use `pnpm run start:web` for the Web interface. Initial installation or startup may download platform dependencies and the desktop runtime. Wait for terminal progress before starting another instance. Configure model credentials in the app; tool execution follows the selected permissions.

The public repository contains runtime source, required build files, and usage instructions, without preinstalled dependencies, personal configuration, or chat data.

## Source and licenses

Aevora is developed directly from the full [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) source at revision `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, using its Node.js, pnpm, Electron, React, and Cordis architecture.

The original [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and applicable licenses within dependency source are retained. Technical package names and upstream attribution remain intact. Aevora is not an official DeepSeek product.
