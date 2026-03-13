/**
 * Settings Screen — connection info, theme, model, disconnect.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
} from 'react-native';
import { useAppStore } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius, ThemeMode } from '../theme';

const MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo', 'claude-3.5-sonnet', 'claude-3-opus'];

export default function SettingsScreen() {
  const {
    connectionStatus,
    workspace,
    sessionId,
    relayUrl,
    relayCode,
    theme,
    selectedModel,
    chatMode,
    connection,
    setTheme,
    setSelectedModel,
    setChatMode,
    disconnect,
  } = useAppStore();

  const colors = Colors[theme];
  const isAuthenticated = connectionStatus === 'authenticated';

  const handleDisconnect = () => {
    Alert.alert('Disconnect', 'Are you sure you want to disconnect?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
    ]);
  };

  const SectionHeader = ({ title }: { title: string }) => (
    <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>{title}</Text>
  );

  const Row = ({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      {value && <Text style={[styles.rowValue, { color: colors.textSecondary }]}>{value}</Text>}
    </TouchableOpacity>
  );

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Connection */}
      <SectionHeader title="CONNECTION" />
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <Row label="Status" value={
          connectionStatus === 'authenticated' ? '🟢 Connected'
          : connectionStatus === 'connecting' || connectionStatus === 'connected' ? '🟡 Connecting'
          : '🔴 Disconnected'
        } />
        <Row label="Mode" value={connection.currentConfig?.mode === 'relay' ? '🌐 Relay' : '📡 Direct'} />
        {workspace && <Row label="Workspace" value={workspace.name} />}
        {workspace?.gitBranch && <Row label="Branch" value={workspace.gitBranch} />}
        {relayCode && <Row label="Room Code" value={relayCode} />}
        {relayUrl && <Row label="Relay URL" value={relayUrl} />}
      </View>

      {/* Appearance */}
      <SectionHeader title="APPEARANCE" />
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Dark Mode</Text>
          <Switch
            value={theme === 'dark'}
            onValueChange={(v) => setTheme(v ? 'dark' : 'light')}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {/* Chat */}
      <SectionHeader title="CHAT" />
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Default Mode</Text>
          <View style={[styles.modeToggle, { backgroundColor: colors.background }]}>
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
          </View>
        </View>

        {/* Model selector */}
        <Text style={[styles.modelLabel, { color: colors.textSecondary }]}>Model</Text>
        <View style={styles.modelGrid}>
          {MODELS.map((model) => (
            <TouchableOpacity
              key={model}
              style={[
                styles.modelBtn,
                { backgroundColor: colors.background, borderColor: model === selectedModel ? colors.primary : colors.border },
                model === selectedModel && { borderWidth: 2 },
              ]}
              onPress={() => setSelectedModel(model)}
            >
              <Text style={[styles.modelText, {
                color: model === selectedModel ? colors.primary : colors.text,
                fontWeight: model === selectedModel ? '600' : '400',
              }]}>
                {model}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Actions */}
      <SectionHeader title="ACTIONS" />
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        {isAuthenticated && (
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: colors.border }]}
            onPress={handleDisconnect}
          >
            <Text style={[styles.rowLabel, { color: colors.error }]}>Disconnect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Version */}
      <Text style={[styles.version, { color: colors.textMuted }]}>
        Mobile Copilot v0.2.0
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  section: {
    borderRadius: BorderRadius.lg,
    marginHorizontal: Spacing.md,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
  rowLabel: { fontSize: FontSize.md },
  rowValue: { fontSize: FontSize.sm, maxWidth: '60%', textAlign: 'right' },
  modeToggle: {
    flexDirection: 'row',
    borderRadius: BorderRadius.md,
    padding: 2,
  },
  modeBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.sm,
  },
  modeBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  modelLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  modelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  modelBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
  },
  modelText: { fontSize: FontSize.sm },
  version: {
    fontSize: FontSize.xs,
    textAlign: 'center',
    paddingVertical: Spacing.xl,
  },
});
