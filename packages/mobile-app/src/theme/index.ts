/**
 * Theme constants for Mobile Copilot.
 * Developer-focused dark/light themes inspired by VS Code.
 * OLED dark mode with Inter-style typography scale.
 */

export const Colors: { dark: ThemeColors; light: ThemeColors } = {
  dark: {
    background: '#0d1117',
    surface: '#161b22',
    surfaceAlt: '#1c2128',
    border: '#30363d',
    text: '#e6edf3',
    textSecondary: '#8b949e',
    textMuted: '#6e7681',
    primary: '#2563eb',
    primaryLight: '#3b82f6',
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    info: '#58a6ff',
    accent: '#bc8cff',
    // Chat
    userBubble: '#1a2332',
    assistantBubble: '#161b22',
    // Diff
    diffAdded: '#23863633',
    diffAddedText: '#3fb950',
    diffRemoved: '#f8514933',
    diffRemovedText: '#f85149',
    diffHunk: '#58a6ff33',
    // Code
    codeBg: '#0d1117',
    codeText: '#e6edf3',
    // Status
    online: '#3fb950',
    offline: '#f85149',
    connecting: '#d29922',
    // Navigation
    tabBar: '#0d1117',
    tabInactive: '#6e7681',
    tabActive: '#58a6ff',
  },
  light: {
    background: '#ffffff',
    surface: '#f6f8fa',
    surfaceAlt: '#eaeef2',
    border: '#d0d7de',
    text: '#1f2328',
    textSecondary: '#656d76',
    textMuted: '#8c959f',
    primary: '#2563eb',
    primaryLight: '#3b82f6',
    success: '#1a7f37',
    warning: '#9a6700',
    error: '#cf222e',
    info: '#0969da',
    accent: '#8250df',
    userBubble: '#dbeafe',
    assistantBubble: '#f6f8fa',
    diffAdded: '#1a7f3733',
    diffAddedText: '#1a7f37',
    diffRemoved: '#cf222e33',
    diffRemovedText: '#cf222e',
    diffHunk: '#0969da33',
    codeBg: '#f6f8fa',
    codeText: '#1f2328',
    online: '#1a7f37',
    offline: '#cf222e',
    connecting: '#9a6700',
    tabBar: '#ffffff',
    tabInactive: '#8c959f',
    tabActive: '#2563eb',
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
  xl: 24,
  xxl: 32,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  code: 14,
} as const;

export const BorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;
