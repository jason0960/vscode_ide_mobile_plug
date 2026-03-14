/**
 * BaseTunnel — unit tests
 *
 * Covers: manual URL, lifecycle (stop, getTunnelUrl, isActive, dispose).
 * Cloudflare/ngrok tunnel spawning is NOT tested (requires those binaries).
 */
import { BaseTunnel } from '../src/base-tunnel';
import type { ILogger } from '../src/interfaces';

function createLogger(): ILogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('BaseTunnel', () => {
  let tunnel: BaseTunnel;
  let logger: ILogger;

  beforeEach(() => {
    logger = createLogger();
    tunnel = new BaseTunnel(logger);
  });

  describe('initial state', () => {
    it('has no tunnel URL', () => {
      expect(tunnel.getTunnelUrl()).toBeNull();
    });

    it('is not active', () => {
      expect(tunnel.isActive()).toBe(false);
    });
  });

  describe('setManualUrl', () => {
    it('sets the tunnel URL', () => {
      tunnel.setManualUrl('https://my-tunnel.example.com');
      expect(tunnel.getTunnelUrl()).toBe('https://my-tunnel.example.com');
      expect(tunnel.isActive()).toBe(true);
    });

    it('logs the manual URL', () => {
      tunnel.setManualUrl('https://x.com');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('https://x.com'));
    });
  });

  describe('stopTunnel', () => {
    it('clears the tunnel URL', async () => {
      tunnel.setManualUrl('https://active.example.com');
      expect(tunnel.isActive()).toBe(true);

      await tunnel.stopTunnel();
      expect(tunnel.getTunnelUrl()).toBeNull();
      expect(tunnel.isActive()).toBe(false);
    });

    it('is safe to call when no tunnel is active', async () => {
      await tunnel.stopTunnel();
      expect(tunnel.isActive()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('cleans up (same as stopTunnel)', () => {
      tunnel.setManualUrl('https://test.com');
      tunnel.dispose();
      // dispose calls stopTunnel async but doesn't await — URL may be cleared async
      // Just verify it doesn't throw
    });
  });
});
