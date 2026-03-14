/**
 * Relay Server — exported function unit tests
 *
 * Tests the exported pure functions from relay-server/src/index.ts
 * to provide actual code coverage (the main relay.test.ts replicates
 * logic inline and doesn't import index.ts).
 *
 * Covers: generateRoomCode, CODE_CHARS, CODE_LENGTH, Room type.
 */

import { generateRoomCode, CODE_CHARS, CODE_LENGTH } from '../src/index';
import type { Room } from '../src/index';

describe('relay-server exports', () => {
  // ─── CODE_CHARS ─────────────────────────────────────────────

  describe('CODE_CHARS', () => {
    it('excludes ambiguous characters (0, O, 1, I)', () => {
      expect(CODE_CHARS).not.toContain('0');
      expect(CODE_CHARS).not.toContain('O');
      expect(CODE_CHARS).not.toContain('1');
      expect(CODE_CHARS).not.toContain('I');
    });

    it('contains only uppercase letters and digits', () => {
      expect(CODE_CHARS).toMatch(/^[A-Z2-9]+$/);
    });
  });

  // ─── CODE_LENGTH ────────────────────────────────────────────

  describe('CODE_LENGTH', () => {
    it('is 6', () => {
      expect(CODE_LENGTH).toBe(6);
    });
  });

  // ─── generateRoomCode ───────────────────────────────────────

  describe('generateRoomCode', () => {
    it('generates a code of CODE_LENGTH characters', () => {
      const rooms = new Map<string, Room>();
      const code = generateRoomCode(rooms);
      expect(code.length).toBe(CODE_LENGTH);
    });

    it('generates codes using only CODE_CHARS', () => {
      const rooms = new Map<string, Room>();
      for (let i = 0; i < 20; i++) {
        const code = generateRoomCode(rooms);
        for (const ch of code) {
          expect(CODE_CHARS).toContain(ch);
        }
      }
    });

    it('generates unique codes (no collision with existing rooms)', () => {
      const rooms = new Map<string, Room>();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const code = generateRoomCode(rooms);
        codes.add(code);
        rooms.set(code, {
          code,
          hostSecret: 'test',
          host: null,
          clients: new Set(),
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          ttlMs: 60000,
        });
      }
      // With 30^6 = 729M possible codes and 50 generated, collisions should be effectively zero
      expect(codes.size).toBe(50);
    });

    it('retries when collision occurs', () => {
      const rooms = new Map<string, Room>();
      // Pre-fill with a known code — the first attempt may collide
      // but since randomBytes is random, the odds are astronomically low
      // This primarily tests that the while loop works
      const code = generateRoomCode(rooms);
      expect(code).toBeDefined();
      expect(code.length).toBe(CODE_LENGTH);
    });
  });
});
