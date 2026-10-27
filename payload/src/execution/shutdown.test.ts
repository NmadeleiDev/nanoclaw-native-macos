import { expect, it, vi } from 'vitest';
import { drainNativeSession, revokesNativeAccess } from './shutdown.js';

it.each([false, true])('closes networking at the right boundary (revocation=%s)', async (revoke) => {
  const events: string[] = [];
  let closed = false;
  await drainNativeSession({
    revoke,
    stopProcesses: async () => {
      expect(closed).toBe(revoke);
      events.push('stop');
    },
    closeNetwork: async () => {
      if (!closed) events.push('close');
      closed = true;
    },
    terminateRunner: () => {
      expect(revoke).toBe(true);
    },
    reportFailure: () => {
      throw new Error('Unexpected failure');
    },
  });
  expect(events).toEqual(revoke ? ['close', 'stop'] : ['stop', 'close']);
});
it('quarantines failed cleanup and stays pending until ownership can be verified', async () => {
  let release!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  let attempts = 0,
    finished = false;
  const result = drainNativeSession({
    revoke: false,
    stopProcesses: async () => {
      events.push('stop');
      if (++attempts === 1) throw new Error('ps failed');
    },
    closeNetwork: async () => {
      events.push('close');
    },
    terminateRunner: () => {
      events.push('kill-runner');
    },
    reportFailure: () => {
      events.push('report');
    },
    retryDelay: () => delay,
  }).then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(events).toEqual(['stop', 'report', 'kill-runner', 'close']));
  expect(finished).toBe(false);
  release();
  await result;
  expect(events.slice(-2)).toEqual(['stop', 'close']);
});
it('marks permission and gateway loss as immediate revocations', () => {
  for (const reason of ['execution-policy-changed', 'gateway-unavailable', 'gateway-adoption-failed'])
    expect(revokesNativeAccess(reason)).toBe(true);
  for (const reason of ['runtime-ended', 'shutdown', 'workspace-session-settings', 'absolute-ceiling'])
    expect(revokesNativeAccess(reason)).toBe(false);
});
