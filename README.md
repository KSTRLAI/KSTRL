# KSTRL

**KSTRL** is an AI-native coding environment for Windows. Its agent, **Kestrel**, reads your project, edits files, and runs commands in a built-in terminal. It is powered by the Colossus models.

| Model | Best for |
| --- | --- |
| **Colossus 2** | Quick edits, explanations, everyday questions |
| **Colossus 2.1** | Balanced speed and quality for everyday coding. Plan mode always uses it. |
| **Colossus 2.2** | Stronger coding and reasoning for larger tasks |
| **Colossus 3** (Flagship) | Maximum capability for the hardest work |
| **Colossus 2.2 UC** | Heavy coding. It isn't in the model picker; it runs when you set the effort to **UltraCode**, which the UI shows as an effort level |

Effort levels: **Flash · Normal · High · Max · UltraCode**.

Modes: **Build** (edits files and runs commands), **Plan** (brainstorm and plan, read-only, on Colossus 2.1) and **Ask** (read-only answers).

## Daily usage

Each request costs credits = (input tokens + 3 × output tokens) / 1000 × model weight × mode weight. Free gets 2,500 credits a day and KSTRL MAX gets 20× that (50,000). When they run out, chat is paused until midnight (local time). Weights live in `electron/models.cjs`:

- Modes: Build 1×, Plan 0.5×, Ask 0.35×
- Models: Colossus 2 0.5×, 2.1 1×, 2.2 1.6×, UltraCode 2.5×, Colossus 3 4×

The plan is stored in the local settings file and the renderer can't change it. There is no billing yet, so the Upgrade buttons open the website.

## Features

- **Agents home**: a chat-first start screen with projects, chat history, Getting Started, and a centered composer. **IDE ↗** (`Ctrl+E`) opens the editor in its own window, with Open project, Clone repo and Connect via SSH on its start screen.
- **Model picker**: Colossus 3, 2.2, 2.1 and 2, with number-key shortcuts. **Effort** (including UltraCode) and **More models** (Auto) are submenus. The button shows the model and the effort, e.g. "Colossus 3 High".
- **Automations**: saved prompts that Kestrel runs on demand, at startup, hourly, daily or on weekdays while KSTRL is open.
- **Settings** (`Ctrl+,`) is a full page with search. Tabs: General, Appearance, Plan & Usage, Agents, Models, Keyboard Shortcuts and About.
- **Kestrel Agent panel** (`Ctrl+I`). Use **Build** mode to read, write and edit files and run commands, **Plan** to brainstorm a plan first, or **Ask** for read-only answers. Kestrel streams its thought process and shows every tool call as a card.
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
npm run dist:win   # → release/KSTRL-Setup.exe (installer) + release/KSTRL-Portable.exe
```

You can also run the **Build Windows** GitHub Action from the Actions tab, or push a `v*` tag. It builds both `.exe` files on `windows-latest` and attaches them to the run, or to the GitHub Release when you push a tag.

To regenerate the app icon from `build/logo.png`, run `npm run icons`.

## Releasing updates

Installed copies of KSTRL update themselves from this repo's GitHub Releases. They check at launch and every 4 hours, download in the background, and show **Restart to update**.

1. Bump `version` in `package.json` (for example `1.0.1`), commit and push.
2. Go to **Actions → Build Windows → Run workflow**, leave **publish** checked, and run it. You can also push a matching `v1.0.1` tag instead.
3. The action builds the installer on Windows and publishes release `v1.0.1`. Users get the update automatically.

Only the installed version (`KSTRL-Setup.exe`) can auto-update. The portable `.exe` can't replace itself.

## Project layout

```
electron/   main process: window, IPC, settings, workspace sandbox, terminal (node-pty), Kestrel agent loop
src/        renderer (React): editor, explorer, search, terminal, agent panel, palette, settings
build/      icons + logo used for packaging
```

The installer always has the same name, so this link always downloads the newest version (handy for the website):
https://github.com/KSTRLAI/KSTRL/releases/latest/download/KSTRL-Setup.exe
