/**
 * Lightweight syntax highlighter for code display in React Native.
 * Applies token-level coloring for common languages.
 * No web dependencies — works natively on iOS/Android/Web.
 */

import React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';
import { FontSize } from '../theme';

export interface SyntaxTheme {
  text: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  type: string;
  operator: string;
  lineNumber: string;
  lineNumberBg: string;
}

export const DARK_SYNTAX: SyntaxTheme = {
  text: '#e6edf3',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  comment: '#8b949e',
  number: '#79c0ff',
  function: '#d2a8ff',
  type: '#7ee787',
  operator: '#ff7b72',
  lineNumber: '#6e7681',
  lineNumberBg: '#0d1117',
};

export const LIGHT_SYNTAX: SyntaxTheme = {
  text: '#1f2328',
  keyword: '#cf222e',
  string: '#0a3069',
  comment: '#6e7781',
  number: '#0550ae',
  function: '#8250df',
  type: '#116329',
  operator: '#cf222e',
  lineNumber: '#8c959f',
  lineNumberBg: '#f6f8fa',
};

// ─── Language Token Rules ───────────────────────────────

type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type' | 'operator' | 'text';

interface Token {
  type: TokenType;
  value: string;
}

// Keywords for common languages
const KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'this', 'class', 'extends', 'super',
  'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'in', 'of', 'yield', 'void', 'delete',
  'interface', 'type', 'enum', 'implements', 'abstract', 'declare', 'namespace',
  'readonly', 'as', 'is', 'keyof', 'infer',
  // Python
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from',
  'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'lambda', 'yield',
  'global', 'nonlocal', 'assert', 'del', 'not', 'and', 'or', 'in', 'is', 'None',
  'True', 'False', 'self', 'cls',
  // Shared
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'public', 'private', 'protected', 'static', 'final',
]);

const TYPES = new Set([
  'string', 'number', 'boolean', 'object', 'any', 'void', 'never', 'unknown',
  'int', 'float', 'double', 'char', 'bool', 'long', 'short', 'byte',
  'String', 'Number', 'Boolean', 'Array', 'Map', 'Set', 'Promise', 'Record',
  'React', 'Props', 'State', 'Component', 'FC',
]);

/** Very fast single-line tokenizer. Does not handle multi-line comments. */
function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    // Skip whitespace — emit as text
    if (line[i] === ' ' || line[i] === '\t') {
      let ws = '';
      while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
        ws += line[i++];
      }
      tokens.push({ type: 'text', value: ws });
      continue;
    }

    // Single-line comment: // or #
    if ((line[i] === '/' && line[i + 1] === '/') || (line[i] === '#' && (i === 0 || line[i - 1] === ' '))) {
      tokens.push({ type: 'comment', value: line.slice(i) });
      break;
    }

    // Block comment start /*  (treat rest of line as comment)
    if (line[i] === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'comment', value: line.slice(i, end + 2) });
        i = end + 2;
      } else {
        tokens.push({ type: 'comment', value: line.slice(i) });
        break;
      }
      continue;
    }

    // String (single, double, backtick)
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let str = quote;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\') { str += line[i++]; }
        if (i < line.length) str += line[i++];
      }
      if (i < line.length) str += line[i++]; // closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Number
    if (/[0-9]/.test(line[i]) && (i === 0 || /[\s(=,\[{:+\-*/<>!&|]/.test(line[i - 1]))) {
      let num = '';
      while (i < line.length && /[0-9.xXa-fA-FeEbBoO_]/.test(line[i])) {
        num += line[i++];
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }

    // Word (identifier, keyword, type)
    if (/[a-zA-Z_$]/.test(line[i])) {
      let word = '';
      while (i < line.length && /[a-zA-Z0-9_$]/.test(line[i])) {
        word += line[i++];
      }
      // Check if followed by ( => function call
      if (line[i] === '(') {
        tokens.push({ type: 'function', value: word });
      } else if (KEYWORDS.has(word)) {
        tokens.push({ type: 'keyword', value: word });
      } else if (TYPES.has(word)) {
        tokens.push({ type: 'type', value: word });
      } else {
        tokens.push({ type: 'text', value: word });
      }
      continue;
    }

    // Operator
    if (/[=+\-*/<>!&|^~%?:]/.test(line[i])) {
      let op = line[i++];
      // Consume 2-3 char operators
      while (i < line.length && /[=+\-*/<>!&|^~%?:]/.test(line[i]) && op.length < 3) {
        op += line[i++];
      }
      tokens.push({ type: 'operator', value: op });
      continue;
    }

    // Everything else — punctuation, brackets, etc.
    tokens.push({ type: 'text', value: line[i++] });
  }

  return tokens;
}

// ─── Component ──────────────────────────────────────────

interface SyntaxHighlighterProps {
  code: string;
  theme: SyntaxTheme;
  showLineNumbers?: boolean;
  maxLines?: number;
}

export function SyntaxHighlighter({ code, theme, showLineNumbers = true, maxLines }: SyntaxHighlighterProps) {
  let lines = code.split('\n');
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines.push(`... (${code.split('\n').length - maxLines} more lines)`);
  }

  const gutterWidth = showLineNumbers ? Math.max(String(lines.length).length * 9 + 12, 36) : 0;

  return (
    <View style={styles.container}>
      {lines.map((line, i) => {
        const tokens = tokenizeLine(line);
        const lineNum = i + 1;

        return (
          <View key={i} style={styles.line}>
            {showLineNumbers && (
              <View style={[styles.lineNumberCol, { width: gutterWidth, backgroundColor: theme.lineNumberBg }]}>
                <Text style={[styles.lineNumber, { color: theme.lineNumber }]}>{lineNum}</Text>
              </View>
            )}
            <Text style={styles.lineContent} selectable>
              {tokens.length === 0 ? (
                <Text style={{ color: theme.text }}>{' '}</Text>
              ) : (
                tokens.map((token, j) => (
                  <Text key={j} style={{ color: theme[token.type] || theme.text }}>
                    {token.value}
                  </Text>
                ))
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: '100%',
  },
  line: {
    flexDirection: 'row',
    minHeight: 20,
  },
  lineNumberCol: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 8,
    paddingLeft: 4,
  },
  lineNumber: {
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
  },
  lineContent: {
    flex: 1,
    fontSize: FontSize.code,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    paddingLeft: 8,
  },
});
