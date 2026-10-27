---
name: add-native-macos
description: Install the optional scoped native macOS runtime into a compatible NanoClaw checkout.
---
# Add native macOS execution

1. Read README.md, SECURITY.md, compatibility.json and docs/installation.md. Verify the target is compatible and backed up; preserve all user data.
2. Run install.mjs with --target and --check. Stop on conflicts. Stop the target host through the operator's authorized service workflow.
3. Apply the source transaction. Install frozen host dependencies and refresh optional gateway/provider recipes as documented.
4. Build and typecheck both host and runner. Run execution tests and real native provider smoke tests on macOS.
5. Start the host, inspect runtime doctor and explicitly configure the chosen agent's execution policy. Never grant browser, Docker or open network access implicitly.
6. For removal follow REMOVE.md; never delete databases or agent files.
