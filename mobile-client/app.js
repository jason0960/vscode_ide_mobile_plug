/* ═══════════════════════════════════════════════════════════
   Mobile Copilot — PWA Client Application
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────

  const state = {
    ws: null,
    sessionId: null,
    token: null,
    connected: false,
    authenticated: false,
    messages: [],
    currentStreamId: null,
    streamBuffer: '',
    pendingRequests: new Map(),
    requestIdCounter: 0,
    selectedModel: 'gpt-4o',
    contextAttachments: [],
    currentPath: '',    // For file browser
    terminalHistory: [],
    chatMode: 'agent',  // 'agent' (passthrough to real Copilot Chat) or 'chat' (raw LLM)
    agentWorking: false, // True when agent is processing a passthrough request
  };

  // ─── DOM Elements ─────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    connectScreen: $('#connect-screen'),
    mainScreen: $('#main-screen'),
    connectStatus: $('#connect-status'),
    reconnectBtn: $('#reconnect-btn'),
    navToggle: $('#nav-toggle'),
    navDrawer: $('#nav-drawer'),
    navOverlay: $('#nav-overlay'),
    workspaceName: $('#workspace-name'),
    connectionIndicator: $('#connection-indicator'),
    newChatBtn: $('#new-chat-btn'),
    chatMessages: $('#chat-messages'),
    chatInput: $('#chat-input'),
    sendBtn: $('#send-btn'),
    attachBtn: $('#attach-btn'),
    contextBar: $('#context-bar'),
    contextItems: $('#context-items'),
    fileTree: $('#file-tree'),
    fileViewer: $('#file-viewer'),
    viewerFilename: $('#viewer-filename'),
    viewerContent: $('#viewer-content code'),
    closeViewerBtn: $('#close-viewer-btn'),
    refreshFilesBtn: $('#refresh-files-btn'),
    terminalOutput: $('#terminal-output'),
    terminalInput: $('#terminal-input'),
    terminalSendBtn: $('#terminal-send-btn'),
    diagnosticsList: $('#diagnostics-list'),
    diagSummary: $('#diag-summary'),
    diagBadge: $('#diag-badge'),
    themeSelect: $('#theme-select'),
    modelSelect: $('#model-select'),
    serverInfo: $('#server-info'),
    disconnectBtn: $('#disconnect-btn'),
  };

  // ─── Chat History Persistence ─────────────────────────

  function saveChatHistory() {
    try {
      // Keep last 200 messages to avoid localStorage bloat
      const toSave = state.messages.slice(-200);
      localStorage.setItem('mc-chat-history', JSON.stringify(toSave));
    } catch (e) {
      console.warn('[History] Failed to save:', e);
    }
  }

  function loadChatHistory() {
    try {
      const raw = localStorage.getItem('mc-chat-history');
      if (raw) {
        const messages = JSON.parse(raw);
        if (Array.isArray(messages) && messages.length > 0) {
          state.messages = messages;
          return true;
        }
      }
    } catch (e) {
      console.warn('[History] Failed to load:', e);
    }
    return false;
  }

  function renderChatHistory() {
    if (state.messages.length === 0) return;
    // Clear welcome message
    const welcome = dom.chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    // Render each saved message
    state.messages.forEach((msg) => renderMessage(msg));
    scrollToBottom();
  }

  // ─── Notifications ────────────────────────────────────

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      // Must be called from a user gesture on mobile browsers
      Notification.requestPermission().then((perm) => {
        console.log('[Notify] Permission:', perm);
      });
    }
  }

  function notifyResponseComplete(preview) {
    // Vibrate — strong pattern so user feels it
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 200]);
    }

    // Browser notification — works whether tab is visible or not on mobile
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const body = preview
          ? preview.replace(/[#*`_~>]/g, '').substring(0, 120) + (preview.length > 120 ? '...' : '')
          : 'Response ready';
        const n = new Notification('Copilot Response Ready', {
          body,
          icon: '/icons/icon-192.png',
          tag: 'copilot-response',
          renotify: true,
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        // Auto-close after 8s
        setTimeout(() => n.close(), 8000);
      } catch (e) {
        // Some browsers don't support Notification constructor from SW context
        console.warn('[Notify] Notification failed:', e);
      }
    }

    // Also try audio beep as fallback
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.3;
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      // AudioContext may not be available
    }
  }

  // ─── Init ─────────────────────────────────────────────

  function init() {
    // Load saved settings
    loadSettings();

    // Load chat history from localStorage
    const hasHistory = loadChatHistory();

    // Render chat history immediately (even before connecting)
    if (hasHistory) {
      showMainScreen();
      renderChatHistory();
      state._historyRendered = true;
    }

    // Check for pairing token in URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      state.token = token;
      localStorage.setItem('mc-token', token);
      // Clean URL
      window.history.replaceState({}, '', '/');
    } else {
      state.token = localStorage.getItem('mc-token');
    }

    state.sessionId = localStorage.getItem('mc-session');

    // Setup UI events
    setupEventListeners();

    // Reconnect when phone wakes up (screen on / tab visible again)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.connected && (state.token || state.sessionId)) {
        console.log('[WS] Phone woke up, reconnecting...');
        connect();
      }
    });

    // Connect
    if (state.token || state.sessionId) {
      connect();
    } else {
      showConnectError('Scan the QR code in VS Code to connect');
    }
  }

  // ─── WebSocket Connection ─────────────────────────────

  function connect() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

    setConnectStatus('Connecting...', '');
    updateIndicator('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      state.ws = new WebSocket(wsUrl);
    } catch (err) {
      showConnectError('Failed to connect: ' + err.message);
      return;
    }

    state.ws.onopen = () => {
      console.log('[WS] Connected');
      setConnectStatus('Connected, authenticating...', 'success');
    };

    state.ws.onmessage = (event) => {
      handleWsMessage(event.data);
    };

    state.ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason);
      state.connected = false;
      state.authenticated = false;
      updateIndicator('offline');

      if (event.code === 4003) {
        // Auth explicitly rejected — token/session invalid, need new QR scan
        localStorage.removeItem('mc-session');
        localStorage.removeItem('mc-token');
        state.sessionId = null;
        state.token = null;
        showConnectError('Authentication failed. Rescan the QR code.');
        return;
      }

      // Normal disconnect (phone sleep, network drop, server restart)
      // Keep credentials and auto-reconnect
      setTimeout(() => {
        if (!state.connected) {
          setConnectStatus('Reconnecting...', '');
          connect();
        }
      }, 3000);
    };

    state.ws.onerror = () => {
      console.log('[WS] Error');
    };
  }

  function authenticate() {
    if (state.sessionId) {
      sendRaw({ id: genId(), type: 'request', method: 'auth', params: { sessionId: state.sessionId } });
    } else if (state.token) {
      // First, get session via HTTP
      fetch(`/api/auth?token=${encodeURIComponent(state.token)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.sessionId) {
            state.sessionId = data.sessionId;
            localStorage.setItem('mc-session', data.sessionId);
            sendRaw({ id: genId(), type: 'request', method: 'auth', params: { sessionId: data.sessionId } });
          } else {
            showConnectError('Invalid token. Rescan QR code.');
          }
        })
        .catch(() => {
          // Fall back to token-based WS auth
          sendRaw({ id: genId(), type: 'request', method: 'auth', params: { token: state.token } });
        });
    } else {
      showConnectError('No credentials. Scan the QR code.');
    }
  }

  function handleWsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] Invalid JSON:', raw);
      return;
    }

    // Handle events
    if (msg.type === 'event') {
      handleEvent(msg);
      return;
    }

    // Handle streaming chunks
    if (msg.type === 'stream') {
      handleStreamChunk(msg);
      return;
    }

    // Handle responses
    if (msg.type === 'response' || msg.type === 'error') {
      const pending = state.pendingRequests.get(msg.id);
      if (pending) {
        state.pendingRequests.delete(msg.id);
        if (msg.type === 'error') {
          pending.reject(new Error(msg.error?.message || 'Unknown error'));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
  }

  function handleEvent(msg) {
    switch (msg.method) {
      case 'connection.ready':
        authenticate();
        break;

      case 'auth.success':
        state.authenticated = true;
        state.connected = true;
        state.sessionId = msg.params.sessionId;
        localStorage.setItem('mc-session', msg.params.sessionId);
        showMainScreen();
        updateIndicator('online');
        loadWorkspaceInfo();
        loadDiagnostics();
        // Render restored chat history after auth (if not already rendered)
        if (state.messages.length > 0 && !state._historyRendered) {
          renderChatHistory();
          state._historyRendered = true;
        }
        break;

      case 'auth.failed':
        showConnectError('Authentication failed. Rescan QR code.');
        break;

      case 'session.missedResponse':
        // Server replayed a response we missed while disconnected
        handleMissedResponse(msg.params);
        break;

      case 'diagnostics.changed':
        updateDiagBadge(msg.params);
        break;

      case 'editor.changed':
        // Could update UI to show current file
        break;

      case 'agent.activity':
        // Real-time agent activity feed — shows what Copilot is doing
        if (state.agentWorking) {
          appendAgentActivity(msg.params);
        }
        break;

      case 'agent.status':
        handleAgentStatus(msg.params);
        break;

      case 'file.created':
      case 'file.changed':
      case 'file.deleted':
        // Refresh file tree if visible
        const filesPanel = $('#panel-files');
        if (filesPanel && filesPanel.classList.contains('active')) {
          loadFileTree();
        }
        break;
    }
  }

  // ─── RPC Client ───────────────────────────────────────

  function sendRaw(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function rpcRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = genId();
      state.pendingRequests.set(id, { resolve, reject });
      sendRaw({ id, type: 'request', method, params });

      setTimeout(() => {
        if (state.pendingRequests.has(id)) {
          state.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);
    });
  }

  function rpcStream(method, params, onChunk) {
    return new Promise((resolve, reject) => {
      const id = genId();
      state.currentStreamId = id;
      state.streamBuffer = '';

      state.pendingRequests.set(id, {
        resolve: (result) => {
          state.currentStreamId = null;
          resolve(state.streamBuffer);
        },
        reject: (err) => {
          state.currentStreamId = null;
          reject(err);
        },
      });

      // Store chunk handler
      state.pendingRequests.get(id)._onChunk = onChunk;

      sendRaw({ id, type: 'request', method, params });

      // Extended timeout for streaming
      setTimeout(() => {
        if (state.pendingRequests.has(id)) {
          state.pendingRequests.delete(id);
          state.currentStreamId = null;
          resolve(state.streamBuffer);
        }
      }, 120000); // 2 minutes for long responses
    });
  }

  function handleStreamChunk(msg) {
    const pending = state.pendingRequests.get(msg.id);
    if (pending && pending._onChunk) {
      state.streamBuffer += msg.result;
      pending._onChunk(msg.result);
    }
  }

  // ─── Chat Logic ───────────────────────────────────────

  async function sendMessage(text) {
    if (!text.trim() || !state.authenticated) return;

    // Request notification permission on first user gesture (tap/send)
    requestNotificationPermission();

    // Add user message
    const userMsg = { role: 'user', content: text, timestamp: Date.now() };
    state.messages.push(userMsg);
    renderMessage(userMsg);
    saveChatHistory();

    // Clear input
    dom.chatInput.value = '';
    dom.chatInput.style.height = 'auto';
    dom.sendBtn.disabled = true;

    // Remove welcome message
    const welcome = dom.chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Scroll to bottom
    scrollToBottom();

    if (state.chatMode === 'agent') {
      // ── AGENT MODE: Passthrough to real Copilot Chat ──
      await sendAgentMessage(text);
    } else {
      // ── CHAT MODE: Raw LLM via vscode.lm API ──
      await sendChatMessage(text);
    }

    scrollToBottom();
  }

  /**
   * Agent Mode — sends prompt to @mobile Chat Participant in VS Code.
   * The participant calls the Copilot LM and streams the response
   * to both the VS Code Chat panel AND back here via WebSocket.
   * We get the REAL Copilot response, not just activity events.
   */
  async function sendAgentMessage(text) {
    // Create a streaming response container (same UX as chat mode)
    const assistantEl = createAssistantPlaceholder();

    // Show that we're using Agent mode
    const header = assistantEl.querySelector('.message-header');
    if (header) {
      const badge = document.createElement('span');
      badge.className = 'agent-badge';
      badge.textContent = 'AGENT';
      header.appendChild(badge);
    }

    state.agentWorking = true;

    try {
      const fullResponse = await rpcStream(
        'chat.sendToAgent',
        { prompt: text },
        (chunk) => {
          // Stream each token into the message
          appendToAssistant(assistantEl, chunk);
          scrollToBottom();
        }
      );

      // Finalize the message
      const content = fullResponse || state.streamBuffer;
      finalizeAssistant(assistantEl, content);

      state.messages.push({
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });
      saveChatHistory();
      notifyResponseComplete(content);

    } catch (err) {
      finalizeAssistant(assistantEl, `**Error:** ${err.message}`);
      state.messages.push({
        role: 'assistant',
        content: `**Error:** ${err.message}`,
        timestamp: Date.now(),
      });
      saveChatHistory();
    }

    state.agentWorking = false;
  }

  /**
   * Handle a missed response replayed by the server after reconnection.
   * This fires when the phone was disconnected while an agent response was
   * being streamed. The server accumulated the full content and sends it
   * as a `session.missedResponse` event on re-auth.
   */
  function handleMissedResponse(params) {
    const { content, complete, timestamp } = params;
    if (!content || content.length === 0) return;

    console.log(`[Session] Received missed response: ${content.length} chars, complete=${complete}`);

    // Check if this content already matches the last assistant message
    // (avoid duplicates if the phone only briefly disconnected)
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === content) {
      console.log('[Session] Missed response matches last message, skipping duplicate');
      return;
    }

    // If there's a partial/empty assistant message from the interrupted stream,
    // check if the missed response is a superset and replace it
    if (lastMsg && lastMsg.role === 'assistant' && content.startsWith(lastMsg.content)) {
      // The missed response extends the partial — update in place
      lastMsg.content = content;
      lastMsg.timestamp = timestamp || Date.now();
      saveChatHistory();

      // Re-render the last message
      const lastEl = dom.chatMessages.querySelector('.message.assistant:last-child');
      if (lastEl) {
        finalizeAssistant(lastEl, content);
      }
      console.log('[Session] Updated partial message with complete response');
      notifyResponseComplete(content);
      scrollToBottom();
      return;
    }

    // Render as a new message with a reconnect indicator
    const el = document.createElement('div');
    el.className = 'message assistant';
    const time = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <div class="message-header">
        <span class="message-role assistant">Copilot</span>
        <span class="reconnect-badge">reconnected</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body">${renderMarkdown(content)}</div>
    `;
    dom.chatMessages.appendChild(el);
    addCopyButtons(el);

    // Save to chat history
    state.messages.push({
      role: 'assistant',
      content,
      timestamp: timestamp || Date.now(),
    });
    saveChatHistory();
    notifyResponseComplete(content);
    scrollToBottom();

    // Also stop the agent working indicator if it was still up
    state.agentWorking = false;
  }

  /**
   * Chat Mode — raw LLM streaming via vscode.lm API.
   * Good for quick questions, no tool/agent capabilities.
   */
  async function sendChatMessage(text) {
    // Create assistant message placeholder
    const assistantEl = createAssistantPlaceholder();

    // Build history (last 20 messages)
    const history = state.messages.slice(-20, -1).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    try {
      const fullResponse = await rpcStream(
        'chat.send',
        {
          prompt: text,
          history,
          context: state.contextAttachments.length > 0 ? state.contextAttachments : undefined,
          model: state.selectedModel,
        },
        (chunk) => {
          appendToAssistant(assistantEl, chunk);
          scrollToBottom();
        }
      );

      const chatContent = fullResponse || state.streamBuffer;
      finalizeAssistant(assistantEl, chatContent);

      state.messages.push({
        role: 'assistant',
        content: chatContent,
        timestamp: Date.now(),
      });
      saveChatHistory();
      notifyResponseComplete(chatContent);

      state.contextAttachments = [];
      updateContextBar();
    } catch (err) {
      finalizeAssistant(assistantEl, `**Error:** ${err.message}`);
      state.messages.push({
        role: 'assistant',
        content: `**Error:** ${err.message}`,
        timestamp: Date.now(),
      });
      saveChatHistory();
    }
  }

  // ─── Agent Mode UI Helpers ────────────────────────────

  function createAgentPlaceholder() {
    const el = document.createElement('div');
    el.className = 'message assistant agent-message';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
      <div class="message-header">
        <span class="message-role assistant">Copilot Agent</span>
        <span class="agent-badge">AGENT MODE</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="agent-status working">
        <div class="agent-spinner"></div>
        <span>Sending to Copilot Chat...</span>
      </div>
      <div class="agent-activity-feed"></div>
      <div class="agent-actions" style="display:none">
        <button class="agent-done-btn" onclick="window.__agentDone(this)">Mark Done</button>
      </div>
    `;

    dom.chatMessages.appendChild(el);
    // Store reference to the current agent element for activity updates
    state._currentAgentEl = el;
    return el;
  }

  function updateAgentStatus(el, status, text) {
    const statusEl = el.querySelector('.agent-status');
    if (!statusEl) return;

    statusEl.className = `agent-status ${status}`;

    if (status === 'working') {
      statusEl.innerHTML = `<div class="agent-spinner"></div><span>${text}</span>`;
      el.querySelector('.agent-actions').style.display = '';
    } else if (status === 'error') {
      statusEl.innerHTML = `<span class="agent-error">${text}</span>`;
      state.agentWorking = false;
    } else if (status === 'done') {
      statusEl.innerHTML = `<span class="agent-done">${text}</span>`;
      el.querySelector('.agent-actions').style.display = 'none';
      state.agentWorking = false;
    }
  }

  function appendAgentActivity(activity) {
    const el = state._currentAgentEl;
    if (!el) return;

    const feed = el.querySelector('.agent-activity-feed');
    if (!feed) return;

    const activityEl = document.createElement('div');
    activityEl.className = `activity-item activity-${activity.type}`;

    const icon = {
      'edit': '✏️',
      'file-created': '📄',
      'file-changed': '💾',
      'file-deleted': '🗑️',
      'file-saved': '✅',
      'terminal': '🖥️',
      'editor': '📂',
      'diagnostics': '🔍',
    }[activity.type] || '📌';

    const time = new Date(activity.timestamp).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // Build the main activity line
    let html = `<span class="activity-icon">${icon}</span><span class="activity-detail">${escapeHtml(activity.detail)}</span><span class="activity-time">${time}</span>`;

    // If this is an edit with diff data, add an expandable diff preview
    if (activity.type === 'edit' && activity.diff) {
      const d = activity.diff;
      const diffId = 'diff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      html += `<button class="diff-toggle" onclick="document.getElementById('${diffId}').classList.toggle('expanded')" title="Show diff">▸</button>`;
      html += `<div id="${diffId}" class="diff-preview">`;
      html += `<div class="diff-stats"><span class="diff-added">+${d.linesAdded}</span> <span class="diff-removed">-${d.linesRemoved}</span> in <a class="diff-file-link" href="#" onclick="window.__openFile('${escapeHtml(d.path)}'); return false;"><strong>${escapeHtml(d.path)}</strong></a></div>`;
      if (d.changes && d.changes.length > 0) {
        for (const change of d.changes) {
          html += `<div class="diff-change"><span class="diff-range">${escapeHtml(change.range)}</span>`;
          if (change.preview) {
            html += `<pre class="diff-code">${escapeHtml(change.preview)}</pre>`;
          }
          html += `</div>`;
        }
      }
      html += `</div>`;
    }

    activityEl.innerHTML = html;

    feed.appendChild(activityEl);

    // Keep only last 50 activity items
    while (feed.children.length > 50) {
      feed.removeChild(feed.firstChild);
    }

    scrollToBottom();
  }

  // Global handler for "Mark Done" button
  window.__agentDone = function (btn) {
    const agentEl = btn.closest('.agent-message');
    if (agentEl) {
      const feed = agentEl.querySelector('.agent-activity-feed');
      const count = feed ? feed.children.length : 0;
      updateAgentStatus(agentEl, 'done', `Agent finished — ${count} workspace action${count !== 1 ? 's' : ''} detected`);
    }
    state.agentWorking = false;
  };

  // ─── Feature: Open File from Diff ─────────────────────

  /**
   * Global handler: tap a file path in a diff preview to open it in VS Code.
   */
  window.__openFile = function (filePath) {
    if (!state.authenticated) return;
    rpcRequest('editor.open', { path: filePath }).then(() => {
      console.log(`[Open] Opened ${filePath} in VS Code`);
    }).catch((err) => {
      console.error(`[Open] Failed to open ${filePath}:`, err);
    });
  };

  // ─── Feature: Unified Diff Renderer ────────────────────

  /**
   * Render a unified diff string into syntax-highlighted HTML.
   * Lines starting with + are green (added), - are red (removed),
   * @@ are blue (hunk headers), and the rest are dimmed context.
   */
  function renderUnifiedDiff(diffText) {
    const lines = diffText.split('\n');
    let html = '<div class="unified-diff">';
    let lineNumOld = 0;
    let lineNumNew = 0;

    for (const line of lines) {
      // Skip diff header lines (---, +++, diff --git, index)
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      if (line.startsWith('@@')) {
        // Parse hunk header for line numbers
        const match = line.match(/@@ -(\d+)/);
        if (match) lineNumOld = parseInt(match[1], 10);
        const matchNew = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        if (matchNew) lineNumNew = parseInt(matchNew[1], 10);
        html += `<div class="diff-line diff-hunk"><span class="diff-line-num"></span><span class="diff-line-num"></span><span class="diff-line-content">${escapeHtml(line)}</span></div>`;
        continue;
      }

      if (line.startsWith('+')) {
        html += `<div class="diff-line diff-line-added"><span class="diff-line-num"></span><span class="diff-line-num">${lineNumNew}</span><span class="diff-line-content">${escapeHtml(line)}</span></div>`;
        lineNumNew++;
      } else if (line.startsWith('-')) {
        html += `<div class="diff-line diff-line-removed"><span class="diff-line-num">${lineNumOld}</span><span class="diff-line-num"></span><span class="diff-line-content">${escapeHtml(line)}</span></div>`;
        lineNumOld++;
      } else {
        // Context line
        html += `<div class="diff-line diff-line-context"><span class="diff-line-num">${lineNumOld}</span><span class="diff-line-num">${lineNumNew}</span><span class="diff-line-content">${escapeHtml(line || ' ')}</span></div>`;
        lineNumOld++;
        lineNumNew++;
      }
    }

    html += '</div>';
    return html;
  }

  // ─── Feature: Agent Status Indicator ──────────────────

  /**
   * Handle agent.status events from the server.
   * Shows a persistent status banner while the agent is running,
   * and Accept/Revert buttons when it completes with file changes.
   */
  function handleAgentStatus(params) {
    const { status, modifiedFiles, error, diffs } = params;

    // Update or create the status banner
    let banner = $('#agent-status-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'agent-status-banner';
      // Insert at top of chat messages
      dom.chatMessages.insertBefore(banner, dom.chatMessages.firstChild);
    }

    switch (status) {
      case 'running':
        banner.className = 'agent-status-banner running';
        banner.innerHTML = `<div class="agent-spinner"></div><span>Agent running…</span>`;
        banner.style.display = '';
        break;

      case 'completed': {
        const fileCount = modifiedFiles?.length || 0;
        banner.className = 'agent-status-banner completed';
        let html = `<span class="status-icon">✅</span><span>Agent completed</span>`;

        if (fileCount > 0) {
          // Store modified files for revert
          state._lastModifiedFiles = modifiedFiles;

          // Collapsible "Code Changes" dropdown
          const dropdownId = 'code-changes-' + Date.now();
          html += `<div class="code-changes-dropdown">`;
          html += `<div class="code-changes-toggle" onclick="document.getElementById('${dropdownId}').classList.toggle('expanded'); this.classList.toggle('open')">`;
          html += `<span class="code-changes-arrow">▸</span>`;
          html += `<span>Code Changes</span>`;
          html += `<span class="code-changes-badge">${fileCount} file${fileCount !== 1 ? 's' : ''}</span>`;
          html += `</div>`;
          html += `<div id="${dropdownId}" class="code-changes-content">`;

          html += `<div class="agent-change-actions">`;
          html += `<button class="change-accept-btn" onclick="window.__acceptChanges()">Accept Changes</button>`;
          html += `<button class="change-revert-btn" onclick="window.__revertChanges()">Revert Changes</button>`;
          html += `</div>`;

          // Render full unified diffs if available
          if (diffs && diffs.length > 0) {
            html += `<div class="agent-diffs">`;
            for (const fileDiff of diffs) {
              const diffId = 'udiff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
              html += `<div class="agent-diff-file">`;
              html += `<div class="agent-diff-header" onclick="document.getElementById('${diffId}').classList.toggle('expanded')">`;
              html += `<span class="agent-diff-arrow">▸</span>`;
              html += `<a class="diff-file-link" href="#" onclick="event.stopPropagation(); window.__openFile('${escapeHtml(fileDiff.path)}'); return false;">${escapeHtml(fileDiff.path)}</a>`;
              // Count added/removed lines
              const lines = fileDiff.diff.split('\n');
              const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
              const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
              html += `<span class="diff-stats"><span class="diff-added">+${added}</span> <span class="diff-removed">-${removed}</span></span>`;
              html += `</div>`;
              html += `<div id="${diffId}" class="agent-diff-body">`;
              html += renderUnifiedDiff(fileDiff.diff);
              html += `</div></div>`;
            }
            html += `</div>`;
          } else {
            // Fallback: just list modified files
            html += `<div class="modified-files-list">`;
            for (const f of modifiedFiles) {
              html += `<div class="modified-file"><a href="#" onclick="window.__openFile('${escapeHtml(f)}'); return false;">${escapeHtml(f)}</a></div>`;
            }
            html += `</div>`;
          }

          html += `</div></div>`; // close code-changes-content + dropdown
        }

        banner.innerHTML = html;
        // Banner stays until Accept/Revert — no auto-hide
        break;
      }

      case 'failed':
        banner.className = 'agent-status-banner failed';
        banner.innerHTML = `<span class="status-icon">❌</span><span>Agent failed${error ? ': ' + escapeHtml(error) : ''}</span>`;
        setTimeout(() => { banner.style.display = 'none'; }, 10000);
        break;

      default:
        banner.style.display = 'none';
    }

    scrollToBottom();
  }

  // ─── Feature: Accept / Revert Changes ──────────────────

  window.__acceptChanges = function () {
    const banner = $('#agent-status-banner');
    if (banner) {
      banner.className = 'agent-status-banner accepted';
      banner.innerHTML = `<span class="status-icon">✅</span><span>Changes accepted</span>`;
      setTimeout(() => { banner.style.display = 'none'; }, 3000);
    }
    state._lastModifiedFiles = null;
  };

  window.__revertChanges = async function () {
    const banner = $('#agent-status-banner');
    if (!banner) return;

    const files = state._lastModifiedFiles;
    banner.innerHTML = `<div class="agent-spinner"></div><span>Reverting changes…</span>`;
    banner.className = 'agent-status-banner running';

    try {
      const result = await rpcRequest('git.restoreChanges', { files }, 30000);
      banner.className = 'agent-status-banner accepted';
      banner.innerHTML = `<span class="status-icon">↩️</span><span>Reverted ${result.restored} file${result.restored !== 1 ? 's' : ''}</span>`;
      state._lastModifiedFiles = null;
      setTimeout(() => { banner.style.display = 'none'; }, 5000);
    } catch (err) {
      banner.className = 'agent-status-banner failed';
      banner.innerHTML = `<span class="status-icon">❌</span><span>Revert failed: ${escapeHtml(err.message)}</span>`;
      setTimeout(() => { banner.style.display = 'none'; }, 8000);
    }
  };

  function renderMessage(msg) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
      <div class="message-header">
        <span class="message-role ${msg.role}">${msg.role === 'user' ? 'You' : 'Copilot'}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body">${msg.role === 'user' ? escapeHtml(msg.content) : renderMarkdown(msg.content)}</div>
    `;

    dom.chatMessages.appendChild(el);
    addCopyButtons(el);
  }

  function createAssistantPlaceholder() {
    const el = document.createElement('div');
    el.className = 'message assistant';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
      <div class="message-header">
        <span class="message-role assistant">Copilot</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body streaming-cursor">
        <div class="thinking"><span></span><span></span><span></span></div>
      </div>
    `;

    dom.chatMessages.appendChild(el);
    el._rawContent = '';
    return el;
  }

  function appendToAssistant(el, chunk) {
    el._rawContent += chunk;
    const body = el.querySelector('.message-body');
    body.innerHTML = renderMarkdown(el._rawContent);
    body.classList.add('streaming-cursor');
    addCopyButtons(el);
  }

  function finalizeAssistant(el, fullContent) {
    const body = el.querySelector('.message-body');
    body.innerHTML = renderMarkdown(fullContent);
    body.classList.remove('streaming-cursor');
    addCopyButtons(el);
  }

  function addCopyButtons(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-code-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-code-btn';
      btn.textContent = 'Copy';
      btn.onclick = () => {
        const code = pre.querySelector('code')?.textContent || pre.textContent;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = '✓ Copied';
          setTimeout(() => (btn.textContent = 'Copy'), 2000);
        });
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  // ─── Files Panel ──────────────────────────────────────

  async function loadFileTree(dirPath) {
    dom.fileTree.innerHTML = '<div class="loading">Loading...</div>';
    dom.fileViewer.style.display = 'none';
    dom.fileTree.style.display = '';

    try {
      let files;
      if (dirPath) {
        files = await rpcRequest('workspace.listDir', { path: dirPath });
      } else {
        files = await rpcRequest('workspace.fileTree', { maxDepth: 2 });
      }

      dom.fileTree.innerHTML = '';

      if (dirPath) {
        // Back button
        const backEl = document.createElement('div');
        backEl.className = 'file-item';
        backEl.innerHTML = '<span class="icon">⬆</span><span class="name directory">..</span>';
        backEl.onclick = () => {
          const parent = dirPath.split('/').slice(0, -1).join('/');
          loadFileTree(parent || undefined);
        };
        dom.fileTree.appendChild(backEl);
      }

      if (!files || files.length === 0) {
        dom.fileTree.innerHTML = '<div class="empty-state">No files found</div>';
        return;
      }

      for (const file of files) {
        const el = document.createElement('div');
        el.className = 'file-item';

        const icon = file.isDirectory ? '📁' : getFileIcon(file.name);
        el.innerHTML = `<span class="icon">${icon}</span><span class="name ${file.isDirectory ? 'directory' : ''}">${file.name}</span>`;

        if (file.isDirectory) {
          el.onclick = () => loadFileTree(file.path);
        } else {
          el.onclick = () => viewFile(file.path, file.name);
        }

        dom.fileTree.appendChild(el);
      }
    } catch (err) {
      dom.fileTree.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
  }

  async function viewFile(filePath, fileName) {
    dom.fileTree.style.display = 'none';
    dom.fileViewer.style.display = 'flex';
    dom.viewerFilename.textContent = fileName;
    dom.viewerContent.textContent = 'Loading...';

    try {
      const result = await rpcRequest('file.read', { path: filePath });
      dom.viewerContent.textContent = result.content;
      if (window.hljs) {
        window.hljs.highlightElement(dom.viewerContent);
      }
    } catch (err) {
      dom.viewerContent.textContent = `Error: ${err.message}`;
    }
  }

  // ─── Terminal Panel ───────────────────────────────────

  async function runTerminalCommand(command) {
    if (!command.trim()) return;

    // Display command
    appendTerminalOutput(`$ ${command}`, 'cmd');
    state.terminalHistory.push(command);

    dom.terminalInput.value = '';

    try {
      const result = await rpcRequest('terminal.run', { command }, 60000);
      if (result.output) {
        appendTerminalOutput(result.output, 'output');
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          appendTerminalOutput(`[Exit code: ${result.exitCode}]`, 'error');
        }
      } else {
        appendTerminalOutput(`Sent to terminal: ${result.terminalName}`, 'output');
      }
    } catch (err) {
      appendTerminalOutput(`Error: ${err.message}`, 'error');
    }
  }

  function appendTerminalOutput(text, className) {
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    dom.terminalOutput.appendChild(line);
    dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
  }

  // ─── Quick Commands Panel ─────────────────────────────

  async function runQuickCommand(command, needsInput, inputPrompt) {
    if (!state.authenticated) return;

    let finalCmd = command;

    // If the command requires user input (e.g., commit message), prompt for it
    if (needsInput) {
      const userInput = prompt(inputPrompt || 'Enter value:');
      if (userInput === null || userInput.trim() === '') return; // cancelled
      finalCmd = command.replace('{input}', userInput.trim());
    }

    // Show output area
    const outputEl = $('#command-output');
    const titleEl = $('#command-output-title');
    const contentEl = $('#command-output-content');

    outputEl.style.display = '';
    titleEl.textContent = `$ ${finalCmd}`;
    contentEl.textContent = 'Running...\n';

    try {
      const result = await rpcRequest('terminal.run', { command: finalCmd }, 60000);
      contentEl.textContent = result.output || result.terminalName || 'Command sent to terminal.';
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        contentEl.textContent += `\n\n[Exit code: ${result.exitCode}]`;
      }
    } catch (err) {
      contentEl.textContent = `Error: ${err.message}`;
    }
  }

  function setupCommandsPanel() {
    // Quick command buttons
    $$('#panel-commands .command-btn[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        const needsInput = btn.classList.contains('command-needs-input');
        const inputPrompt = btn.dataset.prompt;
        runQuickCommand(cmd, needsInput, inputPrompt);
      });
    });

    // Custom command
    const customInput = $('#custom-command-input');
    const customRun = $('#custom-command-run');

    if (customRun) {
      customRun.addEventListener('click', () => {
        if (customInput.value.trim()) {
          runQuickCommand(customInput.value.trim(), false);
          customInput.value = '';
        }
      });
    }

    if (customInput) {
      customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && customInput.value.trim()) {
          runQuickCommand(customInput.value.trim(), false);
          customInput.value = '';
        }
      });
    }

    // Close output
    const closeBtn = $('#command-output-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const outputEl = $('#command-output');
        if (outputEl) outputEl.style.display = 'none';
      });
    }
  }

  // ─── Diagnostics Panel ────────────────────────────────

  async function loadDiagnostics() {
    try {
      const [diags, summary] = await Promise.all([
        rpcRequest('diagnostics.all'),
        rpcRequest('diagnostics.summary'),
      ]);

      updateDiagBadge(summary);

      dom.diagSummary.innerHTML = `
        <span class="errors">✕ ${summary.errors} errors</span>
        <span class="warnings">⚠ ${summary.warnings} warnings</span>
      `;

      if (!diags || diags.length === 0) {
        dom.diagnosticsList.innerHTML = '<div class="empty-state">No diagnostics — looking good! 🎉</div>';
        return;
      }

      dom.diagnosticsList.innerHTML = '';
      for (const d of diags) {
        const el = document.createElement('div');
        el.className = 'diag-item';
        el.innerHTML = `
          <div class="diag-header">
            <span class="severity ${d.severity}">${d.severity}</span>
            <span class="file">${d.file}:${d.line}</span>
          </div>
          <div class="message">${escapeHtml(d.message)}</div>
        `;
        el.onclick = () => {
          rpcRequest('editor.open', { path: d.file, line: d.line });
        };
        dom.diagnosticsList.appendChild(el);
      }
    } catch (err) {
      dom.diagnosticsList.innerHTML = `<div class="empty-state">Error loading diagnostics</div>`;
    }
  }

  function updateDiagBadge(summary) {
    const count = (summary?.errors || 0) + (summary?.warnings || 0);
    if (count > 0) {
      dom.diagBadge.textContent = count;
      dom.diagBadge.style.display = '';
    } else {
      dom.diagBadge.style.display = 'none';
    }
  }

  // ─── Workspace Info ───────────────────────────────────

  async function loadWorkspaceInfo() {
    try {
      const info = await rpcRequest('workspace.info');
      dom.workspaceName.textContent = info.name || 'Workspace';
      dom.serverInfo.textContent = `${info.name}\nRoot: ${info.rootPath}\nBranch: ${info.gitBranch || 'N/A'}`;
    } catch (err) {
      dom.workspaceName.textContent = 'Workspace';
    }
  }

  // ─── Context Attachments ──────────────────────────────

  function addContextAttachment(type, name, content) {
    state.contextAttachments.push({ type, name, content });
    updateContextBar();
  }

  function removeContextAttachment(index) {
    state.contextAttachments.splice(index, 1);
    updateContextBar();
  }

  function updateContextBar() {
    if (state.contextAttachments.length === 0) {
      dom.contextBar.style.display = 'none';
      return;
    }

    dom.contextBar.style.display = '';
    dom.contextItems.innerHTML = '';

    state.contextAttachments.forEach((ctx, i) => {
      const chip = document.createElement('div');
      chip.className = 'context-chip';
      chip.innerHTML = `
        <span>${ctx.type === 'file' ? '📄' : '📎'} ${ctx.name}</span>
        <button onclick="window.__removeCtx(${i})">✕</button>
      `;
      dom.contextItems.appendChild(chip);
    });
  }

  window.__removeCtx = removeContextAttachment;

  // ─── UI Helpers ───────────────────────────────────────

  function showMainScreen() {
    dom.connectScreen.classList.remove('active');
    dom.mainScreen.classList.add('active');
  }

  function showConnectScreen() {
    dom.mainScreen.classList.remove('active');
    dom.connectScreen.classList.add('active');
  }

  function showConnectError(msg) {
    dom.connectStatus.textContent = msg;
    dom.connectStatus.className = 'connect-status error';
    dom.reconnectBtn.style.display = '';
  }

  function setConnectStatus(msg, cls) {
    dom.connectStatus.textContent = msg;
    dom.connectStatus.className = `connect-status ${cls}`;
    dom.reconnectBtn.style.display = 'none';
  }

  function updateIndicator(status) {
    dom.connectionIndicator.className = `indicator ${status}`;
  }

  function switchPanel(panelName) {
    $$('.panel').forEach((p) => p.classList.remove('active'));
    $$('.nav-item').forEach((n) => n.classList.remove('active'));

    const panel = $(`#panel-${panelName}`);
    const navItem = $(`.nav-item[data-panel="${panelName}"]`);

    if (panel) panel.classList.add('active');
    if (navItem) navItem.classList.add('active');

    // Load panel data
    switch (panelName) {
      case 'files':
        loadFileTree();
        break;
      case 'diagnostics':
        loadDiagnostics();
        break;
    }

    closeDrawer();
  }

  function openDrawer() {
    dom.navDrawer.classList.add('open');
  }

  function closeDrawer() {
    dom.navDrawer.classList.remove('open');
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
    });
  }

  // ─── Markdown Rendering ───────────────────────────────

  function renderMarkdown(text) {
    if (!text) return '';
    if (window.marked) {
      window.marked.setOptions({
        highlight: function (code, lang) {
          if (window.hljs && lang && window.hljs.getLanguage(lang)) {
            return window.hljs.highlight(code, { language: lang }).value;
          }
          return code;
        },
        breaks: true,
        gfm: true,
      });
      return window.marked.parse(text);
    }
    // Fallback: basic markdown
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── File Icons ───────────────────────────────────────

  function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    const icons = {
      ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️',
      py: '🐍', rb: '💎', go: '🔵', rs: '🦀',
      java: '☕', kt: '🟪', cs: '🟩', cpp: '🔧', c: '🔧',
      html: '🌐', css: '🎨', scss: '🎨', json: '📋',
      yaml: '📋', yml: '📋', md: '📝', sh: '🖥️',
      sql: '🗃️', xml: '📄', svg: '🖼️',
      png: '🖼️', jpg: '🖼️', gif: '🖼️',
      lock: '🔒', gitignore: '🚫',
    };
    return icons[ext] || '📄';
  }

  // ─── Utilities ────────────────────────────────────────

  function genId() {
    return `msg_${Date.now()}_${++state.requestIdCounter}`;
  }

  function loadSettings() {
    const theme = localStorage.getItem('mc-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    if (dom.themeSelect) dom.themeSelect.value = theme;

    const model = localStorage.getItem('mc-model') || 'gpt-4o';
    state.selectedModel = model;
    if (dom.modelSelect) dom.modelSelect.value = model;

    // Restore chat mode
    const mode = localStorage.getItem('mc-mode') || 'agent';
    state.chatMode = mode;
    const modeBtn = $(`.mode-btn[data-mode="${mode}"]`);
    if (modeBtn) {
      $$('.mode-btn').forEach((b) => b.classList.remove('active'));
      modeBtn.classList.add('active');
    }
    if (mode === 'agent') {
      if (dom.chatInput) dom.chatInput.placeholder = 'Ask Copilot agent to do anything...';
    } else {
      if (dom.chatInput) dom.chatInput.placeholder = 'Ask Copilot a quick question...';
    }
  }

  // ─── Event Listeners ─────────────────────────────────

  function setupEventListeners() {
    // Navigation
    dom.navToggle.addEventListener('click', openDrawer);
    dom.navOverlay.addEventListener('click', closeDrawer);

    $$('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        switchPanel(item.dataset.panel);
      });
    });

    // Chat input
    dom.chatInput.addEventListener('input', () => {
      // Auto-resize
      dom.chatInput.style.height = 'auto';
      dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + 'px';
      // Enable/disable send
      dom.sendBtn.disabled = !dom.chatInput.value.trim();
    });

    dom.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (dom.chatInput.value.trim()) {
          sendMessage(dom.chatInput.value);
        }
      }
    });

    dom.sendBtn.addEventListener('click', () => {
      if (dom.chatInput.value.trim()) {
        sendMessage(dom.chatInput.value);
      }
    });

    // Quick actions
    $$('.quick-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        if (prompt) sendMessage(prompt);
      });
    });

    // New chat
    dom.newChatBtn.addEventListener('click', () => {
      state.messages = [];
      saveChatHistory();
      state._historyRendered = false;
      dom.chatMessages.innerHTML = `
        <div class="welcome-message">
          <h2>👋 New Chat</h2>
          <p>Start a fresh conversation with Copilot.</p>
          <div class="quick-actions">
            <button class="quick-action" data-prompt="What files are in this workspace?">📁 Explore workspace</button>
            <button class="quick-action" data-prompt="Are there any errors or warnings in the code?">🔍 Check diagnostics</button>
            <button class="quick-action" data-prompt="Summarize the current project and its structure">📋 Project overview</button>
            <button class="quick-action" data-prompt="What's the git status?">🔀 Git status</button>
          </div>
        </div>
      `;
      // Re-bind quick actions
      $$('.quick-action').forEach((btn) => {
        btn.addEventListener('click', () => {
          const prompt = btn.dataset.prompt;
          if (prompt) sendMessage(prompt);
        });
      });
      switchPanel('chat');
    });

    // File viewer
    dom.closeViewerBtn.addEventListener('click', () => {
      dom.fileViewer.style.display = 'none';
      dom.fileTree.style.display = '';
    });

    dom.refreshFilesBtn.addEventListener('click', () => loadFileTree());

    // Attach context
    dom.attachBtn.addEventListener('click', async () => {
      try {
        const editor = await rpcRequest('editor.active');
        if (editor) {
          const content = await rpcRequest('file.read', { path: editor.path });
          addContextAttachment('file', editor.path, content.content);
        } else {
          // No active editor, attach workspace info
          const info = await rpcRequest('workspace.info');
          addContextAttachment('workspace', 'Workspace Info', JSON.stringify(info, null, 2));
        }
      } catch (err) {
        console.error('Attach error:', err);
      }
    });

    // Terminal
    dom.terminalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        runTerminalCommand(dom.terminalInput.value);
      }
    });

    dom.terminalSendBtn.addEventListener('click', () => {
      runTerminalCommand(dom.terminalInput.value);
    });

    // Settings
    dom.themeSelect.addEventListener('change', () => {
      const theme = dom.themeSelect.value;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('mc-theme', theme);
    });

    dom.modelSelect.addEventListener('change', () => {
      state.selectedModel = dom.modelSelect.value;
      localStorage.setItem('mc-model', state.selectedModel);
    });

    // Mode toggle buttons
    $$('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        state.chatMode = mode;
        localStorage.setItem('mc-mode', mode);
        $$('.mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        // Update placeholder text
        if (mode === 'agent') {
          dom.chatInput.placeholder = 'Ask Copilot agent to do anything...';
        } else {
          dom.chatInput.placeholder = 'Ask Copilot a quick question...';
        }
      });
    });

    dom.disconnectBtn.addEventListener('click', () => {
      localStorage.removeItem('mc-session');
      localStorage.removeItem('mc-token');
      if (state.ws) state.ws.close();
      state.connected = false;
      state.authenticated = false;
      showConnectScreen();
      showConnectError('Disconnected. Scan QR code to reconnect.');
    });

    // Reconnect button
    dom.reconnectBtn.addEventListener('click', () => {
      connect();
    });

    // Handle visibility change for reconnection
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.connected && (state.token || state.sessionId)) {
        connect();
      }
    });

    // Setup quick commands panel
    setupCommandsPanel();
  }

  // ─── Service Worker Registration ──────────────────────

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed, not critical
    });
  }

  // ─── Boot ─────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
