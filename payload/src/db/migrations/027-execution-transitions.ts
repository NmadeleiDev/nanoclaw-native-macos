import type { Migration } from './index.js';
export const migration027: Migration = {
  version: 27, name: 'execution-transitions',
  async up(db) {
    await db.exec(`CREATE TABLE execution_transitions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, state TEXT NOT NULL, context TEXT NOT NULL,
      error TEXT, updated_at TEXT NOT NULL
    )`);
  },
};
