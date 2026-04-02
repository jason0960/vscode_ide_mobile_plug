# Architecture — Mobile Copilot Remote

> **Last updated:** 2026-04-01 (Phase 2 — Pub/Sub Transport)

## Overview

Mobile Copilot Remote bridges mobile phones to GitHub Copilot Chat running in
VS Code. The system uses a **Strategy Pattern** for transport, supporting both
WebSocket relay and Google Cloud Pub/Sub as communication channels.

```
┌──────────────┐                          ┌──────────────────┐
│  Mobile App  │◄──── Transport ────────►│  VS Code Ext     │
│  (Expo/RN)   │     (Relay or Pub/Sub)   │  (adapter-vscode)│
└──────────────┘                          └───────┬──────────┘
                                                  │
                                          ┌───────▼──────────┐
                                          │  GitHub Copilot  │
                                          │  Chat API        │
                                          └──────────────────┘
```

## Repository Structure

The project is split across three independent repositories:

```
gopilot-extension/               # VS Code extension (this repo)
├── packages/
│   ├── protocol/                # Shared types & RPC handler (inlined at build)
│   ├── adapter-core/            # Base server (auth, RPC, sessions) (inlined at build)
│   └── adapter-vscode/          # VS Code extension entry point
│
gopilot-relay/                   # Standalone relay server (separate repo)
gopilot-mobile/                  # Standalone mobile app (separate repo)
```

Each repo is independently deployable:
- **gopilot-extension** → VS Code Marketplace
- **gopilot-relay** → Render / Fly.io (`wss://gopilot-relay.onrender.com`)
- **gopilot-mobile** → EAS Build / Expo Go

## Transport Layer

### Strategy Pattern

Both the extension and mobile app use a transport abstraction that allows
swapping between relay (WebSocket) and Pub/Sub without changing the RPC layer.

```
                    MobileTransport (interface)
                    ┌─────────────────────────┐
                    │ connect()               │
                    │ send(data)              │
                    │ disconnect()            │
                    │ dispose()               │
                    │ isConnected             │
                    │ code                    │
                    │ onMessage               │
                    │ onRoomCreated           │
                    │ onClientJoined          │
                    │ onClientLeft            │
                    │ onDisconnected          │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
      RelayClient                       PubSubTransport
   (WebSocket relay)               (Google Cloud Pub/Sub)
```

**Extension side** (`adapter-vscode`):
- `transport.ts` — `MobileTransport` interface + `TransportType`
- `relay-client.ts` — WebSocket relay implementation
- `pubsub-transport.ts` — Pub/Sub REST API implementation
- `server.ts` — `createTransport()` factory reads `transportType` config

**Mobile side** (`gopilot-mobile`):
- `connection.ts` — `ConnectionManager` (WebSocket relay)
- `pubsub.ts` — `PubSubConnection` (Pub/Sub REST API)
- `AppStore.ts` — Transport switching via `connectRelay()` / `connectPubSub()`

### Relay Transport

Classic WebSocket relay with room-based pairing:

```
Mobile ──ws──► Relay Server ◄──ws── Extension
                  │
            Room: "ABC123"
            (6-char code)
```

- Extension creates a room, gets a 6-char code
- Mobile joins with the code
- All messages forwarded bidirectionally
- E2E encryption via X25519 + XSalsa20-Poly1305

### Pub/Sub Transport

Google Cloud Pub/Sub with REST API polling:

```
Mobile ──publish──► Topic ──subscription──► Extension  (mobile_to_ext)
Extension ──publish──► Topic ──subscription──► Mobile   (ext_to_mobile)
```

- Extension creates subscriptions, generates pairing info
- Mobile receives pairing via QR code or manual entry
- Both sides poll their subscription at 2s intervals
- Messages wrapped in `PubSubEnvelope` with deduplication IDs
- Auth via Application Default Credentials (gcloud CLI) or Service Account JWT

#### PubSubEnvelope Format

```typescript
interface PubSubEnvelope {
  id: string;              // UUID for deduplication
  userId: string;          // Session/ordering key
  direction: 'mobile_to_ext' | 'ext_to_mobile';
  messageType: 'rpc' | 'auth' | 'heartbeat' | 'pairing' | 'disconnect';
  payload: string;         // JSON-encoded RPC message
  timestamp: number;       // Unix ms
  correlationId?: string;  // Links response to request
}
```

#### Pairing Flow

```
1. Extension starts → createTransport('pubsub')
2. PubSubTransport.connect() creates subscriptions, gets pairing info
3. Pairing code displayed (encodes projectId, topic, subscriptions, token)
4. Mobile enters code → connectPubSub(pairingInfo)
5. Mobile publishes pairing.ack → extension receives → onClientJoined fires
6. RPC auth handshake over Pub/Sub → session established
```

## Extension Architecture (`adapter-vscode`)

### Module Graph

```
extension.ts          Entry point, command registration, auto-start
    │
    ├── server.ts     Core server: transport, RPC handlers, Copilot bridge
    │   ├── transport.ts        MobileTransport interface
    │   ├── relay-client.ts     WebSocket relay
    │   ├── pubsub-transport.ts Pub/Sub transport
    │   ├── copilot.ts          Copilot Chat API integration
    │   ├── context.ts          Workspace context gathering
    │   └── agent.ts            Agent mode handler
    │
    ├── auth.ts       Session & token management
    ├── tunnel.ts     VS Code dev tunnel management
    ├── config.ts     Configuration wrapper
    ├── logger.ts     Output channel logging
    └── participant.ts @mobile chat participant
```

### Configuration Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mobileCopilot.transportType` | `relay` \| `pubsub` | `relay` | Active transport |
| `mobileCopilot.relayUrl` | `string` | `""` | Custom relay URL |
| `mobileCopilot.pubsub.projectId` | `string` | `""` | GCP project ID |
| `mobileCopilot.pubsub.topicName` | `string` | `mobile-copilot` | Pub/Sub topic |
| `mobileCopilot.pubsub.subscriptionName` | `string` | `""` | Subscription name |
| `mobileCopilot.autoStart` | `boolean` | `true` | Auto-connect on activation |

### Transport Factory

`server.ts` → `createTransport()`:

```typescript
private createTransport(): MobileTransport {
  const transportType = this.config.get<TransportType>('transportType', 'relay');
  if (transportType === 'pubsub') {
    return new PubSubTransport({
      projectId: this.config.get('pubsub.projectId', ''),
      topicName: this.config.get('pubsub.topicName', 'mobile-copilot'),
      subscriptionName: this.config.get('pubsub.subscriptionName', ''),
    });
  }
  return new RelayClient(this.logger);
}
```

## Mobile Architecture (`gopilot-mobile`)

### Module Graph

```
App.tsx                Root navigator
    │
    ├── store/
    │   └── AppStore.ts        Zustand store (state + actions)
    │       ├── connection.ts   WebSocket ConnectionManager
    │       ├── pubsub.ts       PubSubConnection
    │       └── rpc.ts          JSON-RPC client + E2E crypto
    │
    ├── screens/
    │   ├── ConnectScreen.tsx   QR scan, room code entry
    │   ├── ChatScreen.tsx      Chat UI + streaming
    │   ├── FilesScreen.tsx     File browser
    │   ├── ChangesScreen.tsx   Git changes
    │   ├── TerminalScreen.tsx  Remote terminal
    │   └── ...
    │
    └── components/
        ├── SyntaxHighlighter.tsx
        ├── InlineDiffPanel.tsx
        └── ...
```

### Transport Switching in AppStore

The mobile app switches transport at the `AppStore` level by redirecting the
`ConnectionManager`'s `send()` and `markAuthenticated()` methods:

```typescript
// Relay mode (default):
connectionManager.send(data)         // → WebSocket.send(data)
connectionManager.markAuthenticated() // → sets WS status

// Pub/Sub mode (after connectPubSub):
connectionManager.send(data)         // → pubsubConnection.send(data)
connectionManager.markAuthenticated() // → pubsubConnection.markAuthenticated()
pubsubConnection.onMessage           // → connectionManager.onMessage (RPC handler)
```

This allows `RpcClient` to work unchanged regardless of transport — it always
calls `this.conn.send()` and receives messages via `this.conn.onMessage`.

## RPC Protocol

JSON-RPC over the transport layer:

```typescript
interface RpcMessage {
  id: string;
  type: 'request' | 'response' | 'stream' | 'event' | 'error';
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}
```

### Key RPC Methods

| Method | Direction | Description |
|--------|-----------|-------------|
| `auth` | mobile → ext | Authenticate session |
| `chat.send` | mobile → ext | Send chat message (streamed response) |
| `chat.sendToAgent` | mobile → ext | Send to Copilot agent mode |
| `workspace.info` | mobile → ext | Get workspace info |
| `workspace.fileTree` | mobile → ext | List file tree |
| `file.read` | mobile → ext | Read file content |
| `diagnostics.all` | mobile → ext | Get all diagnostics |
| `terminal.run` | mobile → ext | Run terminal command |
| `git.changedFiles` | mobile → ext | List git changes |

### Event Types

| Event | Direction | Description |
|-------|-----------|-------------|
| `connection.ready` | ext → mobile | Server ready for auth |
| `auth.success` | ext → mobile | Auth succeeded |
| `diagnostics.changed` | ext → mobile | Diagnostics updated |
| `agent.status` | ext → mobile | Agent task status |
| `session.missedResponse` | ext → mobile | Catch-up for offline messages |

## Security

- **E2E Encryption** (relay): X25519 key exchange + XSalsa20-Poly1305 AEAD
- **Pub/Sub Auth**: GCP Application Default Credentials or Service Account JWT
- **Session Tokens**: Short-lived, stored in VS Code SecretStorage
- **No Hardcoded Secrets**: All credentials via environment or secure storage

## Build & Test

```bash
# Extension
cd packages/adapter-vscode && npm run build   # esbuild → dist/extension.js
npx jest packages/adapter-vscode/__tests__/   # 387 tests, 9 suites

# Mobile
cd gopilot-mobile && npx tsc --noEmit         # TypeScript check
cd gopilot-mobile && npx jest                  # 132 tests, 3 suites

# Relay server
cd gopilot-relay && npm start                  # Start on :4800

# Full monorepo
npm install && npm test                        # All workspace tests
```

## Test Coverage

| Package | Tests | Suites | Key Coverage |
|---------|-------|--------|-------------|
| adapter-vscode | 387 | 9 | server, extension, pubsub-transport, relay-client, copilot, agent, context, interceptor, findSafeBreak |
| gopilot-mobile | 132 | 3 | connection, rpc, pubsub |
| protocol | included in workspace root | — | RPC handler |
| relay-server | included in workspace root | — | Relay hub |
