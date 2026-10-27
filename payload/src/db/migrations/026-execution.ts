import type { Migration } from './index.js';
import { readEnvFile } from '../../env.js';

export const migration026: Migration = {
  version: 26,
  name: 'execution-policies',
  async up(db) {
    await db.exec(`
      ALTER TABLE container_configs ADD COLUMN runtime_driver TEXT;
      ALTER TABLE sessions ADD COLUMN runtime_driver TEXT;
      CREATE TABLE execution_policies (
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL,
        document TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (scope,scope_id)
      );
      CREATE TABLE execution_grants (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        destination TEXT NOT NULL, scope TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const driver =
      process.env.NANOCLAW_RUNTIME_DRIVER ||
      readEnvFile(['NANOCLAW_RUNTIME_DRIVER']).NANOCLAW_RUNTIME_DRIVER ||
      'docker';
    await db.run('UPDATE sessions SET runtime_driver=? WHERE runtime_driver IS NULL', driver);
  },
};
