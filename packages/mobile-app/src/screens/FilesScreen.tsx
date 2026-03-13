/**
 * Files Screen — browse workspace files, view with syntax hints.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useAppStore, FileInfo } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';

const FILE_ICONS: Record<string, string> = {
  ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️',
  py: '🐍', rb: '💎', go: '🔵', rs: '🦀',
  java: '☕', kt: '🟪', cs: '🟩', cpp: '🔧', c: '🔧', h: '🔧',
  html: '🌐', css: '🎨', scss: '🎨', json: '📋',
  yaml: '📋', yml: '📋', md: '📝', sh: '🖥️',
  sql: '🗃️', xml: '📄', svg: '🖼️',
  png: '🖼️', jpg: '🖼️', gif: '🖼️',
  lock: '🔒', gitignore: '🚫',
};

function getIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICONS[ext] || '📄';
}

export default function FilesScreen() {
  const { loadFileTree, readFile, connectionStatus, theme } = useAppStore();
  const colors = Colors[theme];

  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);
  const [viewingFile, setViewingFile] = useState<{ name: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const isAuthenticated = connectionStatus === 'authenticated';

  const loadDir = useCallback(async (dirPath?: string) => {
    if (!isAuthenticated) return;
    setLoading(true);
    setViewingFile(null);
    try {
      const result = await loadFileTree(dirPath);
      setFiles(result || []);
      setCurrentPath(dirPath);
    } catch {
      setFiles([]);
    }
    setLoading(false);
  }, [isAuthenticated, loadFileTree]);

  useEffect(() => {
    if (isAuthenticated) loadDir();
  }, [isAuthenticated]);

  const openFile = useCallback(async (path: string, name: string) => {
    setFileLoading(true);
    try {
      const content = await readFile(path);
      setViewingFile({ name, content });
    } catch (err: any) {
      setViewingFile({ name, content: `Error: ${err.message}` });
    }
    setFileLoading(false);
  }, [readFile]);

  const goBack = useCallback(() => {
    if (viewingFile) {
      setViewingFile(null);
      return;
    }
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      loadDir(parent || undefined);
    }
  }, [viewingFile, currentPath, loadDir]);

  // ─── File Viewer ──────────────────────────────────────

  if (viewingFile) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.toolbar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Text style={[styles.backText, { color: colors.primary }]}>← Back</Text>
          </TouchableOpacity>
          <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
            {viewingFile.name}
          </Text>
        </View>
        {fileLoading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : (
          <ScrollView style={styles.codeScroll} horizontal>
            <ScrollView>
              <Text style={[styles.code, { color: colors.codeText }]}>{viewingFile.content}</Text>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    );
  }

  // ─── File Browser ─────────────────────────────────────

  const renderItem = ({ item }: { item: FileInfo }) => (
    <TouchableOpacity
      style={[styles.fileItem, { borderBottomColor: colors.border }]}
      onPress={() => item.isDirectory ? loadDir(item.path) : openFile(item.path, item.name)}
    >
      <Text style={styles.fileIcon}>{getIcon(item.name, item.isDirectory)}</Text>
      <Text style={[
        styles.fileItemName,
        { color: colors.text },
        item.isDirectory && { fontWeight: '600' },
      ]} numberOfLines={1}>
        {item.name}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.toolbar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {currentPath ? (
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Text style={[styles.backText, { color: colors.primary }]}>← Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text style={[styles.pathText, { color: colors.textSecondary }]} numberOfLines={1}>
          {currentPath || '/'}
        </Text>
        <TouchableOpacity onPress={() => loadDir(currentPath)} style={styles.refreshBtn}>
          <Text style={[styles.refreshText, { color: colors.primary }]}>↻</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : files.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            {isAuthenticated ? 'No files found' : 'Connect to browse files'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={files}
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
  },
  backBtn: { minWidth: 60 },
  backText: { fontSize: FontSize.md, fontWeight: '600' },
  pathText: { flex: 1, fontSize: FontSize.sm, textAlign: 'center' },
  fileName: { flex: 1, fontSize: FontSize.md, fontWeight: '600', textAlign: 'center' },
  refreshBtn: { minWidth: 40, alignItems: 'flex-end' },
  refreshText: { fontSize: 24 },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  fileIcon: { fontSize: 20, width: 28 },
  fileItemName: { flex: 1, fontSize: FontSize.md },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: FontSize.md },
  codeScroll: { flex: 1, padding: Spacing.md },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FontSize.code,
    lineHeight: 20,
  },
});

// Platform import needed for font
import { Platform } from 'react-native';
