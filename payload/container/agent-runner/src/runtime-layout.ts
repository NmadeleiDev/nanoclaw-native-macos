import path from 'node:path';

/** Host-resolved paths. These locate runtime state; they do not grant OS access. */
export interface RuntimeLayout {
  kind: 'container' | 'native';
  instructions?: string;
  turnInstructions?: string;
  agent: string;
  session: string;
  source: string;
  config: string;
  context: string;
  additionalDirectories: string[];
  executables: Record<string, string>;
  executionPolicy?: import('./execution-policy.generated.js').ExecutionPolicy;
}
export function runtimeLayout(): RuntimeLayout {
  const raw = process.env.NANOCLAW_RUNNER_LAYOUT;
  if (!raw)
    return {
      kind: 'container',
      agent: '/workspace/agent',
      session: '/workspace',
      source: '/app/src',
      config: '/workspace/agent/container.json',
      context: '/app/.nanoclaw-session.json',
      additionalDirectories: [],
      executables: { claude: '/pnpm/claude', bun: 'bun', opencode: 'opencode' },
    };
  const value = JSON.parse(raw) as RuntimeLayout;
  if (
    value.kind !== 'native' ||
    ['agent', 'session', 'source', 'config', 'context'].some(
      (k) => !path.isAbsolute(value[k as keyof RuntimeLayout] as string),
    ) ||
    !Array.isArray(value.additionalDirectories)
  )
    throw new Error('Invalid host runtime layout');
  return value;
}

export function runtimeToolAllowed(name: string): boolean {
  const p = runtimeLayout().executionPolicy;
  if (!p) return true;
  const matches = (pattern: string) =>
    new RegExp(
      '^' +
        pattern
          .split('*')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    ).test(name);
  return !p.tools.deny.some(matches) && (p.tools.default === 'allow' || p.tools.allow.some(matches));
}

export function canonicalToolName(name: string): string {
  const match = /^mcp__([^]+?)__(.+)$/.exec(name);
  return match ? `mcp:${match[1]}:${match[2]}` : `builtin:${name}`;
}
