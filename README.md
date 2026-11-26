# KSTRL

**KSTRL** is an AI-native coding environment for Windows. Its agent, **Kestrel**, reads your project, edits files, and runs commands in a built-in terminal. It is powered by the Colossus models.

| Model | Tag | Best for |
| --- | --- | --- |
| **Colossus 2** | Fast | Quick edits, explanations, everyday questions |
| **Colossus 2.2 UC** | Ultracode | Heavy coding: refactors, multi-file changes, debugging |
| **Colossus 2.3** | Reasoning | Architecture, hard bugs, long agent runs |
| **Colossus 3** | Flagship | Maximum capability for the hardest work |

Effort levels (from kstrlsi): **Flash · Normal · High · Max**.

## Features

- **Agents home**: a chat-first start screen with projects, chat history, Getting Started, and a centered composer. Switch to the full editor with **IDE ↗** (`Ctrl+E`).
- **Kestrel Agent panel** (`Ctrl+I`). Use **Agent** mode to read, write and edit files and run commands, or **Ask** mode for read-only answers. Kestrel streams its thought process and shows every tool call as a card.
- **Change review.** Every file Kestrel touches gets a +/- diffstat and a side-by-side diff. You can **Revert all** for any run.
- **Command approval.** Kestrel asks before it runs a terminal command. You can turn on auto-run in Settings.
- **Inline edit** (`Ctrl+K`). Select some code, describe the change, then Accept or Reject it.
- **Add to chat** (`Ctrl+L`). Sends the current selection or file to Kestrel. You can also type `@` to attach files, or drag them in from the Explorer.
- **Monaco editor** with the KSTRL dark theme, tabs, a minimap, sticky scroll and bracket colorization.
- **Integrated terminal** (`Ctrl+``). It runs a real PowerShell through ConPTY, and you can open several terminals.
- **Explorer** (create, rename, delete, reveal), **Find in Files** (`Ctrl+Shift+F`), **Quick Open** (`Ctrl+P`) and a **Command Palette** (`Ctrl+Shift+P`).
- **Sandboxed workspace.** Every path the agent touches stays inside the open folder, and links that point outside it are blocked.

## Setup

1. Install and launch KSTRL.
2. In the **Getting Started** card, click **Connect Unsloth Server**. You can also open Settings (`Ctrl+,`) → **Model Server**.
3. Enter your Unsloth server's URL, plus an API key if your server needs one, then click **Test connection**.
4. Choose which server model powers each Colossus model. "Server default" uses the first model the server lists.
5. Start a chat on the Agents home screen, or open the **IDE** (`Ctrl+E`).

KSTRL talks to the server's OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`) with streaming and tool calling. It also understands `<think>` reasoning blocks and `reasoning_content`, and shows both as Kestrel's thought process.

You can also use the Anthropic API instead: Settings → Model Server → **Anthropic API**.

## Develop

```bash
npm install
npm run dev        # Vite + Electron with hot reload
```

## Build the Windows app

On Windows:

```bash
npm run dist:win   # → release/KSTRL-Setup-1.0.0.exe (installer) + release/KSTRL-1.0.0-Portable.exe
```

You can also run the **Build Windows** GitHub Action from the Actions tab, or push a `v*` tag. It builds both `.exe` files on `windows-latest` and attaches them to the run, or to the GitHub Release when you push a tag.

To regenerate the app icon from `build/logo.png`, run `npm run icons`.

## Releasing updates

Installed copies of KSTRL update themselves from this repo's GitHub Releases. They check at launch and every 4 hours, download in the background, and show **Restart to update**.

1. Bump `version` in `package.json` (for example `1.0.1`), commit and push.
2. Go to **Actions → Build Windows → Run workflow**, leave **publish** checked, and run it. You can also push a matching `v1.0.1` tag instead.
3. The action builds the installer on Windows and publishes release `v1.0.1`. Users get the update automatically.

Only the installed version (`KSTRL-Setup-x.y.z.exe`) can auto-update. The portable `.exe` can't replace itself.

## Project layout

```
electron/   main process: window, IPC, settings, workspace sandbox, terminal (node-pty), Kestrel agent loop
src/        renderer (React): editor, explorer, search, terminal, agent panel, palette, settings
build/      icons + logo used for packaging
```
