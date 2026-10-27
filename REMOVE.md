# Removal

Retire native sessions first. Restore Docker defaults for agent groups and install-level runtime settings. Started sessions have immutable runtimes; archive them and create new Docker sessions as needed. Stop the target host and native processes.

If optional OneCLI/OpenCode modules were refreshed from the patched recipes, restore their upstream recipe versions separately, preserving credentials and user data. The installer only owns its manifest and integration patch.

Run `node install.mjs --target /path/to/nanoclaw --check-remove`, then `node install.mjs --target /path/to/nanoclaw --remove --confirm-runtime-retired`. The confirmation flag is required if a central database exists; it asserts the operator has retired native execution.

Reinstall dependencies using the restored frozen lockfile, reconcile optional provider runner dependencies using the upstream recipe, rebuild, and start Docker execution.

Removal verifies source hashes, reverses the patch and removes owned files. It retains databases, workspaces, native homes, and instruction history. It does not downgrade the database or delete user data. Empty source directories may remain. Preserve local edits before reconciling an edited installation.
