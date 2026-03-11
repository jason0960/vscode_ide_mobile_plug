# Mobile Copilot Remote

> Control GitHub Copilot from your phone — the **real** agent with full file editing, terminal access, git operations, and streaming responses, all from a mobile browser. **$0 additional cost.**

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%3E%3D1.95.0-blue" alt="VS Code version" />
  <img src="https://img.shields.io/badge/GitHub%20Copilot-Required-green" alt="Copilot required" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
  <img src="https://img.shields.io/badge/v0.2.0-stable-brightgreen" alt="v0.2.0" />
</p>

---

## Why?

You're on the couch, in bed, or on the bus — and you want to tell Copilot to refactor that module, fix the failing tests, or scaffold a new feature. Mobile Copilot gives you the **full VS Code Copilot Chat agent** on your phone. It edits files, runs commands, reads diagnostics, and streams everything back to you in real time. Your desktop does the work; your phone is the remote.

---

## Features

### Chat
- **Agent Mode** — Full Copilot Chat passthrough with tool use: file editing, terminal commands, codebase search, diagnostics
- **Chat Mode** — Direct LLM access via `vscode.lm` API for quick questions without tool use
- **19 models** — GPT-4o, Claude 3.5/3.7/4 Sonnet & Opus, o1/o3/o4-mini, Gemini 2.0/2.5, and more
- **Streaming** — Responses stream token-by-token with Markdown rendering and syntax highlighting
- **Context attachment** — Attach the active file or workspace info to any prompt
- **Chat history** — Last 200 messages persisted in browser storage

### Live Agent Activity Feed
While the agent works, your phone shows a real-time feed of everything happening:
- Files created, edited, saved, deleted
- Terminal commands executed
- Diagnostics changes
- **Inline diff previews** with +/- line counts per file change

### Unified Diff Viewer
When the agent completes, expandable **full unified diffs** appear for every modified file:
- Green/red line highlighting (added/removed)
- Line numbers and hunk headers
- Tap any file path to open it in VS Code
- **Accept** or **Revert** changes (revert runs `git restore` per file)

### Agent Status Banner
Color-coded persistent banner tracks the agent lifecycle:
- 🔵 **Running** — spinner while agent is working
- 🟢 **Completed** — file count + diff viewer + Accept/Revert buttons
- 🔴 **Failed** — error message

### Quick Commands Panel
One-tap shortcuts for common operations:

| Git | Build & Test | Workspace |
|-----|-------------|-----------|
| Status | npm test | List files |
| Diff | npm build | Disk usage |
| Stage all | npm lint | package.json |
| Commit | npm install | Current dir |
| Push / Pull | npm dev/start | |
| Log / Branches | | |

Plus a **custom command** input for anything else.

### File Browser
Browse your workspace, navigate folders, view files with syntax highlighting. 30+ file type icons. Auto-refreshes when files change.

### Terminal
Run shell commands on your desktop from your phone. Full output display.

### Diagnostics
Live error/warning counts with badge. Tap any diagnostic to open the file at the exact line in VS Code.

### Session Persistence & Reconnection
- Sessions survive phone sleep, network drops, and app switches
- **Message buffering** — if your phone disconnects mid-stream, chunks accumulate and replay on reconnect
- **Event queue** — up to 200 events queued per session during disconnect
- No need to rescan the QR code after reconnecting

### PWA
- Installable to home screen (iOS Safari, Android Chrome)
- Offline-capable with service worker caching
- Push notifications on response completion
- Vibration feedback (Android)

---

## Prerequisites

- **VS Code** ≥ 1.95.0
- **GitHub Copilot** extension installed and signed in ([subscription required](https://github.com/features/copilot))
- **Node.js** ≥ 18
- **Git** installed
- A phone with a web browser

---

## Installation

```bash
# Clone and install
git clone https://github.com/jason0960/vscode_ide_mobile_plug.git
cd vscode_ide_mobile_plug
npm install

# Build and package
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
# Type 'y' when prompted

# Install the extension
code --install-extension mobile-copilot-0.2.0.vsix --force
```

Reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**

---

## Quick Start

### Same Wi-Fi (simplest)

1. `Ctrl+Shift+P` → **Mobile Copilot: Start Server**
2. Scan the QR code with your phone
3. Start chatting

### Any Network (tunnel)

For access from anywhere — different Wi-Fi, cellular, etc.

#### Option A: VS Code Dev Tunnels (recommended, free)

1. Install **Remote - Tunnels** (`ms-vscode.remote-server`) extension
2. Sign in with GitHub (Accounts icon, bottom-left)
3. Start the Mobile Copilot server
4. Open **Ports** tab → Forward port `3847` → Set visibility to **Public**
5. `Ctrl+Shift+P` → **Mobile Copilot: Set Tunnel URL** → paste the forwarded URL
6. Scan the new QR code

#### Option B: Cloudflare Tunnel (free, no account)

```bash
# Install cloudflared
sudo apt install cloudflared    # Linux
brew install cloudflared        # Mac
```

Set `mobileCopilot.tunnelProvider` to `cloudflare` in VS Code settings, then restart the server. A random `*.trycloudflare.com` URL is created automatically.

#### Option C: ngrok

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
```

Set `mobileCopilot.tunnelProvider` to `ngrok`, restart the server.

---

## Commands

| Command | Description |
|---------|-------------|
| **Mobile Copilot: Start Server** | Start the server and show QR code |
| **Mobile Copilot: Stop Server** | Stop server and disconnect all clients |
| **Mobile Copilot: Show QR Code** | Show the QR code again |
| **Mobile Copilot: Toggle Tunnel** | Start/stop the configured tunnel |
| **Mobile Copilot: Set Tunnel URL** | Manually set a tunnel URL |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mobileCopilot.port` | `3847` | Server port |
| `mobileCopilot.tunnelProvider` | `none` | `none` / `vscode` / `cloudflare` / `ngrok` |
| `mobileCopilot.autoStart` | `false` | Auto-start on VS Code launch |
| `mobileCopilot.sessionTimeout` | `3600` | Session timeout in seconds (0 = never) |
| `mobileCopilot.captureMode` | `relay` | Agent response capture strategy |
| `mobileCopilot.modelFamily` | `gpt-4o` | Default model for Chat mode |

### Capture Modes

| Mode | Description | Reliability |
|------|-------------|-------------|
| **relay** (default) | Appends instruction to prompt; Copilot writes response to temp file; FileSystemWatcher streams it to phone | High |
| **interceptor** | Monitors document change events to detect chat responses (no prompt modification) | Experimental |
| **hybrid** | Both strategies; relay captures response, interceptor logs URI data in background | High |

---

## Architecture

```
Phone (PWA)                         Desktop (VS Code Extension)
───────────                         ───────────────────────────
app.js ←──── WebSocket ────→  server.ts     Express + WebSocket + RPC
             JSON-RPC              ├── agent.ts       File ops, terminal, git
             (LAN or tunnel)       ├── copilot.ts     vscode.lm API bridge
                                   ├── participant.ts @mobile chat participant
                                   ├── interceptor.ts Doc change monitor
                                   ├── context.ts     Workspace info, file tree
                                   ├── auth.ts        QR pairing, token auth
                                   ├── rpc.ts         JSON-RPC protocol
                                   └── tunnel.ts      Cloudflare/ngrok/VS Code
```

### RPC Protocol

28 methods over WebSocket JSON-RPC:

| Category | Methods |
|----------|---------|
| **Chat** | `chat.sendToAgent` (stream), `chat.send` (stream), `chat.models`, `chat.tokenCount` |
| **Files** | `file.read`, `file.write`, `file.create`, `file.delete`, `file.edit`, `file.search` |
| **Workspace** | `workspace.info`, `workspace.fileTree`, `workspace.listDir` |
| **Editor** | `editor.open`, `editor.active` |
| **Terminal** | `terminal.run`, `terminal.list` |
| **Git** | `git.status`, `git.diff`, `git.restoreChanges` |
| **Diagnostics** | `diagnostics.all`, `diagnostics.summary` |
| **Agent** | `agent.modifiedFiles` |
| **System** | `server.state`, `ping` |

### Events (server → phone)

| Event | Description |
|-------|-------------|
| `agent.activity` | Real-time activity feed (edit, file-created, file-changed, file-deleted, terminal, etc.) |
| `agent.status` | Agent lifecycle (running/completed/failed) with unified diffs |
| `session.missedResponse` | Replays buffered response after reconnect |
| `diagnostics.changed` | Live diagnostics updates |
| `editor.changed` | Active editor switched |
| `file.created/changed/deleted` | Workspace file events |

---

## Security

- **Your code never leaves your machine** — no cloud service; communication is direct LAN or via your chosen tunnel
- **256-bit cryptographic tokens** — generated via `crypto.randomBytes`, stored in VS Code SecretStorage
- **QR code pairing** — token embedded in QR, stripped from URL after pairing
- **Timing-safe comparison** — constant-time token validation prevents timing attacks
- **TLS encryption** — tunnels provide automatic HTTPS

---

## Platform Notes

### iOS
- Use **Safari** to add the app to your home screen (Share → Add to Home Screen)
- Push notifications require: HTTPS tunnel + Safari + home screen install + iOS 16.4+
- Vibration is not supported (Apple limitation); audio beep plays instead

### Android
- **Chrome** works best — supports notifications, vibration, and home screen install
- Allow notifications when prompted on first use

---

## Costs

| Component | Cost |
|-----------|------|
| GitHub Copilot subscription | $10–19/month (existing) |
| This extension | Free (MIT) |
| Tunnel (VS Code / Cloudflare) | Free |
| **Additional cost** | **$0** |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| QR code doesn't appear | Run `Mobile Copilot: Start Server` from Command Palette |
| Phone can't connect (LAN) | Verify same network. Try `http://<your-ip>:3847` manually |
| Phone can't connect (tunnel) | Check Ports tab — is 3847 forwarded and Public? Use `Set Tunnel URL` |
| "Authentication failed" | Session expired. Show QR Code and rescan |
| No agent response | Verify Copilot is signed in and active |
| Extension not loading | Run `Developer: Reload Window`. Check Output → "Mobile Copilot" for errors |
| Still seeing old UI | Clear browser cache or open in incognito. Service worker may need two reloads |

---

## Development

```bash
npm install
npm run watch        # Auto-rebuild on save
# Press F5 in VS Code to launch Extension Development Host

# Package for distribution
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

---

## License

MIT
