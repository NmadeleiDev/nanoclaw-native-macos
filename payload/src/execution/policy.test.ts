import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicy,
  resolveExecutionPolicy,
  toolAllowed,
  networkDecision,
} from './policy.js';

describe('execution policy', () => {
  it('defaults to broad reads, scoped writes, and network approval', () => {
    const p = parseExecutionPolicy(DEFAULT_EXECUTION_POLICY);
    expect(p.filesystem).toMatchObject({ readDefault: 'allow', allowWrite: [] });
    expect(networkDecision(p, 'example.com', 443)).toBe('ask');
  });
  it('rejects misspelled settings instead of dropping security rules', () => {
    expect(() =>
      parseExecutionPolicy({
        ...DEFAULT_EXECUTION_POLICY,
        filesystem: { ...DEFAULT_EXECUTION_POLICY.filesystem, denyReads: ['/secret'] },
      }),
    ).toThrow('Unknown');
    expect(() =>
      parseExecutionPolicy({
        ...DEFAULT_EXECUTION_POLICY,
        network: { ...DEFAULT_EXECUTION_POLICY.network, listenPorts: [0] },
      }),
    ).toThrow('Ports');
  });
  it('preserves parent denies against operator-authored session grants', () => {
    const parent = structuredClone(DEFAULT_EXECUTION_POLICY),
      session = structuredClone(parent);
    parent.tools.deny = ['mcp:private:*'];
    parent.network.deny = ['*.example.com'];
    session.tools.allow = ['mcp:private:run'];
    session.network.allow = ['api.example.com:443'];
    const p = resolveExecutionPolicy([parent, session]);
    expect(toolAllowed(p, 'mcp:private:run')).toBe(false);
    expect(networkDecision(p, 'api.example.com', 443)).toBe('deny');
  });
  it('does not confuse domains, suffixes, or ports', () => {
    const p = structuredClone(DEFAULT_EXECUTION_POLICY);
    p.network.allow = ['*.example.com:443'];
    expect(networkDecision(p, 'api.example.com', 443)).toBe('allow');
    for (const [host, port] of [
      ['example.com', 443],
      ['evilexample.com', 443],
      ['api.example.com.evil.test', 443],
      ['api.example.com', 80],
    ] as const)
      expect(networkDecision(p, host, port)).toBe('ask');
  });
});

it('keeps host and Bun policy contracts identical and native OpenCode on its SDK pin', () => {
  expect(fs.readFileSync('container/agent-runner/src/execution-policy.generated.ts', 'utf8')).toBe(
    fs.readFileSync('src/execution/policy.ts', 'utf8'),
  );
  const host = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const runner = JSON.parse(fs.readFileSync('container/agent-runner/package.json', 'utf8'));
  if (!runner.dependencies['@opencode-ai/sdk']) return; // Optional provider is not installed.
  for (const architecture of ['arm64', 'x64'])
    expect(host.optionalDependencies['opencode-darwin-' + architecture]).toBe(runner.dependencies['@opencode-ai/sdk']);
});

it('rejects SRT TLS interception and retains the patched port schema', async () => {
  const { NetworkConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
  expect(NetworkConfigSchema.safeParse({ allowedDomains: [], deniedDomains: [], tlsTerminate: {} }).success).toBe(
    false,
  );
  expect(
    NetworkConfigSchema.parse({
      allowedDomains: [],
      deniedDomains: [],
      localConnectPorts: [12345],
      listenPorts: [12346],
    }),
  ).toMatchObject({ localConnectPorts: [12345], listenPorts: [12346] });
});

it('makes open outbound explicit and rejects unenforceable destination denies', () => {
  const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
  policy.network.mode = 'open';
  expect(networkDecision(parseExecutionPolicy(policy), 'arbitrary.example', 443)).toBe('allow');
  policy.network.deny = ['blocked.example'];
  expect(() => parseExecutionPolicy(policy)).toThrow('cannot enforce destination denies');
});
