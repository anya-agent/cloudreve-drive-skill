---
name: cloudreve-drive
description: "Manage files on AnyaDrive (Cloudreve v4) via OAuth-authenticated CLI."
---

# cloudreve-drive

Manage files on your Cloudreve v4 instance through its REST API
with an OAuth 2.0 authorization-code (PKCE) flow. Built against the Cloudreve master
branch source (endpoints verified in `routers/router.go` + `service/explorer`).

## When to use

- Upload/download/list/delete/move/rename files on AnyaDrive from the terminal.
- Check AnyaDrive account/storage status.
- Any task where Korin says "放到网盘/AnyaDrive/云盘" or asks to fetch a file from it.

## Invocation

All commands run from the skill directory with bun:

```bash
cd /opt/data/workspace/anya/skills/cloudreve-drive
bun app.js <command> [args]
```

`app.js` is the compiled bundle; `source/index.ts` is the TS source (rebuild with
`bun build source/index.ts --outfile app.js --target bun` after edits — `--target node`
mangles Chinese output, same lesson as kawaii-health).

### Auth commands (supports `--account <name>`, default is `anya` -> `token.json`, `--account korin` -> `token.korin.json`)

| Command | Effect |
| :--- | :--- |
| `login [--account <name>]` | Prints the OAuth authorize URL (PKCE S256). Open it in a browser logged into AnyaDrive and approve. |
| `login-finish [--account <name>] --code "<code or full callback URL>"` | Exchanges the authorization code for access+refresh tokens, saves to `token.<name>.json`. |
| `status [--account <name>]` | Token validity, user info, storage used/quota. |
| `logout [--account <name>]` | Clears token file for the selected account. |

Login is a two-step human-consent flow by design: `login` → Korin approves in browser →
browser lands on a failing `http://127.0.0.1/?code=...&state=...` page → copy the URL →
`login-finish --code "<that URL>"`. The access token auto-refreshes via
`POST /api/v4/session/token/refresh` when expired (needs `offline_access` scope, which is
requested by default).

### File commands (paths relative to drive root, e.g. `/docs/a.txt`)

| Command | Effect |
| :--- | :--- |
| `ls [path] [--json] [--page-size N]` | List a directory (human table or JSON). |
| `mkdir <path>` | Create a folder. |
| `upload --local <file> [--remote <path>]` | Upload a local file (chunked per policy chunk_size). Defaults remote to `/<basename>`. |
| `download --remote <path> [--local <file>]` | Download via signed URL. |
| `url <path> [--download]` | Print signed preview/download URL(s). |
| `rm <path> [path...] [--hard]` | Delete (soft by default → trash; `--hard` skips soft delete). |
| `mv --src <path> --dst <dir> [--copy]` | Move or copy. |
| `rename <path> <new-name>` | Rename. |
| `info <path> [--extended]` | File metadata. |
| `me` | Current user object. |

Output: JSON or plain text on stdout; errors on stderr with non-zero exit.

## Configuration

- `config.json`: base URL / client id / client secret are `type:"env"` fields resolved
  from `.env` in the skill directory (`CLOUDREVE_BASE_URL`, `CLOUDREVE_CLIENT_ID`,
  `CLOUDREVE_CLIENT_SECRET`). Scopes, redirect URI candidates and token file name are
  plain strings there.
- `token.json`: saved token pair (access/refresh + expiry). Treat as a secret.
- `login-pending.json`: transient PKCE verifier/state between `login` and `login-finish`.

## API notes (verified against source)

- File URIs are `cloudreve://my/<path>`; the CLI accepts plain paths and converts.
- List: `GET /api/v4/file?uri=...&page=...&page_size=...` (also supports
  `next_page_token` cursor pagination). `type: 0`=file, `1`=folder.
- Upload: `PUT /api/v4/file/upload` (create session) → two paths depending on policy:
  - master/local: `POST /api/v4/file/upload/:sessionId/:index` per chunk (Content-Length
    must equal the chunk size; last chunk completes automatically).
  - S3-like (presigned): PUT each chunk to its `upload_urls[i]`, POST the
    CompleteMultipartUpload XML to `completeURL`, then notify the server with
    `GET /api/v4/callback/s3/:sessionId/:callback_secret`. Both implemented.
- Upload target must not already exist, or you get `40004 Object existed`. Deleting a
  just-uploaded file right away can hit `40073 Lock conflict` — wait ~30s and retry.
- Download URL: `POST /api/v4/file/url` `{uris, download}`.
- Envelope: `{code:0, msg, data}`; `code != 0` is an error (401/40020 trigger one refresh+retry).
- OAuth: consent `POST /api/v4/session/oauth/consent` (needs web login), token
  `POST /api/v4/session/oauth/token` (form-encoded, `grant_type=authorization_code` only —
  no client_credentials grant exists). Redirect URIs must match the registered ones
  (loopback port variations allowed per RFC 8252).

## Safety

- `rm` defaults to soft delete (recoverable from trash); `--hard` is destructive — confirm
  with Korin before using it or deleting anything important.
- Never print `token.json` contents or the client secret into chat/logs.
- The `.env` and `token.json` are gitignored; do not commit them.

## Known pitfalls

- If the authorize page shows "Invalid redirect URI", the redirect URIs registered on the
  app (created by Korin in the admin panel) don't include the one used. Override with
  `--redirect-uri <exact registered uri>` on both `login` and (optionally) `login-finish`.
- Authorization codes are single-use and expire after 10 minutes; re-run `login` if the
  exchange fails with "Invalid or expired authorization code".
- Scope names are case-sensitive (`Files.Read`, `UserInfo.Read`); requesting a scope the
  app registration doesn't have makes the consent page error with "Invalid scope requested".
- `login --scope "..."` overrides the default scope list for one login attempt.
