/**
 * Global application store using Zustand.
 * Manages connection state, chat messages, workspace data, and settings.
 */

import { create } from 'zustand';
import { ConnectionManager, ConnectionStatus } from '../api/connection';
import { RpcClient } from '../api/rpc';
import { ThemeMode } from '../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ──────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  language?: string;
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

export interface GitChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  diff?: string;
}

export interface WorkspaceInfo {
  name: string;
  rootPath: string;
  gitBranch?: string;
  diagnosticsSummary?: { errors: number; warnings: number };
}

export type ChatMode = 'agent' | 'chat';

// ─── Store Interface ────────────────────────────────────

interface AppState {
  // Connection
  connectionStatus: ConnectionStatus;
  sessionId: string | null;
  token: string | null;
  relayUrl: string | null;
  relayCode: string | null;
  connectionError: string | null;

  // Chat
  messages: ChatMessage[];
  chatMode: ChatMode;
  selectedModel: string;
  isStreaming: boolean;
  streamingContent: string;
  agentWorking: boolean;

  // Workspace
  workspace: WorkspaceInfo | null;
  diagnosticsSummary: { errors: number; warnings: number };

  // Settings
  theme: ThemeMode;

  // Singleton API instances
  connection: ConnectionManager;
  rpc: RpcClient;

  // Actions
  setConnectionStatus: (status: ConnectionStatus) => void;
  setConnectionError: (error: string | null) => void;
  setSessionId: (id: string | null) => void;
  setToken: (token: string | null) => void;
  setRelayConfig: (url: string | null, code: string | null) => void;

  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
  setStreaming: (streaming: boolean, content?: string) => void;
  appendStreamContent: (chunk: string) => void;
  setChatMode: (mode: ChatMode) => void;
  setSelectedModel: (model: string) => void;
  setAgentWorking: (working: boolean) => void;

  setWorkspace: (info: WorkspaceInfo | null) => void;
  setDiagnosticsSummary: (summary: { errors: number; warnings: number }) => void;

  setTheme: (theme: ThemeMode) => void;

  // Complex actions
  connectDirect: (url: string, token: string) => void;
  connectRelay: (relayUrl: string, code: string) => void;
  disconnect: () => void;
  sendChatMessage: (text: string) => Promise<void>;
  sendAgentMessage: (text: string) => Promise<void>;
  loadWorkspaceInfo: () => Promise<void>;
  loadDiagnostics: () => Promise<DiagnosticInfo[]>;
  loadFileTree: (dirPath?: string) => Promise<FileInfo[]>;
  readFile: (path: string) => Promise<string>;
  runTerminalCommand: (command: string) => Promise<{ output: string; exitCode?: number }>;
  loadChanges: () => Promise<{ files: GitChange[]; summary: any }>;
  restoreFiles: (files: string[]) => Promise<any>;

  // Persistence
  saveCredentials: () => Promise<void>;
  loadCredentials: () => Promise<void>;
  saveChatHistory: () => Promise<void>;
  loadChatHistory: () => Promise<void>;
}

// ─── Store ──────────────────────────────────────────────

const connectionManager = new ConnectionManager();
const rpcClient = new RpcClient(connectionManager);

export const useAppStore = create<AppState>((set, get) => {
  // Wire up connection events
  connectionManager.onStatusChange = (status) => {
    set({ connectionStatus: status });
    if (status === 'disconnected') {
      set({ agentWorking: false, isStreaming: false });
    }
  };

  connectionManager.onError = (error) => {
    set({ connectionError: error });
  };

  // Wire up RPC events
  rpcClient.onEvent = (method, params) => {
    const state = get();

    switch (method) {
      case 'connection.ready':
        // Server is ready — authenticate
        if (state.connectionStatus === 'connected') {
          if (state.sessionId) {
            rpcClient.authenticate(state.sessionId);
          } else if (state.token) {
            rpcClient.authenticate(undefined, state.token);
          }
        }
        break;

      case 'auth.success':
        set({ sessionId: params.sessionId, connectionError: null });
        connectionManager.markAuthenticated();
        state.saveCredentials();
        state.loadWorkspaceInfo();
        break;

      case 'auth.failed':
        set({ connectionError: 'Authentication failed. Try reconnecting.' });
        break;

      case 'diagnostics.changed':
        set({ diagnosticsSummary: params });
        break;

      case 'session.missedResponse':
        if (params.content) {
          set((s) => ({
            messages: [...s.messages, {
              role: 'assistant' as const,
              content: params.content,
              timestamp: params.timestamp || Date.now(),
            }],
          }));
          get().saveChatHistory();
        }
        break;

      case 'agent.status':
        if (params.status === 'completed' || params.status === 'failed') {
          set({ agentWorking: false });
        }
        break;
    }
  };

  return {
    // Initial state
    connectionStatus: 'disconnected',
    sessionId: null,
    token: null,
    relayUrl: null,
    relayCode: null,
    connectionError: null,

    messages: [],
    chatMode: 'agent',
    selectedModel: 'gpt-4o',
    isStreaming: false,
    streamingContent: '',
    agentWorking: false,

    workspace: null,
    diagnosticsSummary: { errors: 0, warnings: 0 },

    theme: 'dark',

    connection: connectionManager,
    rpc: rpcClient,

    // Simple setters
    setConnectionStatus: (status) => set({ connectionStatus: status }),
    setConnectionError: (error) => set({ connectionError: error }),
    setSessionId: (id) => set({ sessionId: id }),
    setToken: (token) => set({ token }),
    setRelayConfig: (url, code) => set({ relayUrl: url, relayCode: code }),

    addMessage: (msg) => {
      set((s) => ({ messages: [...s.messages, msg] }));
      get().saveChatHistory();
    },
    clearMessages: () => {
      set({ messages: [] });
      get().saveChatHistory();
    },
    setStreaming: (streaming, content) => set({
      isStreaming: streaming,
      streamingContent: content || '',
    }),
    appendStreamContent: (chunk) => set((s) => ({
      streamingContent: s.streamingContent + chunk,
    })),
    setChatMode: (mode) => set({ chatMode: mode }),
    setSelectedModel: (model) => set({ selectedModel: model }),
    setAgentWorking: (working) => set({ agentWorking: working }),

    setWorkspace: (info) => set({ workspace: info }),
    setDiagnosticsSummary: (summary) => set({ diagnosticsSummary: summary }),

    setTheme: (theme) => {
      set({ theme });
      AsyncStorage.setItem('mc-theme', theme).catch(() => {});
    },

    // ─── Complex Actions ────────────────────────────────

    connectDirect: (url, token) => {
      set({ token, connectionError: null });
      connectionManager.connectDirect(url, token);
    },

    connectRelay: (relayUrl, code) => {
      set({ relayUrl, relayCode: code, connectionError: null });
      connectionManager.connectRelay(relayUrl, code);
    },

    disconnect: () => {
      connectionManager.disconnect();
      rpcClient.cancelAll();
      set({
        sessionId: null,
        token: null,
        relayUrl: null,
        relayCode: null,
        connectionError: null,
        workspace: null,
        agentWorking: false,
        isStreaming: false,
      });
      Promise.all([
        AsyncStorage.removeItem('mc-session'),
        AsyncStorage.removeItem('mc-token'),
        AsyncStorage.removeItem('mc-relay-url'),
        AsyncStorage.removeItem('mc-relay-code'),
      ]).catch(() => {});
    },

    sendChatMessage: async (text) => {
      const state = get();
      if (!text.trim() || state.connectionStatus !== 'authenticated') return;

      // Add user message
      const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
      set((s) => ({ messages: [...s.messages, userMsg], isStreaming: true, streamingContent: '' }));
      state.saveChatHistory();

      try {
        const history = state.messages.slice(-20).map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        }));

        const fullResponse = await rpcClient.stream(
          'chat.send',
          { prompt: text, history, model: state.selectedModel },
          (chunk) => {
            set((s) => ({ streamingContent: s.streamingContent + chunk }));
          },
        );

        const content = fullResponse || get().streamingContent;
        set((s) => ({
          messages: [...s.messages, { role: 'assistant', content, timestamp: Date.now() }],
          isStreaming: false,
          streamingContent: '',
        }));
        get().saveChatHistory();
      } catch (err: any) {
        const errorContent = `**Error:** ${err.message}`;
        set((s) => ({
          messages: [...s.messages, { role: 'assistant', content: errorContent, timestamp: Date.now() }],
          isStreaming: false,
          streamingContent: '',
        }));
        get().saveChatHistory();
      }
    },

    sendAgentMessage: async (text) => {
      const state = get();
      if (!text.trim() || state.connectionStatus !== 'authenticated') return;

      const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
      set((s) => ({
        messages: [...s.messages, userMsg],
        isStreaming: true,
        streamingContent: '',
        agentWorking: true,
      }));
      state.saveChatHistory();

      try {
        const fullResponse = await rpcClient.stream(
          'chat.sendToAgent',
          { prompt: text },
          (chunk) => {
            set((s) => ({ streamingContent: s.streamingContent + chunk }));
          },
        );

        const content = fullResponse || get().streamingContent;
        set((s) => ({
          messages: [...s.messages, { role: 'assistant', content, timestamp: Date.now() }],
          isStreaming: false,
          streamingContent: '',
          agentWorking: false,
        }));
        get().saveChatHistory();
      } catch (err: any) {
        const errorContent = `**Error:** ${err.message}`;
        set((s) => ({
          messages: [...s.messages, { role: 'assistant', content: errorContent, timestamp: Date.now() }],
          isStreaming: false,
          streamingContent: '',
          agentWorking: false,
        }));
        get().saveChatHistory();
      }
    },

    loadWorkspaceInfo: async () => {
      try {
        const info = await rpcClient.request('workspace.info');
        set({ workspace: info });
      } catch {
        // Ignore
      }
    },

    loadDiagnostics: async () => {
      try {
        const [diags, summary] = await Promise.all([
          rpcClient.request('diagnostics.all'),
          rpcClient.request('diagnostics.summary'),
        ]);
        set({ diagnosticsSummary: summary });
        return diags || [];
      } catch {
        return [];
      }
    },

    loadFileTree: async (dirPath?: string) => {
      try {
        if (dirPath) {
          return await rpcClient.request('workspace.listDir', { path: dirPath });
        }
        return await rpcClient.request('workspace.fileTree', { maxDepth: 2 });
      } catch {
        return [];
      }
    },

    readFile: async (path: string) => {
      const result = await rpcClient.request('file.read', { path });
      return result.content;
    },

    runTerminalCommand: async (command: string) => {
      return await rpcClient.request('terminal.run', { command }, 60000);
    },

    loadChanges: async () => {
      return await rpcClient.request('git.changedFiles', {});
    },

    restoreFiles: async (files: string[]) => {
      return await rpcClient.request('git.restoreFiles', { files });
    },

    // ─── Persistence ────────────────────────────────────

    saveCredentials: async () => {
      const { sessionId, token, relayUrl, relayCode } = get();
      try {
        const pairs: [string, string][] = [];
        if (sessionId) pairs.push(['mc-session', sessionId]);
        if (token) pairs.push(['mc-token', token]);
        if (relayUrl) pairs.push(['mc-relay-url', relayUrl]);
        if (relayCode) pairs.push(['mc-relay-code', relayCode]);
        await Promise.all(pairs.map(([k, v]) => AsyncStorage.setItem(k, v)));
      } catch {
        // Ignore
      }
    },

    loadCredentials: async () => {
      try {
        const keys = ['mc-session', 'mc-token', 'mc-relay-url', 'mc-relay-code', 'mc-theme', 'mc-mode', 'mc-model'];
        const values = await Promise.all(keys.map((k) => AsyncStorage.getItem(k)));
        const map: Record<string, string> = {};
        keys.forEach((k, i) => { if (values[i] !== null) map[k] = values[i]!; });

        set({
          sessionId: map['mc-session'] || null,
          token: map['mc-token'] || null,
          relayUrl: map['mc-relay-url'] || null,
          relayCode: map['mc-relay-code'] || null,
          theme: (map['mc-theme'] as ThemeMode) || 'dark',
          chatMode: (map['mc-mode'] as ChatMode) || 'agent',
          selectedModel: map['mc-model'] || 'gpt-4o',
        });
      } catch {
        // Ignore
      }
    },

    saveChatHistory: async () => {
      try {
        const msgs = get().messages.slice(-200);
        await AsyncStorage.setItem('mc-chat-history', JSON.stringify(msgs));
      } catch {
        // Ignore
      }
    },

    loadChatHistory: async () => {
      try {
        const raw = await AsyncStorage.getItem('mc-chat-history');
        if (raw) {
          const messages = JSON.parse(raw) as ChatMessage[];
          if (Array.isArray(messages) && messages.length > 0) {
            set({ messages });
          }
        }
      } catch {
        // Ignore
      }
    },
  };
});
