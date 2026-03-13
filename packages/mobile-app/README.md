# Mobile Copilot — React Native App

## Development

```bash
cd packages/mobile-app
npx expo install
npx expo start
```

Scan the QR code with Expo Go, or press `a` for Android / `i` for iOS.

## Features

- **Chat** — Real-time Copilot chat with streaming markdown
- **Files** — Browse and view workspace files
- **Terminal** — Run terminal commands remotely
- **Diagnostics** — View errors and warnings
- **Changes** — Git diff viewer with accept/revert
- **Settings** — Connection mode, theme, model selection

## Connection Modes

1. **Direct** — Scan QR code from VS Code (LAN/tunnel)
2. **Relay** — Enter room code for cloud relay connection
