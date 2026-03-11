# Mobile Copilot Remote

> Use GitHub Copilot from your phone — the **real** Copilot Chat agent with full tool use, file editing, terminal access, and streaming responses, all from a mobile browser.

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%3E%3D1.95.0-blue" alt="VS Code version" />
  <img src="https://img.shields.io/badge/GitHub%20Copilot-Required-green" alt="Copilot required" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
  <img src="https://img.shields.io/badge/Platform-PWA-orange" alt="PWA" />
</p>

---

## How It Works

```
┌──────────────────────────┐                      ┌──────────────────────────┐
│                          │     WebSocket +       │                          │
│    📱  Your Phone (PWA)  │  ◄──── JSON-RPC ────► │   🖥️  VS Code Desktop    │
│                          │                       │                          │
│  • Chat with Copilot     │                       │  • Express server (3847) │
│  • Browse files          │   ← stream tokens →   │  • Copilot Chat relay    │
│  • Run terminal commands │                       │  • File system agent     │
│  • View diagnostics      │                       │  • Terminal manager      │
│  • Check git status      │                       │  • Git integration       │
│  • Chat history saved    │                       │  • Workspace context     │
│                          │                       │                          │
└──────────────────────────┘                       └──────────────────────────┘
         ▲                                                    │
         │                QR Code Pairing (one scan)          │
         └────────────────────────────────────────────────────┘
```

**Agent Mode** sends your prompt directly into the VS Code Copilot Chat panel. Copilot processes it with full tool use (file editing, search, terminal, etc.) and the response is relayed back to your phone via a file-watcher bridge. You get the **exact same response** you'd see sitting at your desk.

**Chat Mode** uses the `vscode.lm` API for quick questions without tool use — fast, lightweight, good for Q&A.

---

## Features

| Feature | Description |
|---------|-------------|
| **Agent Mode** | Real Copilot Chat with full tool use — file editing, code search, terminal commands |
| **Chat Mode** | Direct LLM access for quick questions (GPT-4o, Claude, Gemini, o-series) |
| **Streaming Responses** | Token-by-token streaming with live markdown rendering |
| **Chat History** | Conversations persist in localStorage across sessions and page reloads |
| **File Browser** | Navigate, read, create, edit, and delete files from your phone |
| **Terminal** | Run shell commands remotely |
| **Diagnostics** | Real-time errors and warnings with badge counts |
| **Git Integration** | Branch, status, and diffs at a glance |
| **Notifications** | Browser notification + vibration when a response completes |
| **QR Code Pairing** | Secure one-scan connection — no typing IPs or tokens |
| **Auto-Reconnect** | Survives phone sleep, network drops, and tab switches |
| **PWA** | Add to home screen — zero install, works in any mobile browser |
| **Dark/Light Themes** | VS Code-inspired mobile UI |
| **Tunnel Support** | Optional internet access via Cloudflare, ngrok, or VS Code dev tunnels |

---

## Quick Start

### Prerequisites

- **VS Code** ≥ 1.95.0
- **GitHub Copilot** extension installed and active (valid subscription required)
- **Node.js** ≥ 18 (for building from source)
- Phone and computer on the **same Wi-Fi network** (for LAN mode)

### 1. Install the Extension

**Option A — From source:**

```bash
git clone https://github.com/jason0960/vscode_ide_mobile_plug.git
cd vscode_ide_mobile_plug
npm install
npm run build
npx @vscode/vsce package --allow-missing-repository
code --install-extension mobile-copilot-0.1.0.vsix
```

**Option B — Development mode:**

```bash
git clone https://github.com/jason0960/vscode_ide_mobile_plug.git
cd vscode_ide_mobile_plug
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

### 2. Start the Server

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
Mobile Copilot: Start Server
```

A QR code panel appears. The server starts on port **3847** by default.

### 3. Connect Your Phone

1. Open your phone's camera and scan the QR code
2. The Mobile Copilot PWA loads in your browser
3. (Optional) Tap "Add to Home Screen" for an app-like experience
4. Start chatting!

> **Tip:** Your session persists across disconnects. If your phone sleeps or loses connection, it automatically reconnects — no need to rescan the QR code.

---

## Usage

### Agent Mode (Default)

Agent mode sends your prompt to the real Copilot Chat agent in VS Code. Copilot can:

- Edit and create files in your workspace
- Search across your codebase
- Run terminal commands
- Read diagnostics and fix errors
- Use any tools available in VS Code Copilot Chat

Your prompt is augmented with workspace context (file tree, open editors, diagnostics, git status) so Copilot understands your project.

### Chat Mode

Toggle to Chat mode for quick questions that don't need tool use. Chat mode talks directly to the language model (GPT-4o, Claude, Gemini, etc.) via the `vscode.lm` API. It supports conversation history and is faster for simple Q&A.

### Switching Modes

Use the **Agent** / **Chat** toggle at the top of the chat panel. Your selection persists across sessions.

---

## Commands

| Command | Description |
|---------|-------------|
| `Mobile Copilot: Start Server` | Start the HTTP/WebSocket server and show QR code |
| `Mobile Copilot: Stop Server` | Stop the server and disconnect all clients |
| `Mobile Copilot: Show QR Code` | Re-display the pairing QR code |
| `Mobile Copilot: Toggle Tunnel` | Enable/disable internet tunnel |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mobileCopilot.port` | `3847` | Server port |
| `mobileCopilot.tunnelProvider` | `none` | `none`, `vscode`, `cloudflare`, or `ngrok` |
| `mobileCopilot.autoStart` | `false` | Auto-start server when VS Code launches |
| `mobileCopilot.sessionTimeout` | `3600` | Session timeout in seconds (0 = no timeout) |
| `mobileCopilot.modelFamily` | `gpt-4o` | Preferred Copilot model family |

---

## Architecture

### Extension (TypeScript, bundled with esbuild)

```
src/
├── extension.ts     # Entry point — registers commands, manages lifecycle
├── server.ts        # Express HTTP + WebSocket server, RPC routing, file-relay agent
├── auth.ts          # QR code pairing, token generation, session management
├── rpc.ts           # JSON-RPC protocol over WebSocket (bidirectional)
├── copilot.ts       # Bridge to vscode.lm API for Chat mode
├── participant.ts   # @mobile chat participant with rich workspace context
├── context.ts       # Workspace context provider (files, diagnostics, git)
├── agent.ts         # Agent operations (file CRUD, terminal, editor, search)
├── tunnel.ts        # Optional tunnel support (Cloudflare, ngrok, VS Code)
└── types.ts         # Shared TypeScript types
```

### Mobile Client (PWA)

```
mobile-client/
├── index.html       # App shell — chat, files, terminal, diagnostics panels
├── app.js           # WebSocket client, UI logic, chat history, notifications
├── styles.css       # Mobile-optimized dark/light theme CSS
├── manifest.json    # PWA manifest for home screen install
├── sw.js            # Service worker for offline shell caching
├── icons/           # App icons (SVG + PNG)
└── lib/             # Vendored: marked.js, highlight.js
```

### File-Relay Agent Mode

When you send a prompt in Agent mode, the extension:

1. Injects your prompt (with workspace context) into the native VS Code Copilot Chat panel
2. Copilot processes it with full tool use (edits files, runs commands, etc.)
3. Copilot's response is written to a temporary relay file (`.copilot-mobile-relay.md`)
4. A `FileSystemWatcher` detects the write and streams the content back to your phone
5. The relay file is automatically deleted after delivery

This means you get the **exact same Copilot response** that appears in the desktop Chat panel.

### RPC Protocol

Communication uses a JSON-RPC-like protocol over WebSocket:

```json
{ "id": "msg_123", "type": "request", "method": "chat.sendToAgent", "params": { "prompt": "..." } }
{ "id": "msg_123", "type": "stream",  "result": "Here is" }
{ "id": "msg_123", "type": "stream",  "result": " a chunk" }
{ "id": "msg_123", "type": "response","result": { "done": true } }
```

<details>
<summary><strong>Full RPC Method Reference</strong></summary>

| Method | Type | Description |
|--------|------|-------------|
| `chat.sendToAgent` | stream | Send prompt to Copilot Chat agent (Agent mode) |
| `chat.send` | stream | Send prompt to LLM directly (Chat mode) |
| `chat.models` | request | List available Copilot models |
| `workspace.info` | request | Get workspace summary |
| `workspace.fileTree` | request | Get file tree (configurable depth) |
| `workspace.listDir` | request | List directory contents |
| `file.read` | request | Read file contents |
| `file.write` | request | Write file contents |
| `file.create` | request | Create a new file |
| `file.delete` | request | Delete a file |
| `file.edit` | request | Find-and-replace edit |
| `file.search` | request | Search files for text |
| `terminal.run` | request | Run a terminal command |
| `terminal.list` | request | List active terminals |
| `editor.open` | request | Open a file in the editor |
| `editor.active` | request | Get active editor info |
| `diagnostics.all` | request | Get all diagnostics |
| `diagnostics.summary` | request | Get error/warning counts |
| `git.status` | request | Get git status |
| `git.diff` | request | Get git diff |

</details>

---

## Security

- **Cryptographic token auth** — Random token per session, stored in VS Code's encrypted SecretStorage
- **QR code pairing** — Token transmitted via QR scan, stripped from URL after pairing
- **Session persistence** — Sessions survive disconnects; expire after configurable timeout
- **Timing-safe comparison** — Constant-time token validation prevents timing attacks
- **Transport** — LAN uses plain HTTP (local network); tunnel providers add automatic TLS/HTTPS
- **No cloud relay** — All communication is direct between your phone and your machine

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| QR code doesn't load | Ensure `Mobile Copilot: Start Server` is running. Check Output panel for errors. |
| Phone can't connect | Verify both devices are on the same Wi-Fi. Try `http://<your-ip>:3847` manually. |
| "Authentication failed" | Session expired. Run `Mobile Copilot: Show QR Code` and rescan. |
| Agent mode gives no response | Ensure GitHub Copilot is active and signed in. Check the Chat panel in VS Code. |
| Chat mode model error | The selected model may not be available. Try switching to `gpt-4o` in settings. |

---

## Development

```bash
# Install dependencies
npm install

# Watch mode (auto-rebuild on save)
npm run watch

# Press F5 in VS Code to launch Extension Development Host

# Package for distribution
npx @vscode/vsce package --allow-missing-repository
```

---

## License

MIT
