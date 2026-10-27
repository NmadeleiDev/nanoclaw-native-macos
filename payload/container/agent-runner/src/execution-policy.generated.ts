/** Host-owned execution policy. Project files and model output never configure it. */
export interface ExecutionPolicy {
  version: 1;
  filesystem: {
    readDefault: 'allow' | 'deny';
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    mode?: 'restricted' | 'open';
    allow: string[];
    deny: string[];
    unknown: 'ask' | 'deny';
    localConnectPorts: number[];
    listenPorts: number[];
  };
  tools: { default: 'allow' | 'deny'; allow: string[]; deny: string[] };
  docker: { unrestricted: boolean };
  browser: { hostChrome: boolean };
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  version: 1,
  filesystem: { readDefault: 'allow', allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
  network: { allow: [], deny: [], unknown: 'ask', localConnectPorts: [], listenPorts: [] },
  tools: { default: 'allow', allow: [], deny: [] },
  docker: { unrestricted: false },
  browser: { hostChrome: false },
};

function record(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, name: string, check: (v: string) => boolean): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((v) => typeof v !== 'string' || !v || v.length > 4096 || /[\0\r\n]/.test(v) || !check(v))
  )
    throw new Error(`Invalid ${name}`);
  return [...new Set(value)];
}
function ports(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535))
    throw new Error('Ports must be integers between 1024 and 65535');
  return [...new Set(value)];
}

/** Complete documents, strict keys, bounded lists: typos must never remove a restriction. */
export function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  const p = record(value, ['version', 'filesystem', 'network', 'tools', 'docker', 'browser'], 'policy');
  if (p.version !== 1) throw new Error('Unsupported execution policy version');
  const f = record(p.filesystem, ['readDefault', 'allowRead', 'denyRead', 'allowWrite', 'denyWrite'], 'filesystem');
  const n = record(p.network, ['mode', 'allow', 'deny', 'unknown', 'localConnectPorts', 'listenPorts'], 'network');
  if (n.mode !== undefined && !['restricted', 'open'].includes(n.mode as string))
    throw new Error('Invalid network mode');
  if (n.mode === 'open' && (n.deny as unknown[])?.length)
    throw new Error('Open outbound access cannot enforce destination denies; choose restricted mode');
  const t = record(p.tools, ['default', 'allow', 'deny'], 'tools');
  const b = p.browser === undefined ? { hostChrome: false } : record(p.browser, ['hostChrome'], 'browser');
  if (typeof b.hostChrome !== 'boolean') throw new Error('Invalid browser exception');
  const d = record(p.docker, ['unrestricted'], 'docker');
  if (
    !['allow', 'deny'].includes(f.readDefault as string) ||
    !['allow', 'deny'].includes(t.default as string) ||
    !['ask', 'deny'].includes(n.unknown as string) ||
    typeof d.unrestricted !== 'boolean'
  )
    throw new Error('Invalid execution policy default');
  const paths = (v: unknown) =>
    strings(v, 'filesystem paths', (s) => s.startsWith('/') && !s.split('/').includes('..'));
  const domains = (v: unknown) =>
    strings(
      v,
      'network destinations',
      (s) =>
        /^(?:\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?$/.test(s) &&
        (!s.includes(':') || (+s.split(':')[1] > 0 && +s.split(':')[1] <= 65535)),
    );
  const tools = (v: unknown) => strings(v, 'tools', (s) => /^[a-zA-Z0-9_.*:-]+$/.test(s));
  return {
    version: 1,
    filesystem: {
      readDefault: f.readDefault as 'allow' | 'deny',
      allowRead: paths(f.allowRead),
      denyRead: paths(f.denyRead),
      allowWrite: paths(f.allowWrite),
      denyWrite: paths(f.denyWrite),
    },
    network: {
      ...(n.mode === 'open' ? { mode: 'open' as const } : {}),
      allow: domains(n.allow),
      deny: domains(n.deny),
      unknown: n.unknown as 'ask' | 'deny',
      localConnectPorts: ports(n.localConnectPorts),
      listenPorts: ports(n.listenPorts),
    },
    tools: { default: t.default as 'allow' | 'deny', allow: tools(t.allow), deny: tools(t.deny) },
    docker: { unrestricted: d.unrestricted },
    browser: { hostChrome: b.hostChrome },
  };
}

export function patternMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(value);
}
export function toolAllowed(policy: ExecutionPolicy, name: string): boolean {
  if (policy.tools.deny.some((p) => patternMatches(p, name))) return false;
  return policy.tools.default === 'allow' || policy.tools.allow.some((p) => patternMatches(p, name));
}
export function destinationMatches(pattern: string, host: string, port: number): boolean {
  const [domain, selectedPort] = pattern.toLowerCase().split(':');
  if (selectedPort && +selectedPort !== port) return false;
  host = host.toLowerCase().replace(/\.$/, '');
  return domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host !== domain.slice(2) : domain === host;
}
export function networkDecision(policy: ExecutionPolicy, host: string, port: number): 'allow' | 'deny' | 'ask' {
  if (policy.network.mode === 'open') return 'allow';
  if (policy.network.deny.some((p) => destinationMatches(p, host, port))) return 'deny';
  if (policy.network.allow.some((p) => destinationMatches(p, host, port))) return 'allow';
  return policy.network.unknown;
}

/** Operator-authored session rules can add grants, but never erase parent denies. */
export function resolveExecutionPolicy(policies: ExecutionPolicy[]): ExecutionPolicy {
  const out = structuredClone(DEFAULT_EXECUTION_POLICY);
  for (const p of policies) {
    if (p.filesystem.readDefault === 'deny') out.filesystem.readDefault = 'deny';
    for (const key of ['allowRead', 'denyRead', 'allowWrite', 'denyWrite'] as const)
      out.filesystem[key].push(...p.filesystem[key]);
    for (const key of ['allow', 'deny', 'localConnectPorts', 'listenPorts'] as const)
      (out.network[key] as (string | number)[]).push(...p.network[key]);
    if (p.network.mode === 'open') out.network.mode = 'open';
    if (p.network.unknown === 'deny') out.network.unknown = 'deny';
    if (p.tools.default === 'deny') out.tools.default = 'deny';
    out.tools.allow.push(...p.tools.allow);
    out.tools.deny.push(...p.tools.deny);
    out.docker.unrestricted ||= p.docker.unrestricted;
    out.browser.hostChrome ||= p.browser.hostChrome;
  }
  return parseExecutionPolicy(out);
}
