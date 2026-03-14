/**
 * Mobile Copilot — React Native App Entry Point.
 * AI Command Center with drawer navigation.
 * Future-proofed for multi-IDE support beyond VS Code.
 */

// Must be imported before any React Navigation code to ensure gesture handler is initialized
import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAppStore } from './src/store/AppStore';
import { Colors } from './src/theme';
import CommandCenterDrawer from './src/components/CommandCenterDrawer';

import ConnectScreen from './src/screens/ConnectScreen';
import ChatScreen from './src/screens/ChatScreen';
import FilesScreen from './src/screens/FilesScreen';
import TerminalScreen from './src/screens/TerminalScreen';
import DiagnosticsScreen from './src/screens/DiagnosticsScreen';
import ChangesScreen from './src/screens/ChangesScreen';
import QuickCommandsScreen from './src/screens/QuickCommandsScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Drawer = createDrawerNavigator();

// ─── Main App ───────────────────────────────────────────

export default function App() {
  const {
    connectionStatus,
    theme,
    loadCredentials,
    loadChatHistory,
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
    if (state.connectionStatus !== 'disconnected') return;

    // Only auto-reconnect if we have a saved session (was previously authenticated)
    if (state.relayUrl && state.relayCode && state.sessionId) {
      state.connectRelay(state.relayUrl, state.relayCode);
    }
    // Direct mode requires explicit reconnection — no auto-connect
  }, [loading]);

  const isAuthenticated = connectionStatus === 'authenticated';

  const navTheme = theme === 'dark' ? {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: colors.background, card: colors.surface, border: colors.border, primary: colors.primary },
  } : {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: colors.background, card: colors.surface, border: colors.border, primary: colors.primary },
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
      <GestureHandlerRootView style={styles.flex}>
        <SafeAreaProvider>
          <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
          <ConnectScreen />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  const screenOptions = {
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: '600' as const },
    drawerType: 'front' as const,
    drawerStyle: {
      backgroundColor: colors.background,
      width: 280,
    },
    swipeEnabled: true,
    swipeEdgeWidth: 40,
  };

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <NavigationContainer theme={navTheme}>
          <Drawer.Navigator
            drawerContent={(props) => <CommandCenterDrawer {...props} />}
            screenOptions={({ navigation }) => ({
              ...screenOptions,
              headerLeft: () => (
                <TouchableOpacity
                  onPress={() => navigation.openDrawer()}
                  style={styles.hamburger}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="menu" size={24} color={colors.text} />
                </TouchableOpacity>
              ),
            })}
          >
            <Drawer.Screen
              name="Chat"
              component={ChatScreen}
              options={{
                headerTitle: useAppStore.getState().workspace?.name || 'Copilot Chat',
              }}
            />
            <Drawer.Screen name="Files" component={FilesScreen} />
            <Drawer.Screen name="Terminal" component={TerminalScreen} />
            <Drawer.Screen name="Commands" component={QuickCommandsScreen} options={{ headerTitle: 'Quick Commands' }} />
            <Drawer.Screen name="Diagnostics" component={DiagnosticsScreen} />
            <Drawer.Screen name="Changes" component={ChangesScreen} />
            <Drawer.Screen name="Settings" component={SettingsScreen} />
          </Drawer.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  hamburger: {
    marginLeft: 16,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
