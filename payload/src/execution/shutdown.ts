/** Keep supervision and the lease until process cleanup is proven complete. */
export async function drainNativeSession(options: {
  revoke: boolean;
  stopProcesses: () => Promise<void>;
  closeNetwork: () => Promise<void>;
  terminateRunner: () => void;
  reportFailure: (error: unknown) => void;
  retryDelay?: () => Promise<void>;
}): Promise<void> {
  if (options.revoke) {
    options.terminateRunner();
    await options.closeNetwork();
  }
  for (;;) {
    try {
      await options.stopProcesses();
      await options.closeNetwork();
      return;
    } catch (error) {
      // Cleanup is unverified: quarantine, stop the directly owned runner, and
      // retain supervision. Never signal stale PIDs from a cached process list.
      options.reportFailure(error);
      options.terminateRunner();
      await options.closeNetwork();
      await (options.retryDelay?.() ?? new Promise((resolve) => setTimeout(resolve, 1000)));
    }
  }
}

export function revokesNativeAccess(reason: string): boolean {
  return ['execution-policy-changed', 'gateway-unavailable', 'gateway-adoption-failed'].includes(reason);
}
