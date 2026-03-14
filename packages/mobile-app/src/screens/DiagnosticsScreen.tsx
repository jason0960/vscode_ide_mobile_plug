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
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore, DiagnosticInfo } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius, ThemeColors } from '../theme';

const SEVERITY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  error: 'close-circle',
  warning: 'warning',
  info: 'information-circle',
  hint: 'bulb-outline',
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
    const sevIcon = SEVERITY_ICONS[item.severity] || 'help-circle-outline';
    return (
      <View style={[styles.diagItem, { borderBottomColor: colors.border }]}>
        <View style={styles.diagHeader}>
          <View style={styles.severityRow}>
            <Ionicons name={sevIcon as any} size={16} color={sevColor} />
            <Text style={[styles.severity, { color: sevColor }]}>
              {item.severity}
            </Text>
          </View>
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
          <View style={styles.filterContent}>
            <Ionicons name="close-circle" size={14} color={filter === 'error' ? '#fff' : colors.error} />
            <Text style={[styles.filterText, { color: filter === 'error' ? '#fff' : colors.error }]}>
              {diagnosticsSummary.errors}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterBtn, filter === 'warning' && { backgroundColor: colors.warning }]}
          onPress={() => setFilter('warning')}
        >
          <View style={styles.filterContent}>
            <Ionicons name="warning" size={14} color={filter === 'warning' ? '#fff' : colors.warning} />
            <Text style={[styles.filterText, { color: filter === 'warning' ? '#fff' : colors.warning }]}>
              {diagnosticsSummary.warnings}
            </Text>
          </View>
        </TouchableOpacity>

        <View style={{ flex: 1 }} />

        <TouchableOpacity onPress={refresh} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : filteredDiags.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="checkmark-circle-outline" size={48} color={colors.success} />
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
  filterContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  filterText: { fontSize: FontSize.sm, fontWeight: '600' },
  refreshBtn: { padding: Spacing.xs, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
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
  severityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  severity: { fontSize: FontSize.sm, fontWeight: '600' },
  location: { fontSize: FontSize.xs },
  message: { fontSize: FontSize.md, lineHeight: 24 },
  source: { fontSize: FontSize.xs, marginTop: Spacing.xs },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: FontSize.md, marginTop: Spacing.lg },
});
