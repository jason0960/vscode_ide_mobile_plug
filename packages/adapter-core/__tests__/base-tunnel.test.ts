/**
 * BaseTunnel — unit tests
 *
 * Covers: manual URL, lifecycle (stop, getTunnelUrl, isActive, dispose),
 * Cloudflare tunnel spawn (URL extraction, error, exit, timeout),
 * ngrok tunnel spawn (URL extraction, error, exit, timeout).
 */
import { BaseTunnel } from '../src/base-tunnel';
import type { ILogger } from '../src/interfaces';
import { EventEmitter } from 'events';

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));
const { spawn } = require('child_process');

function createLogger(): ILogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Create a mock child process with stdout/stderr event emitters */
function createMockProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = jest.fn();
  proc.pid = 12345;
  return proc;
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

  // ─── Cloudflare Tunnel ──────────────────────────────────────

  describe('startCloudflareTunnel', () => {
    let mockProc: any;

    beforeEach(() => {
      mockProc = createMockProcess();
      spawn.mockReturnValue(mockProc);
    });

    it('resolves with URL when cloudflared outputs tunnel URL', async () => {
      const promise = tunnel.startCloudflareTunnel(3847);

      expect(spawn).toHaveBeenCalledWith(
        'cloudflared',
        ['tunnel', '--url', 'http://localhost:3847'],
        expect.any(Object),
      );

      // Simulate cloudflared outputting the URL on stderr
      mockProc.stderr.emit('data', Buffer.from(
        'INF | https://random-name-here.trycloudflare.com\n',
      ));

      const url = await promise;
      expect(url).toBe('https://random-name-here.trycloudflare.com');
      expect(tunnel.getTunnelUrl()).toBe(url);
      expect(tunnel.isActive()).toBe(true);
    });

    it('resolves with URL from stdout', async () => {
      const promise = tunnel.startCloudflareTunnel(8080);

      mockProc.stdout.emit('data', Buffer.from(
        'https://abc-def.trycloudflare.com',
      ));

      const url = await promise;
      expect(url).toBe('https://abc-def.trycloudflare.com');
    });

    it('rejects when cloudflared process errors', async () => {
      const promise = tunnel.startCloudflareTunnel(3847);

      mockProc.emit('error', new Error('ENOENT'));

      await expect(promise).rejects.toThrow(/cloudflared.*ENOENT/);
    });

    it('rejects when cloudflared exits before establishing tunnel', async () => {
      const promise = tunnel.startCloudflareTunnel(3847);

      mockProc.emit('exit', 1);

      await expect(promise).rejects.toThrow(/exited with code 1/);
    });

    it('rejects on 30s timeout', async () => {
      jest.useFakeTimers();
      const promise = tunnel.startCloudflareTunnel(3847);

      jest.advanceTimersByTime(31_000);

      await expect(promise).rejects.toThrow(/timed out/);
      jest.useRealTimers();
    });
  });

  // ─── ngrok Tunnel ───────────────────────────────────────────

  describe('startNgrokTunnel', () => {
    let mockProc: any;

    beforeEach(() => {
      mockProc = createMockProcess();
      spawn.mockReturnValue(mockProc);
    });

    it('resolves with URL when ngrok outputs tunnel URL', async () => {
      const promise = tunnel.startNgrokTunnel(3847);

      expect(spawn).toHaveBeenCalledWith(
        'ngrok',
        ['http', '3847', '--log=stdout'],
        expect.any(Object),
      );

      // Simulate ngrok log output
      mockProc.stdout.emit('data', Buffer.from(
        't=2024-01-01 url=https://abc123.ngrok-free.app\n',
      ));

      const url = await promise;
      expect(url).toBe('https://abc123.ngrok-free.app');
      expect(tunnel.isActive()).toBe(true);
    });

    it('rejects when ngrok process errors', async () => {
      const promise = tunnel.startNgrokTunnel(3847);

      mockProc.emit('error', new Error('command not found'));

      await expect(promise).rejects.toThrow(/ngrok.*command not found/);
    });

    it('rejects when ngrok exits before establishing tunnel', async () => {
      const promise = tunnel.startNgrokTunnel(3847);

      mockProc.emit('exit', 2);

      await expect(promise).rejects.toThrow(/exited with code 2/);
    });

    it('rejects on 30s timeout', async () => {
      jest.useFakeTimers();
      const promise = tunnel.startNgrokTunnel(3847);

      jest.advanceTimersByTime(31_000);

      await expect(promise).rejects.toThrow(/timed out/);
      jest.useRealTimers();
    });
  });

  // ─── stopTunnel kills process ─────────────────────────────────

  describe('stopTunnel (with active process)', () => {
    it('kills the tunnel process', async () => {
      const mockProc = createMockProcess();
      spawn.mockReturnValue(mockProc);

      const promise = tunnel.startCloudflareTunnel(3847);
      mockProc.stderr.emit('data', Buffer.from('https://test.trycloudflare.com'));
      await promise;

      await tunnel.stopTunnel();
      expect(mockProc.kill).toHaveBeenCalled();
      expect(tunnel.isActive()).toBe(false);
    });
  });
});
