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
      Notification.requestPermission().then((perm) => {
        console.log('[Notify] Permission:', perm);
      });
    }
  }

  function notifyResponseComplete(preview) {
    // Vibrate (short buzz)
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    // Browser notification (only if page is not visible)
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const body = preview
        ? preview.substring(0, 120) + (preview.length > 120 ? '...' : '')
        : 'Response ready';
      const n = new Notification('Copilot Response Ready', {
        body,
        icon: '/icons/icon-192.png',
        tag: 'copilot-response',
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      // Auto-close after 5s
      setTimeout(() => n.close(), 5000);
    }
  }

  // ─── Init ─────────────────────────────────────────────

  function init() {
    // Load saved settings
    loadSettings();

    // Load chat history from localStorage
    const hasHistory = loadChatHistory();

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

    // Request notification permission early
    requestNotificationPermission();

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
        // Render restored chat history after auth
        if (state.messages.length > 0 && !state._historyRendered) {
          renderChatHistory();
          state._historyRendered = true;
        }
        break;

      case 'auth.failed':
        showConnectError('Authentication failed. Rescan QR code.');
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

    activityEl.innerHTML = `<span class="activity-icon">${icon}</span><span class="activity-detail">${escapeHtml(activity.detail)}</span><span class="activity-time">${time}</span>`;

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
      const result = await rpcRequest('terminal.run', { command });
      appendTerminalOutput(`Sent to terminal: ${result.terminalName}`, 'output');
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
