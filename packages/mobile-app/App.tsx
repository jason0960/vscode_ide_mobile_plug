/**
 * Mobile Copilot — React Native App Entry Point.
 * Sets up navigation with bottom tabs and manages auth state.
 */

import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, View, ActivityIndicator, StyleSheet } from 'react-native';

import { useAppStore } from './src/store/AppStore';
import { Colors } from './src/theme';

import ConnectScreen from './src/screens/ConnectScreen';
import ChatScreen from './src/screens/ChatScreen';
import FilesScreen from './src/screens/FilesScreen';
import TerminalScreen from './src/screens/TerminalScreen';
import DiagnosticsScreen from './src/screens/DiagnosticsScreen';
import ChangesScreen from './src/screens/ChangesScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();

// ─── Tab Icon Component ─────────────────────────────────

function TabIcon({ emoji, badge, color }: { emoji: string; badge?: number; color: string }) {
  return (
    <View style={iconStyles.container}>
      <Text style={[iconStyles.emoji, { opacity: color === Colors.dark.tabInactive ? 0.5 : 1 }]}>
        {emoji}
      </Text>
      {badge !== undefined && badge > 0 && (
        <View style={iconStyles.badge}>
          <Text style={iconStyles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </View>
  );
}

const iconStyles = StyleSheet.create({
  container: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 20 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    backgroundColor: '#f14c4c',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});

// ─── Main App ───────────────────────────────────────────

export default function App() {
  const {
    connectionStatus,
    diagnosticsSummary,
    theme,
    loadCredentials,
    loadChatHistory,
    connectDirect,
    connectRelay,
    token,
    sessionId,
    relayUrl,
    relayCode,
  } = useAppStore();

  const colors = Colors[theme];
  const [loading, setLoading] = useState(true);

  // Load persisted state on startup
  useEffect(() => {
    (async () => {
      await loadCredentials();
      await loadChatHistory();
      setLoading(false);
    })();
  }, []);

  // Auto-reconnect with saved credentials
  useEffect(() => {
    if (loading) return;

    const state = useAppStore.getState();
    if (state.connectionStatus === 'disconnected') {
      if (state.relayUrl && state.relayCode) {
        state.connectRelay(state.relayUrl, state.relayCode);
      } else if (state.token) {
        // For direct mode, we'd need the URL which was the server origin.
        // In the RN app, there's no auto-detect — user must connect explicitly.
      }
    }
  }, [loading]);

  const isAuthenticated = connectionStatus === 'authenticated';
  const diagBadge = diagnosticsSummary.errors + diagnosticsSummary.warnings;

  const navTheme = theme === 'dark' ? {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: colors.background, card: colors.tabBar, border: colors.border, primary: colors.primary },
  } : {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: colors.background, card: colors.tabBar, border: colors.border, primary: colors.primary },
  };

  if (loading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Show connect screen if not authenticated
  if (!isAuthenticated) {
    return (
      <SafeAreaProvider>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <ConnectScreen />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <NavigationContainer theme={navTheme}>
        <Tab.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            tabBarActiveTintColor: colors.tabActive,
            tabBarInactiveTintColor: colors.tabInactive,
            tabBarStyle: { backgroundColor: colors.tabBar, borderTopColor: colors.border },
            tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          }}
        >
          <Tab.Screen
            name="Chat"
            component={ChatScreen}
            options={{
              headerTitle: useAppStore.getState().workspace?.name || 'Copilot Chat',
              tabBarIcon: ({ color }) => <TabIcon emoji="💬" color={color} />,
            }}
          />
          <Tab.Screen
            name="Files"
            component={FilesScreen}
            options={{
              tabBarIcon: ({ color }) => <TabIcon emoji="📁" color={color} />,
            }}
          />
          <Tab.Screen
            name="Terminal"
            component={TerminalScreen}
            options={{
              tabBarIcon: ({ color }) => <TabIcon emoji="🖥️" color={color} />,
            }}
          />
          <Tab.Screen
            name="Diagnostics"
            component={DiagnosticsScreen}
            options={{
              tabBarIcon: ({ color }) => <TabIcon emoji="🔍" badge={diagBadge} color={color} />,
            }}
          />
          <Tab.Screen
            name="Changes"
            component={ChangesScreen}
            options={{
              tabBarIcon: ({ color }) => <TabIcon emoji="🔀" color={color} />,
            }}
          />
          <Tab.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              tabBarIcon: ({ color }) => <TabIcon emoji="⚙️" color={color} />,
            }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
