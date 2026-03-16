/**
 * Settings Screen — connection info, theme, model, disconnect.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
  Platform,
  Modal,
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
    relayServerUrl,
    theme,
    selectedModel,
    chatMode,
    connection,
    setTheme,
    setSelectedModel,
    setChatMode,
    setRelayServerUrl,
    disconnect,
    switchRoom,
  } = useAppStore();

  const colors = Colors[theme];
  const isAuthenticated = connectionStatus === 'authenticated';
  const [editingRelayUrl, setEditingRelayUrl] = useState(false);
  const [relayUrlDraft, setRelayUrlDraft] = useState(relayServerUrl);
  const [roomModalVisible, setRoomModalVisible] = useState(false);
  const [roomDraft, setRoomDraft] = useState('');

  const handleChangeRoom = () => {
    setRoomDraft('');
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Switch Room',
        'Enter a new 6-character room code:',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Switch',
            onPress: (code?: string) => {
              const trimmed = (code ?? '').trim().toUpperCase();
              if (trimmed.length >= 4 && trimmed.length <= 8) {
                switchRoom(trimmed);
              } else {
                Alert.alert('Invalid Code', 'Room code must be 4-8 characters.');
              }
            },
          },
        ],
        'plain-text',
        '',
        'default',
      );
    } else {
      setRoomModalVisible(true);
    }
  };

  const submitRoomSwitch = () => {
    const trimmed = roomDraft.trim().toUpperCase();
    setRoomModalVisible(false);
    if (trimmed.length >= 4 && trimmed.length <= 8) {
      switchRoom(trimmed);
    } else {
      Alert.alert('Invalid Code', 'Room code must be 4-8 characters.');
    }
  };

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
        {relayCode && <Row label="Room Code" value={`${relayCode}  ✏️`} onPress={handleChangeRoom} />}
        {relayUrl && <Row label="Relay URL" value={relayUrl} />}
      </View>

      {/* Relay Server */}
      <SectionHeader title="RELAY SERVER" />
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        {editingRelayUrl ? (
          <View style={[styles.row, { borderBottomColor: colors.border, flexDirection: 'column', alignItems: 'stretch' }]}>
            <TextInput
              style={[styles.relayInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
              value={relayUrlDraft}
              onChangeText={setRelayUrlDraft}
              placeholder="ws://... or wss://..."
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              autoFocus
            />
            <View style={styles.relayBtnRow}>
              <TouchableOpacity
                style={[styles.relayBtn, { backgroundColor: colors.primary }]}
                onPress={() => {
                  setRelayServerUrl(relayUrlDraft.trim());
                  setEditingRelayUrl(false);
                }}
              >
                <Text style={styles.relayBtnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.relayBtn, { backgroundColor: colors.border }]}
                onPress={() => {
                  setRelayUrlDraft(relayServerUrl);
                  setEditingRelayUrl(false);
                }}
              >
                <Text style={[styles.relayBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <Row label="Server URL" value={relayServerUrl} onPress={() => setEditingRelayUrl(true)} />
        )}
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.hintText, { color: colors.textMuted }]}>
            The WebSocket URL of your relay server. All room codes resolve against this server.
          </Text>
        </View>
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

      {/* Room Switch Modal (Android / Web) */}
      <Modal
        visible={roomModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRoomModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Switch Room</Text>
            <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>Enter a new room code:</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
              value={roomDraft}
              onChangeText={setRoomDraft}
              placeholder="e.g. ABC123"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
              autoFocus
              onSubmitEditing={submitRoomSwitch}
            />
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.border }]}
                onPress={() => setRoomModalVisible(false)}
              >
                <Text style={[styles.modalBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.primary }]}
                onPress={submitRoomSwitch}
              >
                <Text style={styles.modalBtnText}>Switch</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  relayInput: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    fontSize: FontSize.sm,
    marginBottom: Spacing.sm,
  },
  relayBtnRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  relayBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  relayBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  hintText: {
    fontSize: FontSize.xs,
    lineHeight: 18,
  },
  version: {
    fontSize: FontSize.xs,
    textAlign: 'center',
    paddingVertical: Spacing.xl,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalBox: {
    width: 300,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    marginBottom: Spacing.xs,
  },
  modalSubtitle: {
    fontSize: FontSize.sm,
    marginBottom: Spacing.md,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.lg,
    fontWeight: '600',
    letterSpacing: 3,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  modalBtnRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  modalBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: FontSize.sm,
  },
});
