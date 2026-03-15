/**
 * Chat Screen — streaming Copilot chat with markdown rendering.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore, ChatMessage } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius, ThemeColors } from '../theme';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Message Bubble ───────────────────────────────────

const MessageBubble = React.memo(({ msg, colors, mdStyles }: {
  msg: ChatMessage;
  colors: ThemeColors;
  mdStyles: any;
}) => {
  const isUser = msg.role === 'user';

  return (
    <View style={[
      styles.bubble,
      { backgroundColor: isUser ? colors.userBubble : colors.assistantBubble },
      isUser && styles.userBubble,
    ]}>
      <View style={styles.bubbleHeader}>
        <Text style={[styles.roleName, { color: isUser ? colors.primaryLight : colors.success }]}>
          {isUser ? 'You' : 'Copilot'}
        </Text>
        <Text style={[styles.timestamp, { color: colors.textMuted }]}>
          {formatTime(msg.timestamp)}
        </Text>
      </View>
      {isUser ? (
        <Text style={[styles.userText, { color: colors.text }]}>{msg.content}</Text>
      ) : (
        <Markdown style={mdStyles}>{msg.content}</Markdown>
      )}
    </View>
  );
});

// ─── Streaming Indicator ──────────────────────────────

const StreamingBubble = React.memo(({ content, colors, mdStyles }: {
  content: string;
  colors: ThemeColors;
  mdStyles: any;
}) => (
  <View style={[styles.bubble, { backgroundColor: colors.assistantBubble }]}>
    <View style={styles.bubbleHeader}>
      <Text style={[styles.roleName, { color: colors.success }]}>Copilot</Text>
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
    {content ? (
      <Markdown style={mdStyles}>{content}</Markdown>
    ) : (
      <View style={styles.thinking}>
        <View style={[styles.dot, { backgroundColor: colors.textMuted }]} />
        <View style={[styles.dot, styles.dot2, { backgroundColor: colors.textMuted }]} />
        <View style={[styles.dot, styles.dot3, { backgroundColor: colors.textMuted }]} />
      </View>
    )}
  </View>
));

// ─── Chat Screen ──────────────────────────────────────

export default function ChatScreen() {
  const {
    messages,
    isStreaming,
    streamingContent,
    chatMode,
    agentWorking,
    connectionStatus,
    theme,
    messageQueue,
    setChatMode,
    sendChatMessage,
    sendAgentMessage,
    clearMessages,
    removeFromQueue,
  } = useAppStore();

  const colors = Colors[theme];
  const flatListRef = useRef<FlatList>(null);
  const [inputText, setInputText] = useState('');

  // Markdown styles
  const mdStyles = React.useMemo(() => ({
    body: { color: colors.text, fontSize: FontSize.md },
    paragraph: { marginBottom: Spacing.sm, marginTop: 0 },
    heading1: { color: colors.text, fontSize: FontSize.xxl, fontWeight: '700' as const, marginBottom: Spacing.sm },
    heading2: { color: colors.text, fontSize: FontSize.xl, fontWeight: '600' as const, marginBottom: Spacing.sm },
    heading3: { color: colors.text, fontSize: FontSize.lg, fontWeight: '600' as const, marginBottom: Spacing.xs },
    strong: { fontWeight: '700' as const },
    em: { fontStyle: 'italic' as const },
    link: { color: colors.primaryLight },
    blockquote: {
      backgroundColor: colors.surfaceAlt,
      borderLeftColor: colors.primary,
      borderLeftWidth: 3,
      paddingLeft: Spacing.md,
      paddingVertical: Spacing.xs,
      marginVertical: Spacing.sm,
    },
    code_inline: {
      backgroundColor: colors.codeBg,
      color: colors.info,
      fontSize: FontSize.code,
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: BorderRadius.sm,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    code_block: {
      backgroundColor: colors.codeBg,
      color: colors.codeText,
      fontSize: FontSize.code,
      padding: Spacing.md,
      borderRadius: BorderRadius.md,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      overflow: 'hidden' as const,
    },
    fence: {
      backgroundColor: colors.codeBg,
      color: colors.codeText,
      fontSize: FontSize.code,
      padding: Spacing.md,
      borderRadius: BorderRadius.md,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginVertical: Spacing.sm,
    },
    list_item: { marginBottom: Spacing.xs },
    ordered_list: { marginBottom: Spacing.sm },
    bullet_list: { marginBottom: Spacing.sm },
    hr: { backgroundColor: colors.border, height: 1, marginVertical: Spacing.md },
    table: { borderColor: colors.border },
    tr: { borderBottomColor: colors.border },
    td: { padding: Spacing.sm },
    th: { padding: Spacing.sm, fontWeight: '600' as const },
  }), [colors]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');

    if (chatMode === 'agent') {
      sendAgentMessage(text);
    } else {
      sendChatMessage(text);
    }
  }, [inputText, chatMode, sendAgentMessage, sendChatMessage]);

  // Data for FlatList: messages + optional streaming bubble + queued messages
  const data = React.useMemo(() => {
    const items: (ChatMessage | { id: string })[] = [...messages];
    if (isStreaming) {
      items.push({ id: 'streaming' } as any);
    }
    // Show queued messages so user sees them waiting
    for (const q of messageQueue) {
      items.push({ id: `queued-${q.id}`, role: 'user', content: q.text, timestamp: q.timestamp, _queued: true, _position: q.position } as any);
    }
    return items;
  }, [messages, isStreaming, messageQueue]);

  // Auto-scroll
  useEffect(() => {
    if (data.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [data.length, streamingContent]);

  const isAuthenticated = connectionStatus === 'authenticated';
  const canSend = isAuthenticated && inputText.trim().length > 0;

  const renderItem = useCallback(({ item }: { item: any }) => {
    if (item.id === 'streaming') {
      return <StreamingBubble content={streamingContent} colors={colors} mdStyles={mdStyles} />;
    }
    if (item._queued) {
      return (
        <View style={[styles.bubble, { backgroundColor: colors.userBubble, opacity: 0.6 }, styles.userBubble]}>
          <View style={styles.bubbleHeader}>
            <View style={styles.queueBadgeRow}>
              <Text style={[styles.roleName, { color: colors.primaryLight }]}>You</Text>
              <View style={[styles.queueBadge, { backgroundColor: colors.primary + '33' }]}>
                <Text style={[styles.queueBadgeText, { color: colors.primary }]}>Queue #{item._position}</Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => removeFromQueue(item.id.replace('queued-', ''))}>
              <Ionicons name="close-circle-outline" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.userText, { color: colors.text }]}>{item.content}</Text>
        </View>
      );
    }
    return <MessageBubble msg={item} colors={colors} mdStyles={mdStyles} />;
  }, [streamingContent, colors, mdStyles, removeFromQueue]);

  const keyExtractor = useCallback((item: any, index: number) => {
    if (item.id === 'streaming') return 'streaming';
    if (item._queued) return item.id;
    return `${item.timestamp}-${index}`;
  }, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Mode Toggle */}
      <View style={[styles.modeBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.modeBtn, chatMode === 'agent' && { backgroundColor: colors.primary }]}
          onPress={() => setChatMode('agent')}
        >
          <Text style={[styles.modeBtnText, { color: chatMode === 'agent' ? '#fff' : colors.textSecondary }]}>
            Agent
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, chatMode === 'chat' && { backgroundColor: colors.primary }]}
          onPress={() => setChatMode('chat')}
        >
          <Text style={[styles.modeBtnText, { color: chatMode === 'chat' ? '#fff' : colors.textSecondary }]}>
            Chat
          </Text>
        </TouchableOpacity>

        <View style={{ flex: 1 }} />

        {messages.length > 0 && (
          <TouchableOpacity onPress={clearMessages} style={styles.clearBtn}>
            <Text style={[styles.clearBtnText, { color: colors.textMuted }]}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      {data.length === 0 ? (
        <View style={styles.welcome}>
          <Ionicons name="code-slash-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.welcomeTitle, { color: colors.text }]}>
            {chatMode === 'agent' ? 'Ask Copilot Agent' : 'Quick Chat'}
          </Text>
          <Text style={[styles.welcomeDesc, { color: colors.textSecondary }]}>
            {chatMode === 'agent'
              ? 'Agent mode sends your prompt to Copilot Chat in VS Code — it can edit files, run commands, and more.'
              : 'Chat mode uses the raw LLM for quick questions without tool access.'}
          </Text>

          <View style={styles.quickActions}>
            {[
              { icon: 'folder-open-outline' as const, text: 'Explore workspace', prompt: 'What files are in this workspace?' },
              { icon: 'bug-outline' as const, text: 'Check diagnostics', prompt: 'Are there any errors or warnings in the code?' },
              { icon: 'document-text-outline' as const, text: 'Project overview', prompt: 'Summarize the current project and its structure' },
              { icon: 'git-branch-outline' as const, text: 'Git status', prompt: "What's the git status?" },
            ].map((action) => (
              <TouchableOpacity
                key={action.prompt}
                style={[styles.quickActionBtn, { backgroundColor: colors.surface }]}
                onPress={() => {
                  setInputText('');
                  if (chatMode === 'agent') sendAgentMessage(action.prompt);
                  else sendChatMessage(action.prompt);
                }}
                disabled={!isAuthenticated}
              >
                <Ionicons name={action.icon} size={16} color={colors.primaryLight} />
                <Text style={[styles.quickActionText, { color: colors.text }]}>{action.text}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.messagesList}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Agent Working Banner */}
      {agentWorking && (
        <View style={[styles.agentBanner, { backgroundColor: colors.primary + '22' }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.agentBannerText, { color: colors.primary }]}>
            Agent working...{messageQueue.length > 0 ? ` (${messageQueue.length} queued)` : ''}
          </Text>
        </View>
      )}

      {/* Input Bar */}
      <View style={[styles.inputBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <TextInput
          style={[styles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
          placeholder={
            isStreaming || agentWorking
              ? 'Type to queue next message...'
              : chatMode === 'agent'
                ? 'Ask Copilot agent...'
                : 'Ask a quick question...'
          }
          placeholderTextColor={colors.textMuted}
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={8000}
          editable={isAuthenticated}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendBtn, { backgroundColor: canSend ? colors.primary : colors.border }]}
          onPress={handleSend}
          disabled={!canSend}
        >
          <Ionicons name="arrow-up" size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  modeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    gap: Spacing.xs,
  },
  modeBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
  modeBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  clearBtn: { paddingHorizontal: Spacing.sm },
  clearBtnText: { fontSize: FontSize.sm },
  messagesList: { padding: Spacing.md, paddingBottom: Spacing.xl },
  bubble: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    maxWidth: '100%',
  },
  userBubble: { marginLeft: Spacing.xxl },
  bubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  roleName: { fontSize: FontSize.sm, fontWeight: '600' },
  timestamp: { fontSize: FontSize.xs },
  userText: { fontSize: FontSize.md },
  thinking: { flexDirection: 'row', gap: 4, paddingVertical: Spacing.sm },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    opacity: 0.4,
  },
  dot2: { opacity: 0.6 },
  dot3: { opacity: 0.8 },
  welcome: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  welcomeTitle: { fontSize: FontSize.xl, fontWeight: '700', marginTop: Spacing.lg, marginBottom: Spacing.sm },
  welcomeDesc: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 24 },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  quickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
    gap: Spacing.xs,
  },
  quickActionText: { fontSize: FontSize.sm },
  agentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  agentBannerText: { fontSize: FontSize.sm, fontWeight: '600' },
  queueBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  queueBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  queueBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  inputBar: {
    flexDirection: 'row',
    padding: Spacing.sm,
    borderTopWidth: 1,
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
    maxHeight: 120,
    minHeight: 40,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
