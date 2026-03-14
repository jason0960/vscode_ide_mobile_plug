/**
 * Changes Screen — Git diff viewer with per-hunk approve/reject.
 * Lets you approve individual sections of a file and revert the rest.
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
  RefreshControl,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

// ─── Hunk Parsing ─────────────────────────────────────

interface DiffHunk {
  index: number;
  header: string;
  lines: string[];
  addedCount: number;
  removedCount: number;
}

interface ParsedDiff {
  headerLines: string[];
  hunks: DiffHunk[];
}

/** Split a unified diff into its file header and individual hunks. */
function parseDiffIntoHunks(diff: string): ParsedDiff {
  const lines = diff.split('\n');
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let idx = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { index: idx++, header: line, lines: [], addedCount: 0, removedCount: 0 };
    } else if (current) {
      current.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) current.addedCount++;
      else if (line.startsWith('-') && !line.startsWith('---')) current.removedCount++;
    } else {
      headerLines.push(line);
    }
  }
  if (current) hunks.push(current);

  return { headerLines, hunks };
}

const STATUS_ICONS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

// ─── Component ──────────────────────────────────────────

export default function ChangesScreen() {
  const { loadChanges, restoreFiles, revertHunks, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];

  const [data, setData] = useState<ChangesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  // Track which hunks the user REJECTED (wants to revert).
  // Key = file path, Value = set of hunk indices marked for rejection.
  const [rejectedHunks, setRejectedHunks] = useState<Map<string, Set<number>>>(new Map());

  const isAuthenticated = connectionStatus === 'authenticated';

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const result = await loadChanges();
      setData(result);
      setRejectedHunks(new Map()); // reset selections on refresh
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [isAuthenticated, loadChanges]);

  useEffect(() => {
    if (isAuthenticated) refresh();
  }, [isAuthenticated]);

  // ─── Hunk Toggle ──────────────────────────────────────

  const toggleHunk = useCallback((filePath: string, hunkIndex: number) => {
    setRejectedHunks((prev) => {
      const next = new Map(prev);
      const fileSet = new Set(next.get(filePath) || []);
      if (fileSet.has(hunkIndex)) {
        fileSet.delete(hunkIndex);
      } else {
        fileSet.add(hunkIndex);
      }
      if (fileSet.size === 0) {
        next.delete(filePath);
      } else {
        next.set(filePath, fileSet);
      }
      return next;
    });
  }, []);

  const rejectAllHunks = useCallback((filePath: string, hunkCount: number) => {
    setRejectedHunks((prev) => {
      const next = new Map(prev);
      const fileSet = new Set<number>();
      for (let i = 0; i < hunkCount; i++) fileSet.add(i);
      next.set(filePath, fileSet);
      return next;
    });
  }, []);

  const approveAllHunks = useCallback((filePath: string) => {
    setRejectedHunks((prev) => {
      const next = new Map(prev);
      next.delete(filePath);
      return next;
    });
  }, []);

  // ─── Apply Decisions ─────────────────────────────────

  const applyHunkDecisions = useCallback(async (filePath: string, diff: string, parsed: ParsedDiff) => {
    const rejected = rejectedHunks.get(filePath);
    if (!rejected || rejected.size === 0) {
      Alert.alert('Nothing to revert', 'All hunks are approved. Mark sections to reject first.');
      return;
    }

    // If ALL hunks rejected → just do a full file revert (simpler & more reliable)
    if (rejected.size === parsed.hunks.length) {
      Alert.alert('Revert Entire File', `All sections rejected — revert ${filePath}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revert',
          style: 'destructive',
          onPress: async () => {
            try {
              await restoreFiles([filePath]);
              setRejectedHunks((prev) => { const n = new Map(prev); n.delete(filePath); return n; });
              refresh();
            } catch (err: any) {
              Alert.alert('Error', `Revert failed: ${err.message}`);
            }
          },
        },
      ]);
      return;
    }

    const approvedCount = parsed.hunks.length - rejected.size;
    Alert.alert(
      'Apply Decisions',
      `Keep ${approvedCount} section${approvedCount !== 1 ? 's' : ''}, revert ${rejected.size} section${rejected.size !== 1 ? 's' : ''}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Apply',
          onPress: async () => {
            try {
              await revertHunks(filePath, Array.from(rejected), diff);
              setRejectedHunks((prev) => { const n = new Map(prev); n.delete(filePath); return n; });
              refresh();
            } catch (err: any) {
              Alert.alert('Error', `Failed to apply: ${err.message}`);
            }
          },
        },
      ],
    );
  }, [rejectedHunks, revertHunks, restoreFiles, refresh]);

  // ─── Revert Whole File (unchanged) ────────────────────

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

  // ─── Hunk Rendering ──────────────────────────────────

  const renderHunkLines = useCallback((lines: string[]) => {
    return lines.map((line, i) => {
      let bgColor = 'transparent';
      let textColor = colors.text;

      if (line.startsWith('+')) {
        bgColor = colors.diffAdded;
        textColor = colors.diffAddedText;
      } else if (line.startsWith('-')) {
        bgColor = colors.diffRemoved;
        textColor = colors.diffRemovedText;
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
    });
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

    const parsed = item.diff ? parseDiffIntoHunks(item.diff) : null;
    const fileRejected = rejectedHunks.get(item.path) || new Set<number>();
    const hasDecisions = fileRejected.size > 0;

    return (
      <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity
          style={styles.changeItem}
          onPress={() => setExpandedFile(isExpanded ? null : item.path)}
        >
          <Ionicons
            name={isExpanded ? 'chevron-down' : 'chevron-forward'}
            size={14}
            color={colors.textMuted}
            style={styles.expandArrow}
          />
          <Text style={[styles.statusBadge, { color: statusColor }]}>{statusIcon}</Text>
          <Text style={[styles.changePath, { color: colors.text }]} numberOfLines={1}>
            {item.path}
          </Text>
          {hasDecisions && (
            <View style={[styles.decisionIndicator, { backgroundColor: colors.warning + '33' }]}>
              <Text style={[styles.decisionText, { color: colors.warning }]}>
                {fileRejected.size} rejected
              </Text>
            </View>
          )}
          <Text style={[styles.diffAdded, { color: colors.diffAddedText }]}>+{addedLines}</Text>
          <Text style={[styles.diffRemoved, { color: colors.diffRemovedText }]}>-{removedLines}</Text>
        </TouchableOpacity>

        {isExpanded && (
          <View style={[styles.expandedContent, { backgroundColor: colors.codeBg }]}>
            {/* File-level actions */}
            <View style={styles.fileActions}>
              {parsed && parsed.hunks.length > 1 && (
                <>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: colors.success + '22' }]}
                    onPress={() => approveAllHunks(item.path)}
                  >
                    <Ionicons name="checkmark-done" size={14} color={colors.success} />
                    <Text style={[styles.actionBtnText, { color: colors.success }]}>Approve All</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: colors.error + '22' }]}
                    onPress={() => rejectAllHunks(item.path, parsed.hunks.length)}
                  >
                    <Ionicons name="close-circle-outline" size={14} color={colors.error} />
                    <Text style={[styles.actionBtnText, { color: colors.error }]}>Reject All</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: colors.error + '33' }]}
                onPress={() => revertFile(item.path)}
              >
                <Ionicons name="trash-outline" size={14} color={colors.error} />
                <Text style={[styles.actionBtnText, { color: colors.error }]}>Revert File</Text>
              </TouchableOpacity>
            </View>

            {/* Per-hunk display */}
            {parsed && parsed.hunks.length > 0 ? (
              <>
                {parsed.hunks.map((hunk) => {
                  const isRejected = fileRejected.has(hunk.index);
                  return (
                    <View
                      key={hunk.index}
                      style={[
                        styles.hunkContainer,
                        { borderColor: isRejected ? colors.error + '66' : colors.border },
                        isRejected && { backgroundColor: colors.error + '0A' },
                      ]}
                    >
                      {/* Hunk header bar */}
                      <View style={[styles.hunkHeader, { backgroundColor: colors.diffHunk }]}>
                        <Text style={[styles.hunkHeaderText, { color: colors.info }]} numberOfLines={1}>
                          {hunk.header}
                        </Text>
                        <View style={styles.hunkActions}>
                          <Text style={[styles.hunkStats, { color: colors.textMuted }]}>
                            +{hunk.addedCount} -{hunk.removedCount}
                          </Text>
                          <TouchableOpacity
                            style={[
                              styles.hunkToggle,
                              {
                                backgroundColor: isRejected
                                  ? colors.error + '33'
                                  : colors.success + '33',
                              },
                            ]}
                            onPress={() => toggleHunk(item.path, hunk.index)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Ionicons
                              name={isRejected ? 'close' : 'checkmark'}
                              size={16}
                              color={isRejected ? colors.error : colors.success}
                            />
                            <Text
                              style={[
                                styles.hunkToggleText,
                                { color: isRejected ? colors.error : colors.success },
                              ]}
                            >
                              {isRejected ? 'Rejected' : 'Approved'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      {/* Hunk diff lines */}
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={styles.hunkBody}>
                          {renderHunkLines(hunk.lines)}
                        </View>
                      </ScrollView>
                    </View>
                  );
                })}

                {/* Apply button — only visible when there are rejected hunks */}
                {hasDecisions && item.diff && (
                  <TouchableOpacity
                    style={[styles.applyBtn, { backgroundColor: colors.primary }]}
                    onPress={() => applyHunkDecisions(item.path, item.diff!, parsed)}
                  >
                    <Ionicons name="git-commit-outline" size={18} color="#fff" />
                    <Text style={styles.applyBtnText}>
                      Apply Decisions ({parsed.hunks.length - fileRejected.size} keep, {fileRejected.size} revert)
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
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
            <Ionicons name="refresh" size={18} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : !data || data.files.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="checkmark-circle-outline" size={48} color={colors.success} />
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
          extraData={rejectedHunks}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        />
      )}
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────

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
  headerBtn: { padding: Spacing.xs, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  changeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  expandArrow: { width: 16 },
  statusBadge: { fontSize: FontSize.sm, fontWeight: '700', width: 20 },
  changePath: { flex: 1, fontSize: FontSize.sm },
  decisionIndicator: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  decisionText: { fontSize: 10, fontWeight: '700' },
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
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
    flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.sm,
  },
  actionBtnText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Hunk styles
  hunkContainer: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm,
    overflow: 'hidden',
  },
  hunkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    gap: Spacing.sm,
  },
  hunkHeaderText: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  hunkActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  hunkStats: { fontSize: 10, fontWeight: '600' },
  hunkToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: BorderRadius.full,
    minHeight: 28,
  },
  hunkToggleText: { fontSize: 11, fontWeight: '700' },
  hunkBody: {
    paddingVertical: 2,
  },

  // Apply button
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    marginTop: Spacing.xs,
  },
  applyBtnText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '700',
  },

  diffLine: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    paddingHorizontal: Spacing.sm,
    minWidth: '100%',
  },
  noDiff: { fontSize: FontSize.sm, textAlign: 'center', padding: Spacing.md },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: FontSize.md, marginTop: Spacing.lg },
});
