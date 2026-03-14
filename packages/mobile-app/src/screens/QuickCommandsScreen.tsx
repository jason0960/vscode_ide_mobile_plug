/**
 * Quick Commands Screen — one-tap Git, Build & Test, and Workspace commands.
 * Ported from the original mobile-client web app's Quick Commands panel.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';

// ─── Command Definitions ────────────────────────────────

interface QuickCommand {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  cmd: string;
  /** If true, prompt user for input (e.g. commit message). */
  needsInput?: boolean;
  inputPrompt?: string;
}

interface CommandSection {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  commands: QuickCommand[];
}

const SECTIONS: CommandSection[] = [
  {
    title: 'Git',
    icon: 'git-branch-outline',
    commands: [
      { label: 'Status', icon: 'information-circle-outline', cmd: 'git status' },
      { label: 'Diff', icon: 'code-outline', cmd: 'git diff --stat' },
      { label: 'Stage All', icon: 'add-circle-outline', cmd: 'git add .' },
      { label: 'Commit', icon: 'chatbubble-outline', cmd: 'git commit -m "{input}"', needsInput: true, inputPrompt: 'Commit message:' },
      { label: 'Push', icon: 'cloud-upload-outline', cmd: 'git push' },
      { label: 'Pull', icon: 'cloud-download-outline', cmd: 'git pull' },
      { label: 'Log (10)', icon: 'list-outline', cmd: 'git log --oneline -10' },
      { label: 'Branches', icon: 'git-branch-outline', cmd: 'git branch' },
    ],
  },
  {
    title: 'Build & Test',
    icon: 'hammer-outline',
    commands: [
      { label: 'npm test', icon: 'flask-outline', cmd: 'npm test' },
      { label: 'npm build', icon: 'construct-outline', cmd: 'npm run build' },
      { label: 'npm lint', icon: 'search-outline', cmd: 'npm run lint' },
      { label: 'npm install', icon: 'cube-outline', cmd: 'npm install' },
      { label: 'npm dev', icon: 'play-outline', cmd: 'npm run dev' },
      { label: 'npm start', icon: 'rocket-outline', cmd: 'npm start' },
    ],
  },
  {
    title: 'Workspace',
    icon: 'folder-open-outline',
    commands: [
      { label: 'List Files', icon: 'list-outline', cmd: 'ls -la' },
      { label: 'Disk Usage', icon: 'pie-chart-outline', cmd: 'du -sh .' },
      { label: 'package.json', icon: 'document-text-outline', cmd: 'cat package.json | head -20' },
      { label: 'Current Dir', icon: 'navigate-outline', cmd: 'pwd' },
    ],
  },
];

// ─── Component ──────────────────────────────────────────

export default function QuickCommandsScreen() {
  const { runTerminalCommand, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];
  const scrollRef = useRef<ScrollView>(null);

  const [customCmd, setCustomCmd] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ title: string; content: string; exitCode?: number } | null>(null);
  // Track which button is loading
  const [runningCmd, setRunningCmd] = useState<string | null>(null);

  // Input prompt state
  const [promptVisible, setPromptVisible] = useState(false);
  const [promptValue, setPromptValue] = useState('');
  const [pendingCommand, setPendingCommand] = useState<QuickCommand | null>(null);

  const isAuthenticated = connectionStatus === 'authenticated';

  const executeCommand = useCallback(async (finalCmd: string) => {
    setRunning(true);
    setRunningCmd(finalCmd);
    setOutput({ title: `$ ${finalCmd}`, content: 'Running...', exitCode: undefined });

    try {
      const result = await runTerminalCommand(finalCmd);
      const content = result.output || 'Command sent to terminal.';
      setOutput({
        title: `$ ${finalCmd}`,
        content: result.exitCode !== undefined && result.exitCode !== 0
          ? `${content}\n\n[Exit code: ${result.exitCode}]`
          : content,
        exitCode: result.exitCode,
      });
    } catch (err: any) {
      setOutput({ title: `$ ${finalCmd}`, content: `Error: ${err.message}`, exitCode: 1 });
    }
    setRunning(false);
    setRunningCmd(null);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [runTerminalCommand]);

  const handleCommand = useCallback((qc: QuickCommand) => {
    if (!isAuthenticated || running) return;
    if (qc.needsInput) {
      setPendingCommand(qc);
      setPromptValue('');
      setPromptVisible(true);
    } else {
      executeCommand(qc.cmd);
    }
  }, [isAuthenticated, running, executeCommand]);

  const submitPrompt = useCallback(() => {
    if (!pendingCommand || !promptValue.trim()) return;
    const finalCmd = pendingCommand.cmd.replace('{input}', promptValue.trim());
    setPromptVisible(false);
    setPendingCommand(null);
    setPromptValue('');
    executeCommand(finalCmd);
  }, [pendingCommand, promptValue, executeCommand]);

  const runCustom = useCallback(() => {
    if (!customCmd.trim() || running) return;
    executeCommand(customCmd.trim());
    setCustomCmd('');
  }, [customCmd, running, executeCommand]);

  // ─── Render ───────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name={section.icon} size={16} color={colors.textMuted} />
              <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{section.title}</Text>
            </View>
            <View style={styles.commandGrid}>
              {section.commands.map((qc) => {
                const isRunningThis = runningCmd === qc.cmd;
                return (
                  <TouchableOpacity
                    key={qc.cmd}
                    style={[
                      styles.commandBtn,
                      { backgroundColor: colors.surface, borderColor: colors.border },
                      isRunningThis && { borderColor: colors.primary },
                    ]}
                    onPress={() => handleCommand(qc)}
                    disabled={running || !isAuthenticated}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={qc.icon}
                      size={18}
                      color={isRunningThis ? colors.primary : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.commandLabel,
                        { color: isRunningThis ? colors.primary : colors.text },
                      ]}
                      numberOfLines={1}
                    >
                      {qc.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}

        {/* Custom Command */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="terminal-outline" size={16} color={colors.textMuted} />
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Custom Command</Text>
          </View>
          <View style={[styles.customRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              style={[styles.customInput, { color: colors.text }]}
              placeholder="Enter command..."
              placeholderTextColor={colors.textMuted}
              value={customCmd}
              onChangeText={setCustomCmd}
              onSubmitEditing={runCustom}
              returnKeyType="go"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!running}
            />
            <TouchableOpacity
              style={[styles.runBtn, { backgroundColor: colors.primary }]}
              onPress={runCustom}
              disabled={running || !customCmd.trim()}
            >
              <Ionicons name="play" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Output */}
        {output && (
          <View style={[styles.outputContainer, { backgroundColor: colors.codeBg, borderColor: colors.border }]}>
            <View style={styles.outputHeader}>
              <Text style={[styles.outputTitle, { color: colors.info }]} numberOfLines={1}>
                {output.title}
              </Text>
              <TouchableOpacity onPress={() => setOutput(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView horizontal>
              <Text
                style={[
                  styles.outputContent,
                  { color: output.exitCode && output.exitCode !== 0 ? colors.error : colors.text },
                ]}
                selectable
              >
                {output.content}
              </Text>
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* Input Prompt Modal (inline) */}
      {promptVisible && (
        <View style={[styles.promptOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.promptCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.promptTitle, { color: colors.text }]}>
              {pendingCommand?.inputPrompt || 'Enter value:'}
            </Text>
            <TextInput
              style={[styles.promptInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={promptValue}
              onChangeText={setPromptValue}
              onSubmitEditing={submitPrompt}
              autoFocus
              autoCapitalize="none"
              placeholder="e.g. feat: add new feature"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.promptActions}>
              <TouchableOpacity
                style={[styles.promptBtn, { backgroundColor: colors.border }]}
                onPress={() => { setPromptVisible(false); setPendingCommand(null); }}
              >
                <Text style={[styles.promptBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.promptBtn, { backgroundColor: colors.primary }]}
                onPress={submitPrompt}
                disabled={!promptValue.trim()}
              >
                <Text style={[styles.promptBtnText, { color: '#fff' }]}>Run</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: Spacing.md },

  section: { marginBottom: Spacing.xl },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  commandGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  commandBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    minHeight: 44,
  },
  commandLabel: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },

  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  customInput: {
    flex: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.sm,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minHeight: 44,
  },
  runBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  outputContainer: {
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: Spacing.md,
  },
  outputHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  outputTitle: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  outputContent: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FontSize.code,
    lineHeight: 20,
    padding: Spacing.md,
  },

  // Prompt modal
  promptOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  promptCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    padding: Spacing.xl,
  },
  promptTitle: {
    fontSize: FontSize.md,
    fontWeight: '600',
    marginBottom: Spacing.md,
  },
  promptInput: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.sm,
    marginBottom: Spacing.lg,
    minHeight: 44,
  },
  promptActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
  },
  promptBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    minHeight: 40,
    justifyContent: 'center',
  },
  promptBtnText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
});
