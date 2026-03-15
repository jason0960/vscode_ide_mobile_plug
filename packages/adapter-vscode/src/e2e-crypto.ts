/**
 * End-to-end encryption for relay communication.
 *
 * Uses tweetnacl's box (X25519 ECDH + XSalsa20-Poly1305 AEAD).
 * The relay server sees only opaque ciphertext — it cannot read messages.
 *
 * Flow:
 *   1. Mobile sends  { type: 'e2e.keyExchange', pubkey: base64 }
 *   2. Host responds  { type: 'e2e.keyExchange', pubkey: base64 }
 *   3. Both derive shared key — all subsequent messages are:
 *      { type: 'e2e.encrypted', n: base64Nonce, c: base64Ciphertext }
 */
import nacl from 'tweetnacl';

// ── Base64 ↔ Uint8Array helpers (Node 16+ and Hermes compatible) ──

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ── Encrypted envelope type ──

export interface E2EEnvelope {
  type: 'e2e.encrypted';
  n: string;   // base64 nonce (24 bytes)
  c: string;   // base64 ciphertext
}

export interface E2EKeyExchange {
  type: 'e2e.keyExchange';
  pubkey: string;  // base64 public key (32 bytes)
}

// ── E2ECrypto class ──

export class E2ECrypto {
  private keyPair: nacl.BoxKeyPair | null = null;
  private sharedKey: Uint8Array | null = null;

  /** Whether the shared key has been derived and we can encrypt/decrypt. */
  get isReady(): boolean {
    return this.sharedKey !== null;
  }

  /**
   * Generate a new X25519 key pair. Returns the public key as base64.
   * Must be called before deriveSharedKey().
   */
  generateKeyPair(): string {
    this.sharedKey = null;                 // reset any prior shared key
    this.keyPair = nacl.box.keyPair();
    return uint8ToBase64(this.keyPair.publicKey);
  }

  /**
   * Derive the shared key from the peer's public key using X25519 ECDH.
   * After this call, isReady === true and encrypt/decrypt are available.
   */
  deriveSharedKey(peerPublicKeyBase64: string): void {
    if (!this.keyPair) {
      throw new Error('E2E: must call generateKeyPair() first');
    }
    const peerPub = base64ToUint8(peerPublicKeyBase64);
    this.sharedKey = nacl.box.before(peerPub, this.keyPair.secretKey);
  }

  /**
   * Encrypt a plaintext string into a JSON envelope string.
   * Returns the stringified { type, n, c } ready for WebSocket.send().
   */
  encrypt(plaintext: string): string {
    if (!this.sharedKey) {
      throw new Error('E2E: shared key not derived');
    }
    const nonce = nacl.randomBytes(nacl.box.nonceLength);       // 24 random bytes
    const message = Buffer.from(plaintext, 'utf-8');
    const ciphertext = nacl.box.after(new Uint8Array(message), nonce, this.sharedKey);
    const envelope: E2EEnvelope = {
      type: 'e2e.encrypted',
      n: uint8ToBase64(nonce),
      c: uint8ToBase64(ciphertext),
    };
    return JSON.stringify(envelope);
  }

  /**
   * Decrypt an encrypted envelope back to the original plaintext string.
   * Throws if the ciphertext has been tampered with or the key is wrong.
   */
  decrypt(envelope: { n: string; c: string }): string {
    if (!this.sharedKey) {
      throw new Error('E2E: shared key not derived');
    }
    const nonce = base64ToUint8(envelope.n);
    const ciphertext = base64ToUint8(envelope.c);
    const decrypted = nacl.box.open.after(ciphertext, nonce, this.sharedKey);
    if (!decrypted) {
      throw new Error('E2E: decryption failed — message tampered or wrong key');
    }
    return Buffer.from(decrypted).toString('utf-8');
  }

  /** Reset state (e.g. on disconnect). */
  reset(): void {
    this.keyPair = null;
    this.sharedKey = null;
  }
}
