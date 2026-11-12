# Windows CLI credential review

Reviewed the official CLI 1.3.5 Windows x64 artifact linked by the install
service's `manifests/windows_amd64.json` on 2026-10-14:
`https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.5-6164039479459840/windows-x64/cli_windows_x64.exe`.
SHA-512 (matches that manifest):
`4483cac360dcedcdba19c49d4e589559ce7fcba039daf1887ffa5bd68d1f4437660733295822c13283d4243e00813259ad839466f5b9bc6c20728077a392d38c`.

The Go function table identifies zalando/go-keyring's `windowsKeychain.Get`
and `.Set`, and `codeassistclient.KeyringTokenStorage.LoadStoredToken`.
The latter reads keyring service `gemini`, converts the returned string to
bytes (`runtime.stringtoslicebyte`), and calls `encoding/json/v2.Unmarshal`
into `codeassistclient.StoredToken`. Runtime struct metadata gives its
`token` and `auth_method,omitempty` JSON fields. It also includes unrelated
ID token, WIF, project, region and tier fields which this adapter ignores.
The upstream go-keyring v0.2.6 Windows implementation uses target
`service + ":" + username`, reads `string(cred.CredentialBlob)` and writes
`[]byte(password)`. The reporter independently identified the exact generic
target `gemini:antigravity`. Thus the supported envelope is UTF-8 JSON, not
Credential Manager's sometimes-used UTF-16 password representation.

The adapter reads only that target via CredReadW, frees its native buffer,
bounds blob/output size and execution time, and suppresses all native error
details. A custom HOME or GEMINI_HOME remains file-only. It never creates a
CLI token file, starts login, enumerates credentials, or writes the keyring.
Native CI uses synthetic credentials on a disposable GitHub runner only.

# Linux Secret Service credential review

Reviewed on Linux x64 on 2026-11-12 against the Antigravity CLI 1.3.5 running
from `~/.gemini/antigravity-cli`. The CLI log reports
`keyring.go:64] keyringAuth: loaded token` followed by
`auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)`, so
the CLI stores its consumer credential in the Secret Service, not in a file
under `~/.gemini/antigravity-cli/`.

The CLI uses zalando/go-keyring, whose Linux backend maps the generic target
`service:user` onto the Secret Service attributes `service` and `username` and
stores the secret verbatim in the `password` attribute. The official target is
therefore service `gemini`, account `antigravity`, and the stored secret is the
raw UTF-8 JSON envelope, not an encoded blob:

```json
{"token":{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"...","expires_in":3599},"auth_method":"consumer","id_token_email":"..."}
```

This adapter reads only that one target through `secret-tool lookup service
gemini username antigravity`. The lookup never enumerates the collection, is
bounded to 10 seconds and 16 KiB, and reports a locked, missing or absent
entry exactly like no credential at all. A stored envelope that is malformed or
that is not a consumer/oauth-personal login is not a file-fallback login: it
ends the resolution instead of silently falling through to another credential.

A custom HOME or GEMINI_HOME stays file-only, exactly as on Windows, so a
relocated home never borrows the desktop session's login. The file fallback
(`~/.gemini/antigravity-cli/antigravity-oauth-token`) remains the only source
for platforms whose CLI has no reviewed native store, including macOS, where
the keychain coordinates of the separate ACP server are documented below.

Note that this entry belongs to the CLI. The standalone ACP server keeps its
own consumer credential under account `antigravity-acp`, which was absent on
the reviewed host, so the server there used its secure file
`~/.gemini/antigravity-acp/acp_token.json`.

# macOS ARM64 isolation review

Downloaded the official ACP 1.3.0 Darwin ARM64 archive and independently
verified both profile SHA-256 values. Extracted ZIP local entries from the
PAR executable (without executing it):
`google3/cloud/developer_experience/antigravity_extensions/acp_server/tool_filter.py`
and `server.py`. `ToolFilterConfig.from_request_kwargs` reads
`_meta.agy.enabledTools`; an empty list becomes an empty tuple, not None.
`resolve_disabled_builtins` disables everything outside that allowlist.
`_create_agent_config` applies that result, excludes the safe_view_file
substitute, and gates subagents and browser injection. Session creation,
restoration and agent rebuild all pass/persist the filter. This is a static
host-tool isolation review; native unauthenticated startup CI does not prove
authenticated inference.
