import { registerTools } from './server.js';
import { writeMessageOut } from '../db/messages-out.js';

registerTools([
  {
    tool: {
      name: 'request_access',
      description:
        'Request operator approval for native file read/write access, a local connection/listening port, or unrestricted Docker. A grant may restart this turn; inspect state before resuming side effects.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['read', 'write', 'local-connect', 'listen', 'docker'] },
          target: {
            type: 'string',
            description: 'Absolute file/directory path, port number, or local-daemon for Docker',
          },
          reason: { type: 'string' },
        },
        required: ['kind', 'target', 'reason'],
      },
    },
    handler: async (args) => {
      writeMessageOut({
        id: `access-${crypto.randomUUID()}`,
        kind: 'system',
        content: JSON.stringify({
          action: 'execution_access',
          kind: args.kind,
          target: args.target,
          reason: args.reason,
        }),
      });
      return {
        content: [
          {
            type: 'text',
            text: 'Access request sent to the operator. No access has been granted yet. Approval may restart this session; do not automatically repeat side effects.',
          },
        ],
      };
    },
  },
]);
