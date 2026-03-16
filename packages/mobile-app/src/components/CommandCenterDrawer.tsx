/**
 * Command Center Drawer — custom drawer content for the AI Command Center.
 * Designed for AI developers and VibeCoders.
 * Future-proofed for multi-IDE support beyond VS Code.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
  TextInput,
  Modal,
} from 'react-native';
import {
  DrawerContentScrollView,
  DrawerContentComponentProps,
} from '@react-navigation/drawer';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';

// ─── Types ──────────────────────────────────────────────

interface NavItem {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  badge?: number;
  section: 'main' | 'workspace' | 'system';
}

// ─── Drawer Content ─────────────────────────────────────

export default function CommandCenterDrawer(props: DrawerContentComponentProps) {
  const {
    connectionStatus,
    diagnosticsSummary,
    workspace,
    theme,
    relayCode,
  } = useAppStore();
  const switchRoom = useAppStore((s) => s.switchRoom);

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
      // Android / Web: use modal
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

  const colors = Colors[theme];
  const insets = useSafeAreaInsets();
  const diagBadge = diagnosticsSummary.errors + diagnosticsSummary.warnings;
  const currentRoute = props.state.routes[props.state.index]?.name;

  const navItems: NavItem[] = [
    // Main
    { key: 'Chat', label: 'Copilot Chat', icon: 'chatbubble-outline', section: 'main' },
    // Workspace
    { key: 'Files', label: 'File Explorer', icon: 'folder-outline', section: 'workspace' },
    { key: 'Terminal', label: 'Terminal', icon: 'terminal-outline', section: 'workspace' },
    { key: 'Commands', label: 'Quick Commands', icon: 'flash-outline', section: 'workspace' },
    { key: 'Changes', label: 'Source Control', icon: 'git-compare-outline', section: 'workspace' },
    { key: 'Diagnostics', label: 'Problems', icon: 'alert-circle-outline', badge: diagBadge, section: 'workspace' },
    // System
    { key: 'Settings', label: 'Settings', icon: 'settings-outline', section: 'system' },
  ];

  const renderItem = (item: NavItem) => {
    const isActive = currentRoute === item.key;
    return (
      <TouchableOpacity
        key={item.key}
        style={[
          styles.navItem,
          isActive && { backgroundColor: colors.primary + '1A' },
        ]}
        onPress={() => props.navigation.navigate(item.key)}
        activeOpacity={0.7}
      >
        <View style={styles.navItemLeft}>
          <Ionicons
            name={isActive ? (item.icon.replace('-outline', '') as any) : item.icon}
            size={20}
            color={isActive ? colors.primaryLight : colors.textSecondary}
          />
          <Text
            style={[
              styles.navItemLabel,
              { color: isActive ? colors.text : colors.textSecondary },
              isActive && { fontWeight: '600' },
            ]}
          >
            {item.label}
          </Text>
        </View>
        {item.badge !== undefined && item.badge > 0 && (
          <View style={[styles.badge, { backgroundColor: colors.error }]}>
            <Text style={styles.badgeText}>
              {item.badge > 99 ? '99+' : item.badge}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderSection = (title: string, section: NavItem['section']) => {
    const items = navItems.filter((i) => i.section === section);
    if (items.length === 0) return null;
    return (
      <View style={styles.section} key={section}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
          {title}
        </Text>
        {items.map(renderItem)}
      </View>
    );
  };

  // Connection status indicator
  const statusColor =
    connectionStatus === 'authenticated' ? colors.online
    : connectionStatus === 'connecting' || connectionStatus === 'connected' ? colors.connecting
    : colors.offline;
  const statusText =
    connectionStatus === 'authenticated' ? 'Connected'
    : connectionStatus === 'connecting' || connectionStatus === 'connected' ? 'Connecting...'
    : 'Disconnected';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header — Brand */}
      <View style={[styles.header, { paddingTop: insets.top + Spacing.md, borderBottomColor: colors.border }]}>
        <View style={styles.brandRow}>
          <View style={[styles.logoBox, { backgroundColor: colors.primary }]}>
            <Ionicons name="code-slash" size={18} color="#fff" />
          </View>
          <View style={styles.brandText}>
            <Text style={[styles.brandName, { color: colors.text }]}>
              Mobile Copilot
            </Text>
            <Text style={[styles.brandSub, { color: colors.textMuted }]}>
              AI Command Center
            </Text>
          </View>
        </View>

        {/* Connection chip */}
        <View style={[styles.statusChip, { backgroundColor: statusColor + '1A' }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>
            {statusText}
          </Text>
          {relayCode && (
            <TouchableOpacity onPress={handleChangeRoom} style={styles.roomCodeBtn}>
              <Text style={[styles.roomCode, { color: colors.textMuted }]}>
                {relayCode}
              </Text>
              <Ionicons name="swap-horizontal" size={12} color={colors.textMuted} style={{ marginLeft: 4 }} />
            </TouchableOpacity>
          )}
        </View>

        {/* Switch Room button — visible when connected via relay */}
        {relayCode && connectionStatus === 'authenticated' && (
          <TouchableOpacity
            style={[styles.switchRoomBtn, { borderColor: colors.border }]}
            onPress={handleChangeRoom}
          >
            <Ionicons name="swap-horizontal" size={14} color={colors.primary} />
            <Text style={[styles.switchRoomText, { color: colors.primary }]}>Switch Room</Text>
          </TouchableOpacity>
        )}

        {/* Workspace info */}
        {workspace && (
          <View style={styles.workspaceRow}>
            <Ionicons name="briefcase-outline" size={14} color={colors.textMuted} />
            <Text style={[styles.workspaceName, { color: colors.textSecondary }]} numberOfLines={1}>
              {workspace.name}
            </Text>
            {workspace.gitBranch && (
              <>
                <Ionicons name="git-branch-outline" size={14} color={colors.textMuted} />
                <Text style={[styles.branchName, { color: colors.textSecondary }]} numberOfLines={1}>
                  {workspace.gitBranch}
                </Text>
              </>
            )}
          </View>
        )}
      </View>

      {/* Navigation */}
      <ScrollView style={styles.navScroll} showsVerticalScrollIndicator={false}>
        {renderSection('', 'main')}
        {renderSection('WORKSPACE', 'workspace')}
        {renderSection('SYSTEM', 'system')}
      </ScrollView>

      {/* Footer — IDE selector (future-proofed) */}
      <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + Spacing.sm }]}>
        <View style={styles.ideRow}>
          <View style={[styles.ideChip, { backgroundColor: colors.primary + '1A', borderColor: colors.primary }]}>
            <Ionicons name="code-slash" size={14} color={colors.primary} />
            <Text style={[styles.ideChipText, { color: colors.primary }]}>VS Code</Text>
          </View>
          {/* Future IDEs will go here */}
          <View style={[styles.ideChipDisabled, { borderColor: colors.border }]}>
            <Text style={[styles.ideChipText, { color: colors.textMuted }]}>+ IDE</Text>
          </View>
        </View>
        <Text style={[styles.version, { color: colors.textMuted }]}>
          v0.2.0
        </Text>
      </View>

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
            <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>
              Enter a new room code:
            </Text>
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
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  header: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  logoBox: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: {
    flex: 1,
  },
  brandName: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  brandSub: {
    fontSize: FontSize.xs,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // Status
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: 6,
    marginBottom: Spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  roomCode: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },

  // Workspace
  workspaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  workspaceName: {
    fontSize: FontSize.xs,
    flexShrink: 1,
  },
  branchName: {
    fontSize: FontSize.xs,
    flexShrink: 1,
  },

  // Navigation
  navScroll: {
    flex: 1,
    paddingTop: Spacing.sm,
  },
  section: {
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    marginHorizontal: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  navItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    flex: 1,
  },
  navItemLabel: {
    fontSize: FontSize.md,
  },
  badge: {
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },

  // Footer
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  ideRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  ideChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },
  ideChipDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  ideChipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  version: {
    fontSize: 10,
    textAlign: 'center',
    paddingVertical: Spacing.xs,
  },

  // Room code tappable area
  roomCodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Switch Room button
  switchRoomBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
  },
  switchRoomText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },

  // Modal styles
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
