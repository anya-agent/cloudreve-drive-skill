// Cloudreve drive CLI — entry point
// Usage: bun app.js <command> [args]
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CrClient, fromUri, toUri, loadToken, setAccount, getAccount, clearToken } from "./src/client.ts";
import { SKILL_ROOT, loadConfig } from "./src/config.ts";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const cmd = process.argv[2];
const { flags: args, positional } = parseArgs(process.argv.slice(3));
if (args.account) setAccount(args.account);

async function requireAuth(client: CrClient): Promise<void> {
  if (!loadToken()) die(`not logged in (account: ${getAccount()}) — run: bun app.js login${args.account ? ` --account ${args.account}` : ""}`);
  await client.ensureFresh();
}

// ---------- login ----------

const pendingFile = () => {
  const acc = getAccount();
  if (!acc || acc === "default" || acc === "anya") return join(SKILL_ROOT, "login-pending.json");
  const safe = acc.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(SKILL_ROOT, `login-pending.${safe}.json`);
};

async function cmdLogin(): Promise<void> {
  const cfg = loadConfig();
  const { verifier, challenge } = await CrClient.pkceAsync();
  const state = Math.random().toString(36).slice(2, 12);
  const redirectUri = args["redirect-uri"] || cfg.redirectUriCandidates[0];
  const scopes = args["scope"] || cfg.scopes;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const url = `${cfg.baseUrl}/session/authorize?${params.toString()}`;

  writeFileSync(
    pendingFile(),
    JSON.stringify({ verifier, state, redirectUri, scopes, createdAt: new Date().toISOString() }, null, 2)
  );

  const acctFlag = args.account ? ` --account ${args.account}` : "";
  console.log("Open this URL in a browser where you are logged into the drive and approve:");
  console.log();
  console.log(url);
  console.log();
  console.log("After approving, the browser will be redirected to a page that fails to load");
  console.log("(this is expected). Copy the `code` parameter from the address bar, then run:");
  console.log();
  console.log(`  bun app.js login-finish${acctFlag} --code "<code>"`);
}

async function cmdLoginFinish(): Promise<void> {
  const cfg = loadConfig();
  if (!existsSync(pendingFile())) die(`no pending login (account: ${getAccount()}) — run: bun app.js login${args.account ? ` --account ${args.account}` : ""}`);
  const pending = JSON.parse(readFileSync(pendingFile(), "utf8"));
  let code = args.code || "";
  if (!code) die("missing --code");
  // accept a full callback URL too
  if (code.includes("code=")) {
    try {
      const u = new URL(code);
      code = u.searchParams.get("code") || code;
      const st = u.searchParams.get("state");
      if (st && st !== pending.state) die(`state mismatch (expected ${pending.state}, got ${st})`);
    } catch {
      const m = code.match(/[?&]code=([^&#]+)/);
      if (m) code = m[1];
    }
  }
  const client = new CrClient();
  await client.exchangeCode(code, pending.verifier, args["redirect-uri"] || pending.redirectUri);
  writeFileSync(pendingFile(), "");
  const me = await client.me();
  console.log(JSON.stringify({ ok: true, account: getAccount(), user: me.id ?? me.nickname ?? me.email, scope: client.token?.scope }, null, 2));
}

async function cmdStatus(): Promise<void> {
  const client = new CrClient();
  const t = loadToken();
  if (!t) {
    console.log(JSON.stringify({ account: getAccount(), loggedIn: false }));
    return;
  }
  let user: Record<string, any> | null = null;
  let cap: Record<string, any> | null = null;
  try {
    await client.ensureFresh();
    user = await client.me();
    cap = await client.capacity();
  } catch (e) {
    console.log(JSON.stringify({ account: getAccount(), loggedIn: true, tokenValid: false, error: String(e), access_expires: t.access_expires }, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        account: getAccount(),
        loggedIn: true,
        tokenValid: true,
        scope: t.scope,
        access_expires: t.access_expires,
        refresh_expires: t.refresh_expires,
        user: { id: user.id, nickname: user.nickname, email: user.email, group: user.group?.name },
        storage: cap ? { used: cap.used ?? cap.storage_used, quota: cap.quota ?? cap.total, usedText: fmtSize(cap.used ?? cap.storage_used ?? 0) } : null,
      },
      null,
      2
    )
  );
}

function cmdLogout(): void {
  clearToken();
  console.log(`logged out (account: ${getAccount()}, token cleared)`);
}

// ---------- file commands ----------

async function cmdLs(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const uri = positional[0] ?? "/";
  const json = args.json === "true";
  const files = json ? await client.listAll(uri) : (await client.list(uri, 1, Number(args["page-size"] || 100))).files;
  if (json) {
    console.log(JSON.stringify(files.map((f) => ({ ...f, path_local: fromUri(toUri(uri)) })), null, 2));
    return;
  }
  if (!files.length) {
    console.log(`(empty) ${uri}`);
    return;
  }
  for (const f of files) {
    const kind = f.type === 1 ? "DIR " : "FILE";
    const size = f.type === 1 ? "" : fmtSize(f.size);
    console.log(`${kind}  ${size.padStart(10)}  ${f.name}`);
  }
}

async function cmdMkdir(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const uri = positional[0];
  if (!uri) die("usage: bun app.js mkdir <path>");
  const f = await client.mkdir(uri);
  console.log(JSON.stringify({ ok: true, name: f.name, id: f.id }, null, 2));
}

async function cmdUpload(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const local = args["local"] || positional[0];
  let remote = args.remote || positional[1];
  if (!local) die("usage: bun app.js upload --local <file> [--remote <dir-or-path>]");
  if (!existsSync(local)) die(`local file not found: ${local}`);
  const base = local.split("/").pop()!;
  if (!remote) remote = "/" + base;
  await client.upload(local, remote);
  const info = await client.info(remote);
  console.log(JSON.stringify({ ok: true, remote, size: info.size, id: info.id }, null, 2));
}

async function cmdDownload(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const remote = args.remote || positional[0];
  const local = args.local || positional[1] || remote.split("/").pop() || "download.bin";
  if (!remote) die("usage: bun app.js download --remote <path> [--local <file>]");
  const n = await client.download(remote, local);
  console.log(JSON.stringify({ ok: true, remote, local, bytes: n }, null, 2));
}

async function cmdUrl(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const remote = args.remote || positional[0];
  if (!remote) die("usage: bun app.js url <path> [--download]");
  const urls = await client.url([remote], args.download === "true");
  console.log(JSON.stringify(urls, null, 2));
}

async function cmdRm(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const uris = positional.length ? positional : [args.path || ""].filter(Boolean);
  if (!uris.length) die("usage: bun app.js rm <path> [path2 ...] [--hard]");
  await client.remove(uris, args.hard === "true");
  console.log(JSON.stringify({ ok: true, removed: uris, hard: args.hard === "true" }, null, 2));
}

async function cmdMv(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const src = args.src || positional[0];
  const dst = args.dst || positional[1];
  if (!src || !dst) die("usage: bun app.js mv --src <path> --dst <dir> [--copy]");
  await client.move([src], dst, args.copy === "true");
  console.log(JSON.stringify({ ok: true, src, dst, copy: args.copy === "true" }, null, 2));
}

async function cmdRename(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const path = args.path || positional[0];
  const name = args.name || positional[1];
  if (!path || !name) die("usage: bun app.js rename <path> <new-name>");
  const f = await client.rename(path, name);
  console.log(JSON.stringify({ ok: true, name: f.name, id: f.id }, null, 2));
}

async function cmdInfo(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const path = args.path || positional[0];
  if (!path) die("usage: bun app.js info <path>");
  const f = await client.info(path, args.extended === "true");
  console.log(JSON.stringify(f, null, 2));
}

async function cmdMe(): Promise<void> {
  const client = new CrClient();
  await requireAuth(client);
  const me = await client.me();
  console.log(JSON.stringify(me, null, 2));
}

const HELP = `cloudreve-drive — Cloudreve v4 file manager

Global option:
  --account <name>      switch account profile (default: default -> token.json; e.g. --account work -> token.work.json)

Auth:
  login                 print OAuth authorize URL (open in browser, approve)
  login-finish --code   exchange authorization code for tokens
  status                show token/user/storage status
  logout                clear stored token

Files (paths are relative to drive root, e.g. /docs/a.txt):
  ls [path] [--json] [--page-size N]
  mkdir <path>
  upload --local <file> [--remote <path>]
  download --remote <path> [--local <file>]
  url <path> [--download]
  rm <path> [path...] [--hard]
  mv --src <path> --dst <dir> [--copy]
  rename <path> <new-name>
  info <path> [--extended]
  me
`;

async function main(): Promise<void> {
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "login-finish":
      await cmdLoginFinish();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logout":
      cmdLogout();
      break;
    case "ls":
      await cmdLs();
      break;
    case "mkdir":
      await cmdMkdir();
      break;
    case "upload":
      await cmdUpload();
      break;
    case "download":
      await cmdDownload();
      break;
    case "url":
      await cmdUrl();
      break;
    case "rm":
      await cmdRm();
      break;
    case "mv":
      await cmdMv();
      break;
    case "rename":
      await cmdRename();
      break;
    case "info":
      await cmdInfo();
      break;
    case "me":
      await cmdMe();
      break;
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(String(e?.message ?? e)));
