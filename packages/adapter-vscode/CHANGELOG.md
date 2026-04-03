# Changelog

## [0.2.0] — 2026-04-03

### Added
- **Cloud Relay Transport**: WebSocket relay hub (6-char room codes) for NAT-free connectivity
- **E2E Encryption**: X25519 ECDH key exchange + XSalsa20-Poly1305 message encryption
- **Copilot Chat Participant**: `@mobile` chat participant relays prompts from phone to Copilot
- **Agent Mode**: Full Copilot agent mode with file operations, terminal, diagnostics
- **Git Integration**: View changes, inline diffs, restore files — all from mobile
- **Branch Management**: Switch branches remotely
- **Terminal Access**: Run commands in VS Code terminal from your phone
- **Diagnostics**: View workspace errors and warnings on mobile
- **Quick Commands**: Predefined shortcuts for common operations
- **Settings**: Configure model family, transport type, capture mode
- **Pub/Sub Transport**: Google Cloud Pub/Sub alternative transport
- **Pairing QR Codes**: Scan QR to pair mobile app with extension
- **Embedded Relay**: Built-in relay server for zero-config local development
- **Status Bar**: Connection status indicator with room code

### Fixed
- `trimEnd()` bugfix for git status parsing (trailing newlines)
- Tunnel type cast for VS Code tunnel provider

## [0.1.0] — 2025-12-01

### Added
- Initial release with WebSocket server
- Basic mobile ↔ VS Code communication
- Chat message streaming
