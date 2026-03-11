# Mobile Copilot Remote

> Use GitHub Copilot from your phone — the **real** Copilot Chat agent with full tool use, file editing, terminal access, and streaming responses, all from a mobile browser. **$0 additional cost.**

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%3E%3D1.95.0-blue" alt="VS Code version" />
  <img src="https://img.shields.io/badge/GitHub%20Copilot-Required-green" alt="Copilot required" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
  <img src="https://img.shields.io/badge/Cost-Free-brightgreen" alt="Free" />
</p>

---

## What You Need

Before starting, make sure you have:

- [ ] **VS Code** ≥ 1.95.0 installed on your desktop/laptop
- [ ] **GitHub Copilot** extension installed and signed in (requires a [Copilot subscription](https://github.com/features/copilot))
- [ ] **Node.js** ≥ 18 installed ([download](https://nodejs.org/))
- [ ] **Git** installed ([download](https://git-scm.com/))
- [ ] A **smartphone** with a web browser (iPhone, Android, anything)

---

## Installation (5 minutes)

### Step 1: Clone the Repository

Open a terminal and run:

```bash
git clone https://github.com/jason0960/vscode_ide_mobile_plug.git
cd vscode_ide_mobile_plug
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build the Extension

```bash
npm run build
```

You should see output like:
```
dist/extension.js      39.9kb  100.0%
[build] Copied mobile-client → dist/mobile
[build] Done.
```

### Step 4: Package the Extension

```bash
npx @vscode/vsce package --allow-missing-repository
```

Type `y` if prompted. This creates `mobile-copilot-0.1.0.vsix`.

### Step 5: Install the Extension

```bash
code --install-extension mobile-copilot-0.1.0.vsix --force
```

### Step 6: Reload VS Code

Open VS Code, press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac), type:
```
Developer: Reload Window
```
Press Enter.

---

## Connecting Your Phone (Same Wi-Fi)

If your phone and computer are on the **same Wi-Fi network**, this is the simplest setup.

### Step 1: Start the Server

Press `Ctrl+Shift+P`, type:
```
Mobile Copilot: Start Server
```
Press Enter. A QR code panel appears.

### Step 2: Scan the QR Code

Open your phone's camera and point it at the QR code. Tap the link that appears. The Mobile Copilot web app loads in your browser.

### Step 3: Start Chatting

You're connected! Type a message and send it. The response streams in real-time from the Copilot agent on your desktop.

> **Your session persists.** If your phone sleeps or loses connection, it automatically reconnects when you come back — no need to rescan the QR code.

---

## Connecting Your Phone (Any Network — Tunnel Mode)

To use Mobile Copilot from **anywhere** (different Wi-Fi, cellular data, coffee shop), set up a tunnel. This gives you an HTTPS URL that works over the internet. **Free, no account needed beyond GitHub.**

### Option A: VS Code Dev Tunnels (Recommended)

#### 1. Install the Remote Tunnels Extensions

In VS Code, go to Extensions (`Ctrl+Shift+X`) and install:
- **Remote - Tunnels** (`ms-vscode.remote-server`)
- **Remote Explorer** (`ms-vscode.remote-explorer`)

#### 2. Sign in with GitHub

Click the **Accounts** icon (bottom-left of VS Code sidebar) → **Sign in with GitHub to use Remote Tunnels**. Authorize when prompted.

#### 3. Start the Mobile Copilot Server

```
Ctrl+Shift+P → Mobile Copilot: Start Server
```

#### 4. Forward the Port

Open the **Ports** tab (at the bottom of VS Code, next to the Terminal tab):
- If port `3847` isn't listed, click **"Forward a Port"** and enter `3847`
- Right-click port `3847` → **Port Visibility** → **Public**
- Right-click port `3847` → **Copy Forwarded Address**

#### 5. Set the Tunnel URL

```
Ctrl+Shift+P → Mobile Copilot: Set Tunnel URL
```

Paste the URL you just copied (e.g. `https://xxxxx-3847.uks1.devtunnels.ms`). Press Enter.

A new QR code appears with the tunnel URL. Scan it from your phone — **works from any network worldwide.**

#### Cost: **Free** (2GB/month bandwidth, more than enough for chat)

---

### Option B: Cloudflare Tunnel

#### 1. Install cloudflared

```bash
# Linux (Debian/Ubuntu)
sudo apt install cloudflared

# Mac
brew install cloudflared

# Windows — download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

#### 2. Configure the Setting

In VS Code, press `Ctrl+Shift+P` → **Preferences: Open Settings (UI)**

Search for `mobileCopilot.tunnelProvider` and change it to **`cloudflare`**

#### 3. Restart the Server

```
Ctrl+Shift+P → Mobile Copilot: Stop Server
Ctrl+Shift+P → Mobile Copilot: Start Server
```

A Cloudflare tunnel starts automatically. The QR code shows an HTTPS URL like `https://random-words.trycloudflare.com`. Scan it.

#### Cost: **Free** (no account needed, random URL changes each restart)

---

### Option C: ngrok

#### 1. Install ngrok

```bash
# Linux/Mac
brew install ngrok
# or download from https://ngrok.com/download

# Sign up for a free account and add your auth token:
ngrok config add-authtoken YOUR_TOKEN
```

#### 2. Configure the Setting

Set `mobileCopilot.tunnelProvider` to **`ngrok`** in VS Code settings.

#### 3. Restart the Server

Same as Cloudflare above. QR code shows the ngrok HTTPS URL.

#### Cost: **Free tier** available (limited bandwidth)

---

## How to Use

### Agent Mode (Default)

Agent mode gives you the **real Copilot Chat agent** — the same one that runs in the VS Code Chat panel. It can:

- ✏️ Edit and create files in your workspace
- 🔍 Search across your codebase
- 🖥️ Run terminal commands
- 🐛 Read diagnostics and fix errors
- 🔧 Use any VS Code Copilot Chat tools

**Example prompts:**
- "Add error handling to the login function"
- "Create a new React component for user profiles"
- "What's the git status? Commit everything with a good message."
- "Find and fix all TypeScript errors"
- "Run the tests and tell me what failed"

### Chat Mode

Toggle to **Chat** mode (tap the toggle at the top of the chat screen) for quick questions without tool use. This talks directly to the language model and is faster for simple Q&A.

**Example prompts:**
- "Explain what this regex does: `/^[a-z]+$/i`"
- "What's the difference between `useEffect` and `useLayoutEffect`?"
- "Write a SQL query to find duplicate emails"

### Chat History

Your conversations are automatically saved to your phone's browser storage (last 200 messages). When you reopen the app — even offline — your previous conversation is still there.

Tap the **New Chat** button (top of chat screen) to start fresh.

### File Browser

Tap the navigation menu (☰) → **Files** to browse your workspace. You can:
- Navigate folders
- View file contents with syntax highlighting
- Attach files as context to your chat messages

### Terminal

Tap **Terminal** in the navigation menu to run commands on your desktop from your phone.

### Diagnostics

Tap **Diagnostics** to see all errors and warnings across your workspace. The badge shows the count.

---

## Commands Reference

| Command | What It Does |
|---------|-------------|
| `Mobile Copilot: Start Server` | Start the server and show QR code |
| `Mobile Copilot: Stop Server` | Stop the server and disconnect all clients |
| `Mobile Copilot: Show QR Code` | Show the QR code again (if you closed it) |
| `Mobile Copilot: Toggle Tunnel` | Start/stop the configured tunnel |
| `Mobile Copilot: Set Tunnel URL` | Manually paste a tunnel URL (from VS Code Ports tab) |

## Settings Reference

| Setting | Default | What It Does |
|---------|---------|-------------|
| `mobileCopilot.port` | `3847` | Server port number |
| `mobileCopilot.tunnelProvider` | `none` | `none`, `vscode`, `cloudflare`, or `ngrok` |
| `mobileCopilot.autoStart` | `false` | Auto-start server when VS Code opens |
| `mobileCopilot.sessionTimeout` | `3600` | Session timeout in seconds (0 = never expire) |
| `mobileCopilot.modelFamily` | `gpt-4o` | Default model for Chat mode |

---

## iOS Notes

If you're on iPhone:

- **Use Safari** to scan the QR code if you want to add the app to your home screen
- **Add to Home Screen**: Safari → Share button (□↑) → "Add to Home Screen"
- **Notifications** only work when installed as a home screen PWA on iOS 16.4+
- **Chrome on iOS** works fine for chatting but can't add to home screen as a PWA
- **Vibration** is not supported on any iOS browser (Apple limitation)
- **Audio beep** plays when responses complete (make sure silent mode is off — check the physical switch on the side of your iPhone)

## Android Notes

- **Chrome** works best — supports notifications, vibration, and "Add to Home Screen"
- When you first send a message, Chrome will ask to allow notifications — tap **Allow**
- Vibration works out of the box

---

## Security

- **Your code never leaves your machine** — there is no cloud service; all communication is direct (or via your chosen tunnel)
- **Cryptographic token auth** — Random 256-bit token per session, stored in VS Code's encrypted SecretStorage
- **QR code pairing** — Token transmitted via QR scan, stripped from URL after pairing
- **Session persistence** — Sessions survive disconnects; expire after configurable timeout
- **Timing-safe comparison** — Constant-time token validation to prevent timing attacks
- **Tunnel security** — Cloudflare/ngrok/VS Code tunnels provide automatic TLS/HTTPS encryption

---

## Costs

| Component | Cost |
|---|---|
| GitHub Copilot subscription | $10–19/month (you already have this) |
| This extension | **Free** (MIT license) |
| VS Code Dev Tunnel | **Free** (2GB/month) |
| Cloudflare Tunnel | **Free** (no account needed) |
| **Additional cost** | **$0/month** |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| QR code doesn't appear | Run `Mobile Copilot: Start Server` from the Command Palette |
| Phone can't connect (same Wi-Fi) | Verify both devices are on the same network. Try opening `http://<your-computer-ip>:3847` in your phone's browser manually |
| Phone can't connect (tunnel) | Check the Ports tab in VS Code — is port 3847 forwarded and set to Public? Copy the forwarded URL and use `Mobile Copilot: Set Tunnel URL` |
| "Authentication failed" | Session expired. Run `Mobile Copilot: Show QR Code` and rescan |
| Agent mode gives no response | Make sure GitHub Copilot is signed in and active. Check the VS Code Chat panel for errors |
| Chat mode model error | The selected model may not be available with your subscription. Switch to `gpt-4o` |
| No notifications on iPhone | Notifications require: (1) HTTPS tunnel, (2) Safari, (3) added to home screen, (4) iOS 16.4+ |
| Lost chat history | Chat history is stored per-URL in your browser. If you switch between LAN and tunnel URLs, each has separate history |
| Extension not loading after install | Run `Developer: Reload Window` from the Command Palette |

---

## How It Works (Technical)

### Architecture

```
Your Phone (PWA)                    Your Desktop (VS Code)
─────────────────                   ──────────────────────
app.js                              ┌─ extension.ts (entry point)
  ↕ WebSocket + JSON-RPC            ├─ server.ts (Express + WebSocket)
  ↕ (direct LAN or via tunnel)      ├─ auth.ts (QR pairing, tokens)
                                    ├─ rpc.ts (JSON-RPC protocol)
                                    ├─ copilot.ts (vscode.lm API bridge)
                                    ├─ participant.ts (@mobile chat participant)
                                    ├─ context.ts (workspace context)
                                    ├─ agent.ts (file ops, terminal, editor)
                                    └─ tunnel.ts (Cloudflare/ngrok/VS Code)
```

### Agent Mode — File Relay

1. You send a prompt from your phone
2. The extension injects it into the native VS Code Copilot Chat panel (with workspace context)
3. Copilot processes it with full tool use (edits files, runs commands, etc.)
4. Copilot's response is written to `.copilot-mobile-relay.md`
5. A FileSystemWatcher detects the write and streams content back to your phone
6. The relay file is automatically deleted

You get the **exact same Copilot response** that appears on the desktop.

---

## Development

```bash
# Clone and install
git clone https://github.com/jason0960/vscode_ide_mobile_plug.git
cd vscode_ide_mobile_plug
npm install

# Watch mode (auto-rebuild on save)
npm run watch

# Press F5 in VS Code to launch Extension Development Host

# Package for distribution
npm run build
npx @vscode/vsce package --allow-missing-repository
```

---

## License

MIT — free to use, modify, and distribute.
