# Aevora

[简体中文](README.md) | English

Aevora is a desktop AI assistant. Chat by text or voice, define the assistant's character, manage long-term memory, and let it search the web or use workspace tools within the permissions you choose.

## Run from source

Install Git, **Node.js 24.9.0 or later**, **pnpm 11.28.5**, and the Rust toolchain. On Windows, install the MSVC C++ build tools and Windows SDK for native components. The first installation may download the desktop runtime and platform dependencies.

Run these commands in PowerShell.

```powershell
git clone https://github.com/Lelov093/Aevora.git
cd Aevora
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

After building, run `pnpm run start:desktop` to open Aevora and close the Aevora window to quit. For the browser interface, run `pnpm run start:web` and open the local URL printed in the terminal.

The default Desktop source launcher stores settings and sessions under `apps/desktop/.desktop-build/development/home`. Reuse the same checkout and launch command to keep that configuration. Set up your own services in the app on first use.

## Start a conversation

1. Open the workspace and go to **Settings → Models**.
2. Choose DeepSeek or add a compatible provider. Enter the model, API endpoint, and API key for that provider. For a local model, start a compatible inference server on your machine and enter its API address and model ID.
3. Select the conversation model, open a chat, and send a message. Tools run in the current workspace with the selected permissions. Store credentials through the app settings.

## Features

| Feature | How to use it |
| --- | --- |
| Character card | After enabling the Aevora plugins, edit the assistant's identity, style, and boundaries in **Settings → Aevora character card**. New sessions capture the active version. |
| Memory and Conscious Space | Open **Plugins → Aevora** to manage Memory and Conscious Space. Conscious Space lets you browse session traces, context, and replay. |
| Dictation | Enable **Voice Input** and prepare a speech recognition provider. Click the microphone next to the composer. Finishing inserts text into an editable draft. For local dictation, prepare SenseVoice from the plugin details. |
| Live voice chat | Set up streaming recognition and speech synthesis in **Settings → Voice** and prepare the local turn model when prompted. With an empty composer, click the voice chat button. Voice settings control listening during replies. You can type or end voice chat at any time. |
| Web search | Open **Settings → Web search** to configure DeepSeek, Exa, Perplexity, or Tavily. For Tavily, add a named configuration with its endpoint and API key, then explicitly select the default search configuration. |
| Session management | Archive chats from the session menu. Eligible host-managed sessions offer a deletion preview and permanent deletion. Sessions in legacy storage may offer archiving only. |

Cloud voice can send audio or text to your selected service and incur charges.

## Enable the Aevora plugins

1. Start Desktop once, then quit.
2. Open `profiles/desktop/cordis.patch.yml` under the `DSH_HOME` shown in the terminal. With the default source launcher, `DSH_HOME` is `apps/desktop/.desktop-build/development/home`.
3. For an empty file, copy the entire sample. With existing settings, append its `insert` block as another YAML list item and reuse entries that already have the same ID. [Aevora plugin configuration sample](apps/cli/config/examples/aevora-desktop.cordis.yml)
4. Run `pnpm run start:desktop` and manage the features in **Plugins → Aevora**.

## Origins and licensing

Aevora builds on DeepSeek Harness and Cordis and retains the original MIT license and third-party notices. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
