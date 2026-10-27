# Contributing

Keep runtime behavior generic. Do not add rules for particular users, services, command names, or local installations. Use synthetic fixtures only. UI and credential gateway responsibilities stay separate.

The payload plus integration.patch is the source distribution, pinned by compatibility.json and base-files.json. Validate on a clean upstream checkout. Update the explicit release-files.json and run `node release.mjs --refresh` only after reviewing every added file. Commit updated checksums.

Test install, repeated install, conflict refusal, removal, host/runner typechecks, and native process lifecycle on macOS. Linux compilation does not prove Seatbelt behavior. Do not publish runtime data, environment files, screenshots of private sessions, or test logs from real users.
