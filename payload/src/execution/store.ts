import type { DbDriver } from '../db/driver.js';
import {
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicy,
  resolveExecutionPolicy,
  type ExecutionPolicy,
} from './policy.js';

export type PolicyScope = 'install' | 'agent' | 'project' | 'session';
export interface PolicyDocument {
  revision: number;
  policy: ExecutionPolicy;
}

let projectPolicy: ((sessionId: string) => Promise<{ id: string; revision: number; policy: ExecutionPolicy } | undefined>) | undefined;
export function registerProjectExecutionResolver(resolver: NonNullable<typeof projectPolicy>) { projectPolicy = resolver; }

export class ExecutionStore {
  constructor(readonly db: DbDriver) {}
  async get(scope: PolicyScope, id: string): Promise<PolicyDocument> {
    const row = await this.db.get<{ revision: number; document: string }>(
      'SELECT revision,document FROM execution_policies WHERE scope=? AND scope_id=?',
      scope,
      id,
    );
    return row
      ? { revision: row.revision, policy: parseExecutionPolicy(JSON.parse(row.document)) }
      : { revision: 0, policy: structuredClone(DEFAULT_EXECUTION_POLICY) };
  }
  async put(scope: PolicyScope, id: string, policy: unknown, revision: number): Promise<PolicyDocument> {
    const parsed = parseExecutionPolicy(policy);
    if (scope !== 'agent' && (parsed.browser.hostChrome || parsed.docker.unrestricted)) throw new Error('Host Chrome can only be granted on the agent');
    if (!Number.isInteger(revision) || revision < 0) throw new Error('A policy revision is required');
    await this.db.transaction(async () => {
      const old = await this.get(scope, id);
      if (old.revision !== revision) throw new Error('Execution policy changed; reload before saving');
      await this.db.run(
        `INSERT INTO execution_policies(scope,scope_id,revision,document,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(scope,scope_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,updated_at=excluded.updated_at`,
        scope,
        id,
        revision + 1,
        JSON.stringify(parsed),
        new Date().toISOString(),
      );
    });
    return { revision: revision + 1, policy: parsed };
  }
  async effective(agentId: string, sessionId?: string) {
    const sources = [
      { scope: 'install' as const, id: 'default' },
      { scope: 'agent' as const, id: agentId },
      ...(sessionId ? [{ scope: 'session' as const, id: sessionId }] : []),
    ];
    const documents = [];
    for (const source of sources) documents.push({ ...source, ...(await this.get(source.scope, source.id)) });
    const project = sessionId ? await projectPolicy?.(sessionId) : undefined;
    const all = project ? [...documents.filter(d => d.scope !== 'session'), { scope: 'project' as const, ...project }, ...documents.filter(d => d.scope === 'session')] : documents;
    return { policy: resolveExecutionPolicy(all.map((d) => d.policy)), sources: all };
  }
}
