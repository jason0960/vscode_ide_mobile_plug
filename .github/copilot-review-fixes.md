# PR Review Fixes — Copilot Prompt

> Paste the contents of this file into Copilot Chat in VS Code to address all open PR review comments.

---

Please fix the following issues identified by the PR code reviewer. Each item lists the file, line range, and the exact change required.

---

## 1. `packages/relay-server/src/index.ts` — Lines 169–173 & 263–264
**Issue:** `log()` calls print up to 300 chars of raw HOST→CLIENTS and CLIENT→HOST payloads, which can contain user prompts and code, leaking sensitive content to server logs.

**Fix:** Add `const DEBUG_RELAY = process.env.DEBUG_RELAY === '1';` in the configuration block, then gate both payload log lines:
```ts
// Before (line 172):
log(`[Room ${code}] HOST→CLIENTS: ${raw.substring(0, 300)}`);
// After:
if (DEBUG_RELAY) { log(`[Room ${code}] HOST→CLIENTS (${raw.length} bytes): ${raw.substring(0, 300)}`); }

// Before (line 263):
log(`[Room ${code}] CLIENT→HOST: ${raw.substring(0, 300)}`);
// After:
if (DEBUG_RELAY) { log(`[Room ${code}] CLIENT→HOST (${raw.length} bytes): ${raw.substring(0, 300)}`); }
```

---

## 2. `packages/adapter-vscode/src/relay-client.ts` — Line 124
**Issue:** `console.log` prints raw message payload prefixes (up to 200 chars). This is noisy in normal use and may leak user prompts/code into logs.

**Fix:** Replace with a metadata-only logger call:
```ts
// Before:
console.log(`[MCR-DEBUG relay-client] Firing onMessage: ${raw.substring(0, 200)}`);
// After:
this.logger.info(`[Relay] Forwarding message to local handler (${raw.length} bytes)`);
```

---

## 3. `packages/mobile-app/App.tsx` — Top of file (before other imports)
**Issue:** `react-native-gesture-handler` requires its side-effect import to run before React Navigation to avoid native gesture crashes.

**Fix:** Add as the very first import:
```ts
// Add BEFORE all other imports:
import 'react-native-gesture-handler';
```

---

## 4. `.vscode/tasks.json` — Lines 7–23
**Issue:** Three tasks with the same label "Metro Dev Server" (ambiguous). Two use absolute machine-specific paths (`/home/jason/...`) which are not portable across contributors.

**Fix:** Collapse to a single, uniquely-labelled task using `${workspaceFolder}`:
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start Mobile App (Metro)",
      "type": "shell",
      "command": "cd ${workspaceFolder}/packages/mobile-app && CI=1 EXPO_NO_TYPESCRIPT_SETUP=1 npx expo start --web --clear",
      "isBackground": true,
      "problemMatcher": []
    }
  ]
}
```

---

## 5. `packages/mobile-app/src/components/CommandCenterDrawer.tsx` — Line 3
**Issue:** Spelling typo "VibeCcoders" (double 'c').

**Fix:**
```ts
// Before:
 * Designed for AI developers and VibeCcoders.
// After:
 * Designed for AI developers and VibeCoders.
```

---

## 6. `packages/adapter-core/src/base-server.ts` — Lines 116–126
**Issue:** `/api/pair-info` uses a weak `ip.includes(...)` loopback check and the global `Access-Control-Allow-Origin: *` CORS policy applies to it, meaning a malicious webpage on the same machine could read the pairing token.

**Fix:**
1. Add `import * as net from 'net';` at the top.
2. Replace the endpoint with a strict check and restricted CORS, also gated behind `DEBUG_PAIR=1`:
```ts
this.app.get('/api/pair-info', async (req, res) => {
  if (process.env.DEBUG_PAIR !== '1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rawIp = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isLoopback = rawIp === '127.0.0.1' || rawIp === '::1';
  if (!isLoopback) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const token = await this.auth.getToken();
  const serverUrl = `http://localhost:${this.port}`;
  res.header('Access-Control-Allow-Origin', `http://localhost:${this.port}`);
  res.json({ token, pairingUrl: `${serverUrl}/pair?token=${token}`, wsUrl: `ws://localhost:${this.port}/ws` });
});
```

---

## 7. `packages/adapter-vscode/src/server.ts` — Lines 214–218
**Issue:** Stray `console.log('[MCR-DEBUG] setupRelayListeners called')` and `disposable` is assigned but never stored/disposed, risking a memory leak.

**Fix:**
```ts
// Before:
private setupRelayListeners(): void {
  console.log('[MCR-DEBUG] setupRelayListeners called');
  this.logger.info('[Relay] Setting up relay listeners');
  const disposable = this.relay.onMessage.event((raw: string) => {
    // ...
  });

// After:
private setupRelayListeners(): void {
  this.logger.info('[Relay] Setting up relay listeners');
  this.disposables.push(this.relay.onMessage.event((raw: string) => {
    // ...
  }));
```

---

## 8. `packages/adapter-vscode/src/server.ts` — Lines 769–772 (also `src/server.ts` line ~845)
**Issue:** `Buffer.from(bytes).toString('utf8').trim()` strips leading and trailing whitespace, which can remove trailing newlines needed for code-fence detection in `findSafeBreak` and shifts `sentLength` indices, potentially stalling streaming around code blocks.

**Fix:** Use `trimEnd()` instead:
```ts
// Before:
const content = Buffer.from(bytes).toString('utf8').trim();
// After:
const content = Buffer.from(bytes).toString('utf8').trimEnd();
```
Apply this change in both `packages/adapter-vscode/src/server.ts` and `src/server.ts`.

---

## 9. `packages/adapter-vscode/src/server.ts` — Lines 851–856
**Issue:** `vscode.commands.getCommands(true)` is expensive (returns all registered commands) and is called on every relay capture. This adds noise and overhead in normal use.

**Fix:** Gate it behind an explicit debug environment variable:
```ts
// Before:
// Also log available commands for debugging
vscode.commands.getCommands(true).then(cmds => {
  const chatCmds = cmds.filter(c => c.includes('chat'));
  this.logger.info(`[Relay] Available chat commands: ${chatCmds.join(', ')}`);
});

// After:
// Log available chat commands only when debug logging is enabled
if (process.env.MCR_DEBUG === '1') {
  vscode.commands.getCommands(true).then(cmds => {
    const chatCmds = cmds.filter(c => c.includes('chat'));
    this.logger.info(`[Relay] Available chat commands: ${chatCmds.join(', ')}`);
  });
}
```

---

## 10. `packages/mobile-app/package.json` — Lines 21–34 (documentation note)
**Issue:** `react-native-gesture-handler` and `react-native-reanimated` require additional native setup. Ensure the Reanimated Babel plugin is configured in `babel.config.js` and the gesture handler import is at the entry point (see fix #3 above).

**Verify** `babel.config.js` includes:
```js
plugins: ['react-native-reanimated/plugin']
```
