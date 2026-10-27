import os from 'node:os';
import path from 'node:path';
/** Writes here change the host rather than an agent's workspace. Broad reads remain allowed. */
export function protectedHostWrites(home = os.homedir()): string[] {
  return ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc',
    '/var/db', '/private/var/db', '/opt/homebrew',
    ...['Library/Preferences', 'Library/LaunchAgents', 'Library/Keychains', '.ssh', '.aws', '.kube',
      '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map(file => path.join(home, file))];
}
