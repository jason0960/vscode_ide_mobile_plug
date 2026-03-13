/**
 * Changes Screen — Git diff viewer with accept/revert.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useAppStore, GitChange } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';

interface ChangesData {
  files: GitChange[];
  summary: {
    modified: number;
    added: number;
    deleted: number;
    totalAdded: number;
    totalRemoved: number;
  };
}

const STATUS_ICONS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

export default function ChangesScreen() {
  const { loadChanges, restoreFiles, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];

  const [data, setData] = useState<ChangesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  const isAuthenticated = connectionStatus === 'authenticated';

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const result = await loadChanges();
      setData(result);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [isAuthenticated, loadChanges]);

  useEffect(() => {
    if (isAuthenticated) refresh();
  }, [isAuthenticated]);

  const revertFile = useCallback(async (path: string) => {
    Alert.alert('Revert File', `Revert all changes to ${path}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revert',
        style: 'destructive',
        onPress: async () => {
          try {
            await restoreFiles([path]);
            refresh();
          } catch (err: any) {
            Alert.alert('Error', `Revert failed: ${err.message}`);
          }
        },
      },
    ]);
  }, [restoreFiles, refresh]);

  const revertAll = useCallback(() => {
    if (!data?.files.length) return;
    Alert.alert('Revert All', `Revert ALL ${data.files.length} changed files?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revert All',
        style: 'destructive',
        onPress: async () => {
          try {
            await restoreFiles(data.files.map((f) => f.path));
            refresh();
          } catch (err: any) {
            Alert.alert('Error', `Revert failed: ${err.message}`);
          }
        },
      },
    ]);
  }, [data, restoreFiles, refresh]);

  // ─── Diff Rendering ───────────────────────────────────

  const renderDiff = useCallback((diff: string) => {
    const lines = diff.split('\n');
    return (
      <ScrollView horizontal>
        <View>
          {lines.map((line, i) => {
            // Skip header lines
            if (line.startsWith('diff --git') || line.startsWith('index ') ||
                line.startsWith('---') || line.startsWith('+++')) return null;

            let bgColor = 'transparent';
            let textColor = colors.textMuted;

            if (line.startsWith('@@')) {
              bgColor = colors.diffHunk;
              textColor = colors.info;
            } else if (line.startsWith('+')) {
              bgColor = colors.diffAdded;
              textColor = colors.diffAddedText;
            } else if (line.startsWith('-')) {
              bgColor = colors.diffRemoved;
              textColor = colors.diffRemovedText;
            } else {
              textColor = colors.text;
            }

            return (
              <Text
                key={i}
                style={[styles.diffLine, { backgroundColor: bgColor, color: textColor }]}
                selectable
              >
                {line || ' '}
              </Text>
            );
          })}
        </View>
      </ScrollView>
    );
  }, [colors]);

  // ─── File Item ────────────────────────────────────────

  const renderItem = ({ item }: { item: GitChange }) => {
    const isExpanded = expandedFile === item.path;
    const statusIcon = STATUS_ICONS[item.status] || '?';
    const statusColor = item.status === 'added' ? colors.success
      : item.status === 'deleted' ? colors.error
      : colors.warning;

    // Count lines
    let addedLines = 0, removedLines = 0;
    if (item.diff) {
      const dLines = item.diff.split('\n');
      addedLines = dLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      removedLines = dLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    }

    return (
      <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity
          style={styles.changeItem}
          onPress={() => setExpandedFile(isExpanded ? null : item.path)}
        >
          <Text style={[styles.expandArrow, { color: colors.textMuted }]}>
            {isExpanded ? '▾' : '▸'}
          </Text>
          <Text style={[styles.statusBadge, { color: statusColor }]}>{statusIcon}</Text>
          <Text style={[styles.changePath, { color: colors.text }]} numberOfLines={1}>
            {item.path}
          </Text>
          <Text style={[styles.diffAdded, { color: colors.diffAddedText }]}>+{addedLines}</Text>
          <Text style={[styles.diffRemoved, { color: colors.diffRemovedText }]}>-{removedLines}</Text>
        </TouchableOpacity>

        {isExpanded && (
          <View style={[styles.expandedContent, { backgroundColor: colors.codeBg }]}>
            <View style={styles.fileActions}>
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: colors.error + '33' }]}
                onPress={() => revertFile(item.path)}
              >
                <Text style={[styles.actionBtnText, { color: colors.error }]}>Revert</Text>
              </TouchableOpacity>
            </View>
            {item.diff ? renderDiff(item.diff) : (
              <Text style={[styles.noDiff, { color: colors.textMuted }]}>No diff available</Text>
            )}
          </View>
        )}
      </View>
    );
  };

  // ─── Main Render ──────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Summary bar */}
      <View style={[styles.summaryBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {data?.summary ? (
          <View style={styles.summaryStats}>
            {data.summary.modified > 0 && (
              <Text style={[styles.statText, { color: colors.warning }]}>{data.summary.modified} modified</Text>
            )}
            {data.summary.added > 0 && (
              <Text style={[styles.statText, { color: colors.success }]}>{data.summary.added} added</Text>
            )}
            {data.summary.deleted > 0 && (
              <Text style={[styles.statText, { color: colors.error }]}>{data.summary.deleted} deleted</Text>
            )}
            <Text style={[styles.diffAdded, { color: colors.diffAddedText }]}>+{data.summary.totalAdded}</Text>
            <Text style={[styles.diffRemoved, { color: colors.diffRemovedText }]}>-{data.summary.totalRemoved}</Text>
          </View>
        ) : (
          <View style={styles.summaryStats} />
        )}

        <View style={styles.summaryActions}>
          {data && data.files.length > 0 && (
            <TouchableOpacity onPress={revertAll} style={styles.headerBtn}>
              <Text style={[styles.headerBtnText, { color: colors.error }]}>Revert All</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={refresh} style={styles.headerBtn}>
            <Text style={[styles.headerBtnText, { color: colors.primary }]}>↻</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : !data || data.files.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>✓</Text>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            Working tree clean — no uncommitted changes
          </Text>
        </View>
      ) : (
        <FlatList
          data={data.files}
          renderItem={renderItem}
          keyExtractor={(item) => item.path}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
  },
  summaryStats: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center', flexShrink: 1 },
  summaryActions: { flexDirection: 'row', gap: Spacing.sm },
  statText: { fontSize: FontSize.xs, fontWeight: '600' },
  headerBtn: { padding: Spacing.xs },
  headerBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  changeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  expandArrow: { fontSize: 12, width: 16 },
  statusBadge: { fontSize: FontSize.sm, fontWeight: '700', width: 20 },
  changePath: { flex: 1, fontSize: FontSize.sm },
  diffAdded: { fontSize: FontSize.xs, fontWeight: '600' },
  diffRemoved: { fontSize: FontSize.xs, fontWeight: '600' },
  expandedContent: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
  },
  fileActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: Spacing.sm,
  },
  actionBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.sm,
  },
  actionBtnText: { fontSize: FontSize.xs, fontWeight: '600' },
  diffLine: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    paddingHorizontal: Spacing.sm,
    minWidth: '100%',
  },
  noDiff: { fontSize: FontSize.sm, textAlign: 'center', padding: Spacing.md },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md, color: '#4ec9b0' },
  emptyText: { fontSize: FontSize.md },
});
