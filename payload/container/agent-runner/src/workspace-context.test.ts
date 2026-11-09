import { beforeEach, afterEach, it, expect } from 'bun:test';
import { initTestSessionDb, closeSessionDb } from './mailbox/sqlite/connection.js';
import {
  readWorkspaceContext,
  renderWorkspaceContext,
  emitWorkspaceEvent,
  acknowledgeWorkspaceReconfigure,
} from './workspace-context.js';
import './mailbox/compose.js';
let db: ReturnType<typeof initTestSessionDb>;
beforeEach(() => {
  db = initTestSessionDb();
  db.inbound.exec('CREATE TABLE workspace_context (id INTEGER PRIMARY KEY,value TEXT NOT NULL,control TEXT)');
  db.outbound.exec(
    'CREATE TABLE workspace_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT,kind TEXT,content TEXT)',
  );
  db.inbound
    .query('INSERT INTO workspace_context VALUES (1,?,NULL)')
    .run(
      JSON.stringify({
        title: 'One',
        projectName: 'Project',
        projectBrief: 'Build it',
        scratchpad: 'Decision B',
        scratchpadRevision: 4,
        projectScratchpad: 'Full project notes on demand',
        directories: [{ hostPath: '/repo', containerPath: '/workspace/extra/ws-repo', primary: true }],
      }),
    );
});
afterEach(closeSessionDb);
it('keeps both scratchpads available through the real mailbox without injecting their contents', () => {
  expect(readWorkspaceContext()?.scratchpadRevision).toBe(4);
  const text = renderWorkspaceContext();
  expect(readWorkspaceContext()?.scratchpad).toBe('Decision B');
  expect(readWorkspaceContext()?.projectScratchpad).toBe('Full project notes on demand');
  expect(text).toContain('Build it');
  expect(text).toContain('scope: "session" or "project"');
  expect(text).not.toContain('Decision B');
  expect(text).toContain('/workspace/extra/ws-repo');
  expect(text).not.toContain('Full project notes on demand');
  db.inbound.query('UPDATE workspace_context SET value=?').run(JSON.stringify({ scratchpad: 'Human correction C' }));
  expect(readWorkspaceContext()?.scratchpad).toBe('Human correction C');
  expect(renderWorkspaceContext()).not.toContain('Human correction C');
});
it('writes redacted tool activity and acknowledges the specific reconfigure request', () => {
  emitWorkspaceEvent('tool', {
    id: 'tool-1',
    name: 'Read',
    input: { api_key: 'private', file: '/repo/a' },
    status: 'completed',
  });
  const event = db.outbound.query('SELECT * FROM workspace_events').get() as any;
  expect(JSON.parse(event.content).input).toEqual({ api_key: '[redacted]', file: '/repo/a' });
  expect(acknowledgeWorkspaceReconfigure()).toBe(false);
  db.inbound.query('UPDATE workspace_context SET control=?').run(JSON.stringify({ kind: 'reconfigure', id: 'nonce' }));
  expect(acknowledgeWorkspaceReconfigure()).toBe(true);
  expect(db.outbound.query("SELECT value FROM session_state WHERE key='ws.reconfigure-ready'").get()).toEqual({
    value: 'nonce',
  });
});
