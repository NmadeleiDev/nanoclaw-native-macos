import { readEnvFile } from '../env.js';
import type { DbDriver } from '../db/driver.js';

export function installationRuntime(): string {
  return (
    process.env.NANOCLAW_RUNTIME_DRIVER || readEnvFile(['NANOCLAW_RUNTIME_DRIVER']).NANOCLAW_RUNTIME_DRIVER || 'docker'
  );
}
export async function agentRuntime(db: DbDriver, agentId: string): Promise<string> {
  const row = await db.get<{ runtime_driver?: string | null }>(
    'SELECT * FROM container_configs WHERE agent_group_id=?',
    agentId,
  );
  return row?.runtime_driver || installationRuntime();
}
export function validateRuntime(value: unknown): string {
  if (value !== 'docker' && value !== 'native-macos') throw new Error('Choose docker or native-macos');
  return value;
}
