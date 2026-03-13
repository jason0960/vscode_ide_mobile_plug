/**
 * Diagnostics Screen — errors and warnings from VS Code.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useAppStore, DiagnosticInfo } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius, ThemeColors } from '../theme';

const SEVERITY_ICONS: Record<string, string> = {
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
  hint: '💡',
};

const SEVERITY_COLORS = (colors: ThemeColors) => ({
  error: colors.error,
  warning: colors.warning,
  info: colors.info,
  hint: colors.textSecondary,
});

export default function DiagnosticsScreen() {
  const { loadDiagnostics, diagnosticsSummary, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];
  const sevColors = SEVERITY_COLORS(colors);

  const [diagnostics, setDiagnostics] = useState<DiagnosticInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');

  const isAuthenticated = connectionStatus === 'authenticated';

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const diags = await loadDiagnostics();
      setDiagnostics(diags);
    } catch {
      setDiagnostics([]);
    }
    setLoading(false);
  }, [isAuthenticated, loadDiagnostics]);

  useEffect(() => {
    if (isAuthenticated) refresh();
  }, [isAuthenticated]);

  const filteredDiags = filter === 'all'
    ? diagnostics
    : diagnostics.filter((d) => d.severity === filter);

  const renderItem = ({ item }: { item: DiagnosticInfo }) => {
    const sevColor = sevColors[item.severity as keyof typeof sevColors] || colors.textSecondary;
    return (
      <View style={[styles.diagItem, { borderBottomColor: colors.border }]}>
        <View style={styles.diagHeader}>
          <Text style={[styles.severity, { color: sevColor }]}>
            {SEVERITY_ICONS[item.severity] || '•'} {item.severity}
          </Text>
          <Text style={[styles.location, { color: colors.textSecondary }]}>
            {item.file}:{item.line}
          </Text>
        </View>
        <Text style={[styles.message, { color: colors.text }]} selectable>
          {item.message}
        </Text>
        {item.source && (
          <Text style={[styles.source, { color: colors.textMuted }]}>{item.source}</Text>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Summary bar */}
      <View style={[styles.summaryBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.filterBtn, filter === 'all' && { backgroundColor: colors.primary }]}
          onPress={() => setFilter('all')}
        >
          <Text style={[styles.filterText, { color: filter === 'all' ? '#fff' : colors.textSecondary }]}>
            All
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterBtn, filter === 'error' && { backgroundColor: colors.error }]}
          onPress={() => setFilter('error')}
        >
          <Text style={[styles.filterText, { color: filter === 'error' ? '#fff' : colors.error }]}>
            ✕ {diagnosticsSummary.errors}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterBtn, filter === 'warning' && { backgroundColor: colors.warning }]}
          onPress={() => setFilter('warning')}
        >
          <Text style={[styles.filterText, { color: filter === 'warning' ? '#fff' : colors.warning }]}>
            ⚠ {diagnosticsSummary.warnings}
          </Text>
        </TouchableOpacity>

        <View style={{ flex: 1 }} />

        <TouchableOpacity onPress={refresh} style={styles.refreshBtn}>
          <Text style={[styles.refreshText, { color: colors.primary }]}>↻</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : filteredDiags.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>🎉</Text>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            {diagnostics.length === 0 ? 'No diagnostics — looking good!' : 'No matching diagnostics'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredDiags}
          renderItem={renderItem}
          keyExtractor={(item, i) => `${item.file}:${item.line}:${i}`}
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
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    gap: Spacing.xs,
  },
  filterBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
  filterText: { fontSize: FontSize.sm, fontWeight: '600' },
  refreshBtn: { padding: Spacing.xs },
  refreshText: { fontSize: 22 },
  diagItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  diagHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  severity: { fontSize: FontSize.sm, fontWeight: '600' },
  location: { fontSize: FontSize.xs },
  message: { fontSize: FontSize.md, lineHeight: 22 },
  source: { fontSize: FontSize.xs, marginTop: Spacing.xs },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { fontSize: FontSize.md },
});
