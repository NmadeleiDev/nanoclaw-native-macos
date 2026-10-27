import type { ExecutionPolicy } from './policy.js';

export interface NativeProcessSpec {
  command: string[];
  executionRevision?: string;
  /** Host-selected public trust/stub files, initialized under the same sandbox. */
  initialFiles?: Array<{ source: string; target: string }>;
  cwd: string;
  env: Record<string, string>;
  policy: ExecutionPolicy;
  /** OS grants assembled by the host, never supplied by the agent. */
  readRoots: string[];
  writeRoots: string[];
  denyRead: string[];
  denyWrite: string[];
  internalPorts: number[];
  internalConnectPorts?: number[];
  unixSockets: string[];
  /** Upstream credential proxy. It is never exposed as a bypass to the child. */
  parentProxy: { http: string; https: string };
  stateDirectory: string;
}

export type NativeSupervisorMessage =
  | { type: 'ready' }
  | { type: 'failure'; message: string }
  | { type: 'network'; id: string; host: string; port: number };
