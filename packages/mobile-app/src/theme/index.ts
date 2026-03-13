/**
 * Theme constants for Mobile Copilot.
 * Mirrors the PWA dark/light themes.
 */

export const Colors: { dark: ThemeColors; light: ThemeColors } = {
  dark: {
    background: '#1e1e1e',
    surface: '#252526',
    surfaceAlt: '#2d2d2d',
    border: '#3e3e42',
    text: '#cccccc',
    textSecondary: '#858585',
    textMuted: '#6a6a6a',
    primary: '#0078d4',
    primaryLight: '#1a8fff',
    success: '#4ec9b0',
    warning: '#dcdcaa',
    error: '#f14c4c',
    info: '#9cdcfe',
    accent: '#c586c0',
    // Chat
    userBubble: '#264f78',
    assistantBubble: '#2d2d2d',
    // Diff
    diffAdded: '#2ea04333',
    diffAddedText: '#4ec9b0',
    diffRemoved: '#f14c4c33',
    diffRemovedText: '#f14c4c',
    diffHunk: '#9cdcfe44',
    // Code
    codeBg: '#1a1a1a',
    codeText: '#d4d4d4',
    // Status
    online: '#4ec9b0',
    offline: '#f14c4c',
    connecting: '#dcdcaa',
    // Navigation
    tabBar: '#252526',
    tabInactive: '#858585',
    tabActive: '#0078d4',
  },
  light: {
    background: '#ffffff',
    surface: '#f3f3f3',
    surfaceAlt: '#e8e8e8',
    border: '#d4d4d4',
    text: '#1e1e1e',
    textSecondary: '#6a6a6a',
    textMuted: '#999999',
    primary: '#0078d4',
    primaryLight: '#1a8fff',
    success: '#16825d',
    warning: '#b89500',
    error: '#cd3131',
    info: '#0451a5',
    accent: '#af00db',
    userBubble: '#d0e8ff',
    assistantBubble: '#f3f3f3',
    diffAdded: '#2ea04333',
    diffAddedText: '#16825d',
    diffRemoved: '#cd313133',
    diffRemovedText: '#cd3131',
    diffHunk: '#0451a544',
    codeBg: '#f5f5f5',
    codeText: '#1e1e1e',
    online: '#16825d',
    offline: '#cd3131',
    connecting: '#b89500',
    tabBar: '#f3f3f3',
    tabInactive: '#999999',
    tabActive: '#0078d4',
  },
} as const;

export type ThemeMode = 'dark' | 'light';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryLight: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  accent: string;
  userBubble: string;
  assistantBubble: string;
  diffAdded: string;
  diffAddedText: string;
  diffRemoved: string;
  diffRemovedText: string;
  diffHunk: string;
  codeBg: string;
  codeText: string;
  online: string;
  offline: string;
  connecting: string;
  tabBar: string;
  tabInactive: string;
  tabActive: string;
}

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  code: 13,
} as const;

export const BorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;
