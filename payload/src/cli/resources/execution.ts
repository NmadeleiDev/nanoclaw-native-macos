import fs from 'node:fs';
import { register } from '../registry.js';
import { executionSettings, updateExecutionSettings, runtimeDoctor } from '../../execution/service.js';
import { listSessionDriverKinds } from '../../drivers/index.js';

for (const [resource, scope] of [
  ['groups', 'agent'],
  ['sessions', 'session'],
] as const)
  for (const verb of ['get', 'update'] as const) {
    register({
      name: `${resource}-execution-${verb}`,
      resource,
      access: 'open',
      hostOnly: true,
      description: `${verb === 'get' ? 'Inspect' : 'Change'} execution permissions. --id selects the ${scope}. Updates accept --policy-file <JSON> --revision <n>, --runtime-driver, and --confirm-docker, and --confirm-browser-exception. Session runtime can change before its first message or execution.`,
      parseArgs: (args) => args,
      async handler(args) {
        if (typeof args.id !== 'string') throw new Error('--id is required');
        if (verb === 'get') return executionSettings(scope, args.id);
        const file = args['policy-file'] ?? args.policy_file;
        return updateExecutionSettings(scope, args.id, {
          runtimeDriver: args['runtime-driver'] ?? args.runtime_driver,
          ...(typeof file === 'string'
            ? { policy: JSON.parse(fs.readFileSync(file, 'utf8')), revision: Number(args.revision) }
            : {}),
          confirmDocker: args['confirm-docker'] === true || args.confirm_docker === true,
          confirmBrowserException: args.confirm_browser_exception === true,
        });
      },
    });
  }
register({
  name: 'runtimes-list',
  resource: 'runtimes',
  hostOnly: true,
  access: 'open',
  description: 'List installed execution runtimes.',
  parseArgs: (a) => a,
  handler: async () => listSessionDriverKinds(),
});
register({
  name: 'runtimes-doctor',
  resource: 'runtimes',
  hostOnly: true,
  access: 'open',
  description: 'Check installed execution runtimes without starting agents.',
  parseArgs: (a) => a,
  handler: runtimeDoctor,
});

for (const verb of ['status', 'open'] as const)
  register({
    name: `groups-browser-${verb}`,
    resource: 'groups',
    hostOnly: true,
    access: 'open',
    description: `${verb} this agent's private host Chrome; requires an existing browser exception grant.`,
    parseArgs: (a) => a,
    async handler(args) {
      if (typeof args.id !== 'string') throw new Error('--id is required');
      const browser = await import('../../execution/browser.js');
      return verb === 'open' ? browser.openHostBrowser(args.id) : browser.browserStatus(args.id);
    },
  });
