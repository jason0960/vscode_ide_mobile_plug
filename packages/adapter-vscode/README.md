# Mobile Copilot Remote

> Control VS Code Copilot Chat from your phone — full agent mode with file editing, terminal commands, diagnostics, git diffs, and streaming responses.

![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-blue?logo=visual-studio-code)
![License](https://img.shields.io/badge/license-MIT-green)

## What It Does

**Mobile Copilot Remote** turns your phone into a remote control for GitHub Copilot Chat. Connect via a 6-character room code, and everything you type on your phone is sent to Copilot running in VS Code — with responses streamed back in real-time.

All communication is **end-to-end encrypted** (X25519 + XSalsa20-Poly1305).

### Key Features

- **Chat with Copilot** — Send prompts from your phone, get streamed responses
- **Agent Mode** — Copilot can edit files, run terminal commands, and fix diagnostics on your behalf
- **Git Integration** — View changed files, inline diffs, restore files, switch branches
- **Terminal Access** — Run shell commands in VS Code's integrated terminal
- **Diagnostics** — See workspace errors and warnings
- **Quick Commands** — Predefined shortcuts (explain code, fix errors, write tests, etc.)
- **E2E Encrypted** — All messages encrypted between your devices

## Quick Start

1. Install this extension
2. Install the **AgentDeck Command Center** mobile app ([iOS](https://apps.apple.com/app/agentdeck-command-center/id6761552734))
3. Open the Command Palette → **Mobile Copilot: Connect Cloud Relay**
4. A 6-character room code appears in the status bar
5. Enter that code in the mobile app → you're connected!

## How It Works

```
┌──────────────┐     WebSocket      ┌───────────────┐     WebSocket      ┌──────────────┐
│  Mobile App  │ ◄──(encrypted)───► │  Relay Server │ ◄──(encrypted)───► │  VS Code Ext │
│  (phone)     │                    │  (cloud)      │                    │  (desktop)   │
└──────────────┘                    └───────────────┘                    └──┬───────────┘
                                                                           │
                                                                    ┌──────▼───────┐
                                                                    │ Copilot Chat │
                                                                    │  (AI agent)  │
                                                                    └──────────────┘
```

The extension connects to a WebSocket relay server and joins a room. Your phone joins the same room. Messages are encrypted on-device and relayed through the server — the relay never sees plaintext.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mobileCopilot.autoStart` | `true` | Auto-start server on VS Code launch |
| `mobileCopilot.transportType` | `relay` | Transport: `relay` (WebSocket) or `pubsub` (GCP) |
| `mobileCopilot.relayUrl` | — | Custom relay server URL |
| `mobileCopilot.modelFamily` | `gpt-4o` | Preferred Copilot model |
| `mobileCopilot.captureMode` | `relay` | Response capture: `relay`, `interceptor`, or `hybrid` |
| `mobileCopilot.port` | `3847` | Local server port |

## Commands

| Command | Description |
|---------|-------------|
| `Mobile Copilot: Connect Cloud Relay` | Connect to relay and get room code |
| `Mobile Copilot: Disconnect Cloud Relay` | Disconnect from relay |
| `Mobile Copilot: Change Relay Room` | Generate a new room code |
| `Mobile Copilot: Show QR Code` | Show connection QR code |
| `Mobile Copilot: Relay Options` | Quick-pick menu for relay actions |
| `Mobile Copilot: Start Server` | Start the local WebSocket server |
| `Mobile Copilot: Stop Server` | Stop the server |

## Requirements

- VS Code 1.95+
- GitHub Copilot Chat extension
- Internet connection (for relay transport)

## Privacy & Security

- **E2E Encrypted**: Messages are encrypted on your device before leaving. The relay server only sees ciphertext.
- **No Data Stored**: The relay server is stateless — messages are forwarded, never persisted.
- **Open Source**: All source code is available on [GitHub](https://github.com/jason0960/vscode_ide_mobile_plug).

## License

MIT — see [LICENSE](LICENSE).
