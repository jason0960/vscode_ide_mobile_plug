/**
 * Terminal Screen — send commands, view output.
 */

import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { useAppStore } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';

interface TerminalLine {
  text: string;
  type: 'cmd' | 'output' | 'error';
  id: number;
}

let lineId = 0;

export default function TerminalScreen() {
  const { runTerminalCommand, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];

  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const isAuthenticated = connectionStatus === 'authenticated';

  const appendLine = useCallback((text: string, type: TerminalLine['type']) => {
    setLines((prev) => [...prev, { text, type, id: ++lineId }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const handleRun = useCallback(async () => {
    const cmd = input.trim();
    if (!cmd || !isAuthenticated || running) return;

    setInput('');
    setRunning(true);
    appendLine(`$ ${cmd}`, 'cmd');

    try {
      const result = await runTerminalCommand(cmd);
      if (result.output) {
        appendLine(result.output, 'output');
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          appendLine(`[Exit code: ${result.exitCode}]`, 'error');
        }
      } else {
        appendLine('Command sent to terminal.', 'output');
      }
    } catch (err: any) {
      appendLine(`Error: ${err.message}`, 'error');
    }
    setRunning(false);
  }, [input, isAuthenticated, running, runTerminalCommand, appendLine]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Output area */}
      <ScrollView
        ref={scrollRef}
        style={styles.outputArea}
        contentContainerStyle={styles.outputContent}
      >
        {lines.length === 0 && (
          <Text style={[styles.placeholder, { color: colors.textMuted }]}>
            {isAuthenticated ? 'Run commands in VS Code terminal' : 'Connect to run commands'}
          </Text>
        )}
        {lines.map((line) => (
          <Text
            key={line.id}
            style={[
              styles.outputLine,
              { color: line.type === 'cmd' ? colors.success : line.type === 'error' ? colors.error : colors.text },
              line.type === 'cmd' && { fontWeight: '600' },
            ]}
            selectable
          >
            {line.text}
          </Text>
        ))}
      </ScrollView>

      {/* Input area */}
      <View style={[styles.inputBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <Text style={[styles.prompt, { color: colors.success }]}>$</Text>
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Enter command..."
          placeholderTextColor={colors.textMuted}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleRun}
          autoCapitalize="none"
          autoCorrect={false}
          editable={isAuthenticated && !running}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[styles.runBtn, { backgroundColor: isAuthenticated ? colors.primary : colors.border }]}
          onPress={handleRun}
          disabled={!isAuthenticated || running || !input.trim()}
        >
          <Text style={styles.runBtnText}>▶</Text>
        </TouchableOpacity>
      </View>

      {/* Quick commands */}
      <View style={[styles.quickBar, { backgroundColor: colors.surface }]}>
        {['ls', 'git status', 'npm test', 'pwd'].map((cmd) => (
          <TouchableOpacity
            key={cmd}
            style={[styles.quickBtn, { backgroundColor: colors.surfaceAlt }]}
            onPress={() => {
              setInput(cmd);
            }}
          >
            <Text style={[styles.quickBtnText, { color: colors.textSecondary }]}>{cmd}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  outputArea: { flex: 1 },
  outputContent: { padding: Spacing.md },
  placeholder: { fontSize: FontSize.md, textAlign: 'center', marginTop: 40 },
  outputLine: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    marginBottom: 2,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    gap: Spacing.sm,
  },
  prompt: {
    fontSize: FontSize.md,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '700',
  },
  input: {
    flex: 1,
    fontSize: FontSize.md,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingVertical: Spacing.sm,
  },
  runBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnText: { color: '#fff', fontSize: 14 },
  quickBar: {
    flexDirection: 'row',
    padding: Spacing.sm,
    gap: Spacing.sm,
  },
  quickBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
  quickBtnText: { fontSize: FontSize.xs },
});
