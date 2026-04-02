# Mobile Copilot Remote — Fixes Log

Local reference document (gitignored). Tracks fixes applied during the mobile-app branch development.

---

## How The App Works (End-to-End Architecture)

### Overview

The system bridges a React Native mobile app to GitHub Copilot's full agent mode (with file edits, terminal, tools) running inside VS Code. Communication flows through a WebSocket relay server.

### Components

1. **Mobile App** (`packages/mobile-app`) — React Native / Expo app with Zustand state store. Connects to relay server via WebSocket. Sends JSON-RPC messages.

2. **Relay Server** (`packages/relay-server`) — Standalone Node.js WebSocket hub on port 4800. Room-based: host (VS Code) creates a room, clients (mobile) join with a 6-char code. Simply forwards messages: client→host and host→all clients.

3. **VS Code Extension** (`packages/adapter-vscode`) — Connects to relay as "host". Receives mobile messages via `onMessage` EventEmitter. Bridges to Copilot Chat via `workbench.action.chat.open`.

4. **Protocol** (`packages/protocol`) — Shared types, JSON-RPC handler. Portable, no IDE dependencies.

5. **Adapter Core** (`packages/adapter-core`) — Base server with auth, RPC, session management.

### Connection Flow

```
1. Extension connects to relay → creates room (e.g. "MEARFR")
2. Mobile app enters room code → joins via WebSocket
3. Relay sends "relay.joined" to mobile
4. Mobile sends auth request → Extension responds with auth.success (direct relay.send)
5. Mobile authenticated → loads workspace info → shows chat screen
```

### Message Flow (Sending a Prompt)

```
Mobile App                 Relay Server              VS Code Extension
    │                           │                           │
    ├─ chat.sendToAgent ───────►├──────────────────────────►│
    │  {prompt: "..."}          │  (forwards to host)       │
    │                           │                           ├─ setupRelayListeners
    │                           │                           │  onMessage handler
    │                           │                           │
    │                           │                           ├─ rpc.handleMessage()
    │                           │                           │  routes to chat.sendToAgent
    │                           │                           │
    │                           │                           ├─ runRelayCapture()
    │                           │                           │  1. Creates file watcher
    │                           │                           │     for .copilot-mobile-relay.md
    │                           │                           │  2. Executes:
    │                           │                           │     workbench.action.chat.open
    │                           │                           │     {query: prompt}
    │                           │                           │
    │                           │                           ├─ Copilot processes prompt
    │                           │                           │  (full agent: files, terminal, tools)
    │                           │                           │
    │                           │                           ├─ Copilot writes response to
    │                           │                           │  .copilot-mobile-relay.md
    │                           │                           │  (per system context instruction)
    │                           │                           │
    │                           │                           ├─ File watcher detects changes
    │                           │                           │  Streams chunks back via relay
    │◄─ stream chunks ─────────┤◄──────────────────────────┤
    │                           │                           │
    │                           │                           ├─ Detects <!-- MOBILE_DONE -->
    │◄─ agent.status:completed─┤◄──────────────────────────┤  marker → resolves
    │                           │                           │
```

### Relay File Instruction (System Context)

The relay file writing instruction is now delivered via `.github/copilot-instructions.md`,
which VS Code injects as system context into every Copilot conversation automatically.
No prompt augmentation is needed — the raw user prompt is passed directly to
`workbench.action.chat.open`.

### File Watcher Mechanism

- Watches `.copilot-mobile-relay.md` in the workspace root
- Polls every 5 seconds + file system watcher (throttled)
- Uses `findSafeBreak()` to send only complete sentences/paragraphs
- When `<!-- MOBILE_DONE -->` marker detected: flushes remaining content, resolves
- 90-second idle timeout: if no new content after receiving some, auto-resolves (accounts for tool execution pauses)
- 3-minute absolute timeout: if no file written at all, rejects with error

### Key Files

| File | Purpose |
|------|---------|
| `packages/adapter-vscode/src/server.ts` | Main server — relay listeners, RPC handlers, capture strategies |
| `packages/adapter-vscode/src/relay-client.ts` | WebSocket host connection to relay server |
| `packages/adapter-vscode/src/extension.ts` | Extension activation, command registration |
| `packages/adapter-vscode/src/copilot.ts` | `vscode.lm` API wrapper (raw LLM only, no tools) |
| `packages/adapter-vscode/src/interceptor.ts` | Alternative capture via document change monitoring |
| `packages/adapter-vscode/src/agent.ts` | AgentOperations — context building |
| `packages/mobile-app/src/api/rpc.ts` | JSON-RPC client for mobile |
| `packages/mobile-app/src/api/connection.ts` | WebSocket connection manager |
| `packages/mobile-app/src/store/AppStore.ts` | Zustand state store |
| `packages/relay-server/src/index.ts` | Relay server — room management, message forwarding |

### Config Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `mobileCopilot.relayUrl` | (none) | Relay server WebSocket URL |
| `mobileCopilot.captureMode` | `relay` | How to capture responses: `relay`, `interceptor`, or `hybrid` |
| `mobileCopilot.port` | `3847` | Local HTTP server port |
| `mobileCopilot.modelFamily` | (auto) | LLM model family for raw chat |

### Build & Install Cycle

```bash
cd packages/adapter-vscode
node esbuild.js                                    # Build extension
npx @vscode/vsce package --no-dependencies -o mobile-copilot.vsix  # Package
code --install-extension mobile-copilot.vsix --force  # Install
# Then: Developer: Reload Window in VS Code
# Then: run Mobile Copilot: Connect Cloud Relay command
```

---

## Fix 1: textShadow Deprecation Warning (ConnectScreen.tsx)

**File:** `packages/mobile-app/src/screens/ConnectScreen.tsx`

**Problem:** React Native deprecated individual `textShadowColor`, `textShadowOffset`, and `textShadowRadius` style props, logging warnings in the console.

**Fix:** Replaced with shorthand `textShadow` CSS property:
```tsx
// Before (deprecated)
textShadowColor: 'rgba(0,0,0,0.3)',
textShadowOffset: { width: 0, height: 2 },
textShadowRadius: 4,

// After
textShadow: '0px 2px 4px rgba(0,0,0,0.3)',
```

---

## Fix 2: Auto-Reconnect to Stale Rooms (App.tsx)

**File:** `packages/mobile-app/App.tsx`

**Problem:** On app launch, the mobile app would auto-reconnect to a relay room using a stale room code even when no valid session existed, causing connection failures.

**Fix:** Added a `sessionId` check before auto-reconnecting. The app now requires both a saved room code AND a valid sessionId before attempting auto-reconnect.

---

## Fix 3: chat.sendToAgent Reverted to Capture Strategy (server.ts)

**File:** `packages/adapter-vscode/src/server.ts`

**Problem:** The `chat.sendToAgent` RPC handler was changed to use the `vscode.lm` API (via `CopilotBridge.sendPrompt()`), which only provides raw LLM chat WITHOUT tool use, file edits, or terminal access. This broke Copilot's full agent mode.

**Fix:** Reverted to the original capture-strategy pipeline:
1. `chat.sendToAgent` reads the `captureMode` config setting
2. Routes to either `runRelayCapture()` or `runInterceptorCapture()`
3. `runRelayCapture()` uses `workbench.action.chat.open` to send the prompt to VS Code's Chat panel
4. Copilot processes with full agent tools (file edits, terminal, etc.)
5. Extension watches `.copilot-mobile-relay.md` for the response
6. Response chunks stream back to mobile via relay

**Key insight:** `vscode.lm` API = raw LLM text only. `workbench.action.chat.open` = full Copilot agent with all tools.

---

## Fix 4: Auth Handshake — Direct Relay Send (server.ts)

**File:** `packages/adapter-vscode/src/server.ts`

**Problem:** When a mobile client connects via relay and sends an `auth` request, the extension was supposed to respond with `auth.success`. The original code used:
```typescript
const virtualWs = this.createRelayVirtualWs();
this.clients.set(virtualWs, { authenticated: true, sessionId: 'relay' });
this.registerSession('relay', virtualWs);
this.rpc.sendEvent(virtualWs, 'auth.success', { sessionId: 'relay' });
```

This pipeline:
1. Creates a virtual WebSocket (`Object.create(WebSocket.prototype)`) with a custom `send()` that routes through the relay
2. Registers it in the RPC system
3. Uses `rpc.sendEvent()` which calls `ws.send()` on the virtual WS

**The failure:** The virtual WS + RPC pipeline silently failed. The handler would log `━━━ Received message from mobile` but nothing after — no "Auth request received", no error. The code between message receipt and auth check was dying silently (likely due to the `Object.create(WebSocket.prototype)` virtual WS construction or a `readyState` check failing).

**Root cause theory:** `rpc.sendEvent()` checks `ws.readyState === WebSocket.OPEN` before sending. The virtual WS's `readyState` getter depends on `this.relay.isConnected`, which uses `this.ws && this.ws.readyState === WebSocket.OPEN`. During reconnection storms (where the old connection tries to rejoin while a new one is created), the relay client's internal `this.ws` reference may be in a transitional state.

**Fix:** Bypassed the virtual WS / RPC system entirely for auth:
```typescript
if (msg.method === 'auth') {
  const authResponse = JSON.stringify({
    id: msg.id || crypto.randomUUID(),
    type: 'event',
    method: 'auth.success',
    params: { sessionId: 'relay' },
  });
  this.relay.send(authResponse);
  // Then set up virtualWs for future non-auth messages
  const virtualWs = this.createRelayVirtualWs();
  this.clients.set(virtualWs, { authenticated: true, sessionId: 'relay' });
  this.registerSession('relay', virtualWs);
}
```

**Status:** Auth now works. Direct `relay.send()` is reliable; the virtual WS/RPC pipeline for auth was not.

---

## Known Issue: Virtual WS / RPC Pipeline

### Fix 5: createRelayVirtualWs Crash — readyState Getter Conflict

**File:** `packages/adapter-vscode/src/server.ts` — `createRelayVirtualWs()`

**Problem:** `Object.create(WebSocket.prototype)` inherits WebSocket's native `readyState` as a **getter-only** property. The code then tried:
```typescript
(virtualWs as any).readyState = WebSocket.OPEN;  // THROWS!
```
This throws `Cannot set property readyState of #<t> which has only a getter`. The error was silently swallowed by the VS Code event emitter, causing ALL non-auth relay messages (prompts, pings, etc.) to fail silently.

**Fix:** Changed `Object.create(WebSocket.prototype)` → `Object.create(null)` and removed the direct `readyState` assignment. The virtual WS doesn't need to inherit from WebSocket.prototype — it only needs `send()` and `readyState`:
```typescript
const virtualWs = Object.create(null) as WebSocket;
virtualWs.send = (data) => { this.relay.send(...); };
Object.defineProperty(virtualWs, 'readyState', {
  get: () => this.relay.isConnected ? WebSocket.OPEN : WebSocket.CLOSED,
  configurable: true,
});
```

**This was the ROOT CAUSE** of auth failing via `rpc.sendEvent()` too — the virtualWs creation always crashed before it could be used.

---

### Reconnection Storm

The relay client has a reconnection mechanism that can cause duplicate host connections:
1. Extension connects → room created
2. Extension disconnects (reload/reconnect)
3. Old connection's `scheduleReconnect()` fires → tries to rejoin
4. New connection also connects → creates conflict
5. Server kicks one with `4009 Replaced by new host connection`
6. Kicked connection reconnects again → loop

The `connect()` method doesn't cancel pending reconnect timers from previous connections.

---

## Architecture Reference

```
Mobile App → WebSocket → Relay Server → WebSocket → VS Code Extension
                                                        ↓
                                                   setupRelayListeners()
                                                        ↓
                                                   onMessage.event handler
                                                        ↓
                                              ┌─────────┴──────────┐
                                              │                    │
                                         auth message        other messages
                                              │                    │
                                        relay.send()      rpc.handleMessage()
                                        (direct)          (virtual WS)
```
