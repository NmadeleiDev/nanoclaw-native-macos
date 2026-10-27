# Security model

Experimental, not independently audited. Seatbelt restricts a native process sharing the host's user and kernel; use Docker or stronger isolation for untrusted work requiring a different boundary.

Broad reads may include readable credentials. Only configured write roots and required runtime paths are writable; shared user temporary storage is included for macOS tool compatibility. Open networking permits internet and LAN connections. Listener and Unix socket permissions remain distinct controls.

Chrome and Docker grants confer authority beyond the native filesystem sandbox. Keep them disabled unless explicitly intended. No resource quotas are imposed. Go 1.27+ clients are configured to honor gateway CA bundles without disabling verification. Older binaries and clients with custom trust may require explicit supported CA configuration. Never bypass certificate verification.

Do not put secrets, real agent transcripts, or private paths in public issue reports. Use synthetic reproductions. Report exploitable issues privately through the repository's security reporting feature when available.
