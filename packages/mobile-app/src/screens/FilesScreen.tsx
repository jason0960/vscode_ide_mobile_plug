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
  RefreshControl,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore, FileInfo } from '../store/AppStore';
import { Colors, Spacing, FontSize, BorderRadius } from '../theme';
import { SyntaxHighlighter, DARK_SYNTAX, LIGHT_SYNTAX } from '../components/SyntaxHighlighter';

/** Map file extensions to Ionicons icon names and colors */
const FILE_ICON_MAP: Record<string, { icon: string; color: string }> = {
  ts: { icon: 'logo-javascript', color: '#3178c6' },
  tsx: { icon: 'logo-react', color: '#61dafb' },
  js: { icon: 'logo-javascript', color: '#f7df1e' },
  jsx: { icon: 'logo-react', color: '#61dafb' },
  py: { icon: 'logo-python', color: '#3776ab' },
  json: { icon: 'code-slash-outline', color: '#f7df1e' },
  md: { icon: 'document-text-outline', color: '#8b949e' },
  html: { icon: 'logo-html5', color: '#e34f26' },
  css: { icon: 'logo-css3', color: '#1572b6' },
  scss: { icon: 'logo-css3', color: '#cd6799' },
  yaml: { icon: 'settings-outline', color: '#cb171e' },
  yml: { icon: 'settings-outline', color: '#cb171e' },
  sh: { icon: 'terminal-outline', color: '#3fb950' },
  sql: { icon: 'server-outline', color: '#336791' },
  lock: { icon: 'lock-closed-outline', color: '#8b949e' },
  gitignore: { icon: 'logo-github', color: '#8b949e' },
};

function getFileIcon(name: string, isDir: boolean): { icon: string; color: string } {
  if (isDir) return { icon: 'folder', color: '#58a6ff' };
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICON_MAP[ext] || { icon: 'document-outline', color: '#8b949e' };
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
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
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
              <SyntaxHighlighter
                code={viewingFile.content}
                theme={theme === 'dark' ? DARK_SYNTAX : LIGHT_SYNTAX}
                showLineNumbers
                maxLines={2000}
              />
            </ScrollView>
          </ScrollView>
        )}
      </View>
    );
  }

  // ─── File Browser ─────────────────────────────────────

  const renderItem = ({ item }: { item: FileInfo }) => {
    const fi = getFileIcon(item.name, item.isDirectory);
    return (
      <TouchableOpacity
        style={[styles.fileItem, { borderBottomColor: colors.border }]}
        onPress={() => item.isDirectory ? loadDir(item.path) : openFile(item.path, item.name)}
      >
        <Ionicons name={fi.icon as any} size={20} color={fi.color} style={styles.fileIcon} />
        <Text style={[
          styles.fileItemName,
          { color: colors.text },
          item.isDirectory && { fontWeight: '600' },
        ]} numberOfLines={1}>
          {item.name}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.toolbar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {currentPath ? (
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text style={[styles.pathText, { color: colors.textSecondary }]} numberOfLines={1}>
          {currentPath || '/'}
        </Text>
        <TouchableOpacity onPress={() => loadDir(currentPath)} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={20} color={colors.primary} />
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
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => loadDir(currentPath)}
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
  },
  backBtn: { minWidth: 60, flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { fontSize: FontSize.md, fontWeight: '600' },
  pathText: { flex: 1, fontSize: FontSize.sm, textAlign: 'center' },
  fileName: { flex: 1, fontSize: FontSize.md, fontWeight: '600', textAlign: 'center' },
  refreshBtn: { minWidth: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  fileIcon: { width: 28, textAlign: 'center' },
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
