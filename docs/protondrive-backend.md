# Proton Drive Backend

> **Backend module, unofficial.** The canonical id is `protondrive`. The backend is implemented as `module.ts` + `adapter.ts` over core `ManagedRemoteFs`, and talks to Proton only through Proton's official Drive SDK (`@protontech/drive-sdk`). It is not affiliated with Proton AG, and the SDK is not yet released for third-party production use: expect it to break when Proton changes its client requirements.

The Proton Drive backend (`backends/protondrive/`) syncs against a folder in the user's **My files**. Proton Drive is end-to-end encrypted: every name, file body and checksum is decrypted in the plugin by the SDK, and Proton's servers see none of them.

This document owns the Proton-specific design judgements. Wire protocols and crypto live in the SDK.

## Layers

| File | Role |
|---|---|
| `adapter.ts` | `RemoteBackendAdapter` over `ProtonDriveApi`: projection, scope, version checks. No SDK import. |
| `drive-api.ts` | `ProtonDriveApi`, the narrow set of Drive operations the adapter uses, with branded uids. The contract harness implements it with an in-memory fake. |
| `sdk-drive-api.ts` | `ProtonDriveApi` over the SDK's `ProtonDriveClient`; the SDK-to-`DriveNode` parse boundary. |
| `sdk-client.ts` | Builds the SDK client: crypto endpoint, caches, account, SRP, telemetry, polyfills. |
| `transport.ts` | Every Proton HTTP request, over `context.http` (`requestUrl`). Session headers, one refresh-and-replay on 401, timeouts. |
| `session.ts` / `fork-login.ts` / `account.ts` | Sign-in, session storage and refresh, the user's address keys. |
| `errors.ts` | SDK and transport failures to the public error taxonomy. |

The SDK does not ship login, session management or account keys. `account.ts` is adapted from Proton's MIT-licensed incubating `proton-drive-sdk-account` package, which is not published to npm and uses `fetch` and Node crypto.

## Authentication

Sign-in uses Proton's **session fork**, the flow Proton's own CLI uses. `auth.start` asks Proton for a fork (`auth/v4/sessions/forks`), stores the selector and a fresh AES-256-GCM key in SecretStorage, and opens `account.proton.me/desktop/login` with the user code and key in the URL fragment. The user signs in on Proton's page, which handles the password, 2FA and any CAPTCHA; Air Sync never sees the password. The page encrypts the user-key password with the key. `auth.complete` polls the fork until Proton releases the forked session, decrypts the key password, and stores the session.

Proton cannot redirect back to Obsidian, so the module declares `auth.completion: "poll"`: core calls `complete` right after `start`, in the same Connect action, and `complete` waits (up to 10 minutes, Proton's own limit) for the browser sign-in to finish. On mobile, return to Obsidian after signing in so the poll can run.

- **Stored secret**: one SecretStorage entry (`session`) holding the session UID, access token, refresh token and the **user-key password**. The key password decrypts the account's private keys, which Drive needs for every name and file. It is as sensitive as the account password for Proton data.
- **Refresh**: on a 401 the transport refreshes once and replays the request. Refresh is single-flight per connection and re-reads SecretStorage first, because another connection of the module (binding, a rebuilt adapter) may already have rotated the refresh token, and Proton rejects a replayed one.
- **Disconnect**: revokes the session (`DELETE auth/v4`), then core clears the secret.
- **Client identity**: requests carry `x-pm-appversion: external-drive-air_sync@<module version>-alpha`, the shape Proton requires of third-party clients. A random `clientUid` in backend data marks this install's upload drafts, so the SDK may delete its own abandoned drafts.

## Adapter

- **Identity and topology**: the SDK node uid (`<volumeId>~<linkId>`) and its parent uid. A Proton rename or move keeps the uid.
- **Version token**: a file's active revision uid. `read` downloads exactly that revision (`versionBoundRead: "revision"`). Folders carry no version.
- **Checksum**: the plaintext SHA-1 the uploader stored in the encrypted extended attributes, projected as `sha1`. Air Sync always uploads with its SHA-1, and the SDK refuses the upload if the bytes differ. Files uploaded by clients that omit the digest have no checksum, so core treats them as unverifiable instead of comparing them.
- **Capabilities**: Proton refuses a second node with the same name in a folder (`exclusiveCreate`). It offers no precondition core can carry: a new revision is checked against the active revision the SDK reads just before it, not against core's observation, and move, rename and trash take no version. So `conditionalContentUpdate` is `"none"` and `conditionalMetadataMutation` is `false`; the adapter compares before mutating.
- **Delete** moves the node to Proton's trash.
- **Move with rename** is two calls, because the SDK has none that does both: rename in the source folder, then move.

### Change feed

The cursor is a volume event id. Events are volume-wide and name only the touched node, so each delta re-reads the touched nodes and reports their current state: gone or trashed nodes as deletes, the rest as upserts. Core drops nodes outside the bound root. Re-reading makes the delta independent of event order, and a replayed event is harmless. A folder moved into the root reports no descendants; `listSubtreeById` lists them. A Proton `refresh` event means the log cannot be replayed from the cursor, and becomes `cursor_invalid`.

The SDK's entity cache is a `NullCache`, so every node read is a fresh API read. Only decrypted node keys are cached, which do not change for a node.

### Excluded and fail-closed nodes

- Excluded from the view: trashed nodes, drafts (a file whose first upload never committed), Proton Docs and Sheets (`application/vnd.proton.*`), and album and photo nodes.
- A node whose **name** does not decrypt has no path. If it is inside the bound root, listing and delta fail with `unverifiable`: its absence would otherwise read as a deletion.
- A node the SDK reports with other decryption errors (for example an undecryptable node key) is projected without version token or checksum: it cannot be read, so core treats it as unverifiable.

## Binding

Before a folder is bound, the settings row offers two buttons. `obsidian-air-sync/<vault>` binds the default folder `My files/obsidian-air-sync/<vault>`, found or created. **Choose folder** opens the core in-app picker (`binding.listAppRootFolders` lists the folders directly under My files): pick one, or type a `/`-separated path under My files such as `notes/notes`. `resolveDefault` walks the path from My files, reuses every existing folder and creates only the missing ones (`folder-path.ts`). An empty, `.` or `..` segment, or a file in the way, is a permanent error. The binding is the folder's node uid, so renaming or moving the folder in Proton keeps syncing. Changing a bound folder is Disconnect and reconnect.

## Bundle and licensing

`@protontech/crypto` (GPL-3.0) and Proton's OpenPGP.js fork (LGPL-3.0) are bundled into `main.js` with the SDK (MIT), about 770 KB minified of the 1.2 MB bundle. A build that includes this backend is therefore distributed under the GPL-3.0 terms of the combined work.

`@protontech/crypto` ships untranspiled TypeScript that does not compile under this repo's compiler options. `tsconfig.json` maps its specifiers to the type declarations in `protontech-crypto.d.ts`; esbuild (`tsconfig.bundle.json`) and Vitest (`server.deps.inline`) resolve the real package.

## Verification

The five shared contracts run against the real adapter over an in-memory `ProtonDriveApi` fake (`tests/fs/protondrive/managed.contract-harness.ts`). The opt-in live e2e (`e2e/protondrive.e2e.ts`) runs the filesystem, priority and rename-safety suites against a real account through the real SDK; see [e2e-testing.md](e2e-testing.md).
