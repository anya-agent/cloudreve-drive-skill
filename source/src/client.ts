// Cloudreve v4 REST client: OAuth PKCE authorization-code flow + file operations.
// All endpoints verified against cloudreve/Cloudreve master branch source (2026-10).
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ROOT, loadConfig, type AppConfig } from "./config.ts";

// ---------- types ----------

export interface TokenPair {
  access_token: string;
  refresh_token?: string;
  access_expires: string; // ISO time
  refresh_expires?: string;
  scope?: string;
}

export interface FileEntry {
  type: number; // 0=file, 1=folder
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  size: number;
  path?: string;
  primary_entity?: string;
  metadata?: Record<string, string>;
}

export interface ListResult {
  files: FileEntry[];
  pagination: { page: number; page_size: number; total_items?: number; next_token?: string };
}

export interface UploadSession {
  session_id: string;
  chunk_size: number; // 0 = single-chunk
  expires: number;
  upload_urls?: string[];
  completeURL?: string;
  callback?: string;
  callback_secret?: string;
  uploadID?: string;
  credential?: string;
  uri: string;
  storage_policy?: { type: string; max_size: number };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface ApiEnvelope<T> {
  code: number;
  msg: string;
  error?: string;
  data: T;
}

// ---------- uri helpers ----------

export function toUri(p: string): string {
  if (p.startsWith("cloudreve://")) return p;
  const clean = "/" + p.replace(/^\/+/, "");
  return `cloudreve://my${clean === "/" ? "" : clean}`;
}

export function fromUri(uri: string): string {
  if (!uri.startsWith("cloudreve://")) return uri;
  const rest = uri.slice("cloudreve://".length);
  const at = rest.indexOf("@");
  const path = at >= 0 ? rest.slice(at + 1) : rest; // skip fs-type segment (my/share)
  const q = path.indexOf("?");
  const plain = q >= 0 ? path.slice(0, q) : path;
  return plain || "/";
}

// ---------- token store ----------

let activeAccount = process.env.CLOUDREVE_ACCOUNT || "";

export function setAccount(account?: string): void {
  activeAccount = (account || "").trim();
}

export function getAccount(): string {
  return activeAccount || "default";
}

const tokenPath = () => {
  const base = loadConfig().tokenFile;
  if (!activeAccount || activeAccount === "default" || activeAccount === "anya") {
    return join(SKILL_ROOT, base);
  }
  const safe = activeAccount.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(SKILL_ROOT, `token.${safe}.json`);
};

export function loadToken(): TokenPair | null {
  const p = tokenPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as TokenPair;
  } catch {
    return null;
  }
}

export function saveToken(t: TokenPair): void {
  writeFileSync(tokenPath(), JSON.stringify(t, null, 2));
}

export function clearToken(): void {
  const p = tokenPath();
  if (existsSync(p)) writeFileSync(p, "");
}

function accessExpired(t: TokenPair, skewSec = 60): boolean {
  if (!t.access_expires) return false;
  return Date.now() + skewSec * 1000 >= new Date(t.access_expires).getTime();
}

// ---------- core HTTP ----------

/** 请求超时：API 30s / 分片上传 300s / 下载 300s（避免 CDN 卡死把整条命令挂住） */
const TIMEOUT_API_MS = 30_000;
const TIMEOUT_TRANSFER_MS = 300_000;

/**
 * 传输类 fetch 带重试：CDN 边缘偶发证书链/握手失败（同一 URL 下一次就成功），
 * 单次失败不该让整条上传/下载挂掉。
 */
async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 5): Promise<Response> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      // 只对网络/证书类错误重试；业务 4xx 由调用方处理
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 400 * i + Math.floor(Math.random() * 300)));
      }
      if (msg.includes("certificate")) continue;
    }
  }
  throw lastErr;
}

export class CrClient {
  cfg: AppConfig;
  token: TokenPair | null;

  constructor() {
    this.cfg = loadConfig();
    this.token = loadToken();
  }

  private async raw(
    method: string,
    path: string,
    opts: { json?: unknown; form?: URLSearchParams; auth?: boolean; rawBody?: BodyInit; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if (opts.form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.auth !== false && this.token?.access_token) {
      headers["Authorization"] = `Bearer ${this.token.access_token}`;
    }
    return fetch(this.cfg.baseUrl + path, {
      method,
      headers,
      body:
        opts.json !== undefined
          ? JSON.stringify(opts.json)
          : opts.form !== undefined
            ? opts.form.toString()
            : opts.rawBody,
      signal: AbortSignal.timeout(TIMEOUT_API_MS),
    });
  }

  /** Call an API endpoint; unwraps the {code,msg,data} envelope. Retries once on 401 (after token refresh). */
  async api<T>(
    method: string,
    path: string,
    opts: { json?: unknown; form?: URLSearchParams; auth?: boolean; retry?: boolean } = {}
  ): Promise<T> {
    const doFetch = async (): Promise<ApiEnvelope<T>> => {
      const res = await this.raw(method, path, opts);
      const text = await res.text();
      let parsed: ApiEnvelope<T>;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      if (parsed.code !== 0) {
        throw new CrApiError(parsed.code, parsed.msg || parsed.error || "unknown error", path);
      }
      return parsed;
    };

    try {
      const env = await doFetch();
      return env.data;
    } catch (e) {
      if (opts.retry === false) throw e;
      if (e instanceof CrApiError && (e.code === 401 || e.code === 40020) && this.token?.refresh_token) {
        await this.refresh();
        const env = await doFetch();
        return env.data;
      }
      throw e;
    }
  }

  // ---------- auth ----------

  /** Ensure we have a valid token: refresh if expired. */
  async ensureFresh(): Promise<void> {
    if (!this.token || !this.token.access_token) {
      throw new Error("not logged in — run: bun app.js login");
    }
    if (accessExpired(this.token) && this.token.refresh_token) {
      await this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (!this.token?.refresh_token) throw new Error("no refresh token — run: bun app.js login");
    // POST /api/v4/session/token/refresh returns the {code,msg,data} envelope
    // with data = auth.Token {access_token, refresh_token, access_expires, refresh_expires}
    const res = await this.raw("POST", "/api/v4/session/token/refresh", {
      json: { refresh_token: this.token.refresh_token },
      auth: false,
    });
    const text = await res.text();
    let env: ApiEnvelope<TokenPair>;
    try {
      env = JSON.parse(text);
    } catch {
      throw new Error(`refresh returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (env.code !== 0 || !env.data?.access_token) {
      throw new Error(`refresh failed: ${text.slice(0, 300)}`);
    }
    const data = env.data;
    const merged: TokenPair = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.token.refresh_token,
      access_expires: data.access_expires,
      refresh_expires: data.refresh_expires,
      scope: this.token.scope,
    };
    saveToken(merged);
    this.token = merged;
  }

  // ---------- OAuth authorization code flow (PKCE) ----------

  static async pkceAsync(): Promise<{ verifier: string; challenge: string }> {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const verifier = base64url(buf);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest)) };
  }

  /** Step 2 of login: exchange authorization code for tokens (PKCE). */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<void> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    const res = await this.raw("POST", "/api/v4/session/oauth/token", { form, auth: false });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`token endpoint non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!data.access_token) {
      throw new Error(`token exchange failed: ${text.slice(0, 300)}`);
    }
    const now = Date.now();
    const merged: TokenPair = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      access_expires: new Date(now + (data.expires_in ?? 3600) * 1000).toISOString(),
      refresh_expires: data.refresh_token_expires_in
        ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
        : undefined,
      scope: data.scope,
    };
    saveToken(merged);
    this.token = merged;
  }

  /** Step 1.5: direct consent grant using an existing web session cookie (browser-assisted login). */
  async grantViaCookie(cookie: string, redirectUri: string, state: string, challenge: string): Promise<string> {
    const res = await fetch(this.cfg.baseUrl + "/api/v4/session/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        state,
        scope: this.cfg.scopes,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(TIMEOUT_API_MS),
    });
    const data = await res.json();
    if (data.code !== 0 || !data.data?.code) {
      throw new Error(`consent grant failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.data.code as string;
  }

  // ---------- file operations ----------

  async list(uri: string, page = 1, pageSize = 100, orderBy = "", orderDirection = ""): Promise<ListResult> {
    const qs = new URLSearchParams({ uri: toUri(uri), page: String(page), page_size: String(pageSize) });
    if (orderBy) qs.set("order_by", orderBy);
    if (orderDirection) qs.set("order_direction", orderDirection);
    return this.api<ListResult>("GET", `/api/v4/file?${qs.toString()}`);
  }

  async listAll(uri: string): Promise<FileEntry[]> {
    const all: FileEntry[] = [];
    let page = 1;
    let nextToken = "";
    for (;;) {
      const qs = new URLSearchParams({ uri: toUri(uri), page_size: "100" });
      if (nextToken) qs.set("next_page_token", nextToken);
      else qs.set("page", String(page));
      const r = await this.api<ListResult>("GET", `/api/v4/file?${qs.toString()}`);
      all.push(...(r.files ?? []));
      nextToken = r.pagination?.next_token ?? "";
      const total = r.pagination?.total_items;
      if (nextToken) continue;
      if (!r.files?.length || (total !== undefined && all.length >= total) || r.files.length < 100) break;
      page += 1;
      if (page > 500) break; // safety
    }
    return all;
  }

  async mkdir(uri: string): Promise<FileEntry> {
    return this.api<FileEntry>("POST", "/api/v4/file/create", {
      json: { uri: toUri(uri), type: "folder" },
    });
  }

  async createFile(uri: string): Promise<FileEntry> {
    return this.api<FileEntry>("POST", "/api/v4/file/create", {
      json: { uri: toUri(uri), type: "file" },
    });
  }

  async info(uri: string, extended = false): Promise<FileEntry> {
    const qs = new URLSearchParams({ uri: toUri(uri), extended: String(extended) });
    return this.api<FileEntry>("GET", `/api/v4/file/info?${qs.toString()}`);
  }

  async rename(uri: string, newName: string): Promise<FileEntry> {
    return this.api<FileEntry>("POST", "/api/v4/file/rename", {
      json: { uri: toUri(uri), new_name: newName },
    });
  }

  async move(uris: string[], dst: string, copy = false): Promise<void> {
    await this.api<null>("POST", "/api/v4/file/move", {
      json: { uris: uris.map(toUri), dst: toUri(dst), copy },
    });
  }

  async remove(uris: string[], hard = false): Promise<void> {
    await this.api<null>("DELETE", "/api/v4/file", {
      json: { uris: uris.map(toUri), skip_soft_delete: hard },
    });
  }

  async restore(uris: string[]): Promise<void> {
    await this.api<null>("POST", "/api/v4/file/restore", { json: { uris: uris.map(toUri) } });
  }

  /** Get download/preview URL(s) for one or more file URIs. */
  async url(uris: string[], download = false): Promise<{ url: string; name?: string }[]> {
    const data = await this.api<{ urls: { url: string }[] }>("POST", "/api/v4/file/url", {
      json: { uris: uris.map(toUri), download },
    });
    return (data.urls ?? []).map((u) => ({ url: u.url }));
  }

  async createUploadSession(uri: string, size: number, mimeType = ""): Promise<UploadSession> {
    return this.api<UploadSession>("PUT", "/api/v4/file/upload", {
      json: { uri: toUri(uri), size, mime_type: mimeType, last_modified: Date.now() },
    });
  }

  /** Upload a local file. Supports master/local chunk upload and S3-like
   *  direct-to-storage (presigned URL) policies. */
  async upload(localPath: string, remoteUri: string): Promise<void> {
    const file = Bun.file(localPath);
    const size = file.size;
    if (size === 0) throw new Error(`empty or missing file: ${localPath}`);
    const mime = file.type || "";
    const session = await this.createUploadSession(remoteUri, size, mime);

    if (session.upload_urls && session.upload_urls.length > 0) {
      await this.uploadDirect(file, session);
      return;
    }

    const chunkSize = session.chunk_size > 0 ? session.chunk_size : size; // 0 => single chunk
    const total = Math.max(1, Math.ceil(size / chunkSize));
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = Math.min(size, start + chunkSize);
      const blob = file.slice(start, end);
      const res = await this.raw("POST", `/api/v4/file/upload/${session.session_id}/${i}`, {
        rawBody: await blob.arrayBuffer(),
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`chunk ${i} upload failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      }
      const env = await res.json().catch(() => null);
      if (env && env.code !== 0) {
        throw new Error(`chunk ${i} upload error: code=${env.code} msg=${env.msg}`);
      }
    }
  }

  /** Direct-to-storage upload: PUT each chunk to its presigned URL, POST the
   *  CompleteMultipartUpload XML to completeURL, then notify the server callback. */
  private async uploadDirect(file: Bun.File, session: UploadSession): Promise<void> {
    const urls = session.upload_urls!;
    const chunkSize = session.chunk_size > 0 ? session.chunk_size : file.size;
    const parts: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < urls.length; i++) {
      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);
      const res = await fetchWithRetry(urls[i], {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: await blob.arrayBuffer(),
        signal: AbortSignal.timeout(TIMEOUT_TRANSFER_MS),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`presigned chunk ${i} upload failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      }
      const etag = res.headers.get("etag") || "";
      if (!etag) throw new Error(`presigned chunk ${i}: missing ETag in response`);
      parts.push({ partNumber: i + 1, etag });
    }

    // complete multipart upload (XML body, same as web client)
    let xml = "<CompleteMultipartUpload>";
    for (const p of parts) {
      xml += `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`;
    }
    xml += "</CompleteMultipartUpload>";
    const cres = await fetch(session.completeURL!, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: xml,
      signal: AbortSignal.timeout(TIMEOUT_TRANSFER_MS),
    });
    if (!cres.ok) {
      const t = await cres.text().catch(() => "");
      throw new Error(`complete multipart failed (HTTP ${cres.status}): ${t.slice(0, 300)}`);
    }

    // notify server (S3-like callback): GET /api/v4/callback/s3/<sessionID>/<secret>
    if (session.callback_secret) {
      await this.api<null>(
        "GET",
        `/api/v4/callback/s3/${session.session_id}/${session.callback_secret}`
      );
    }
  }

  /** Download a remote file to a local path via its signed URL. */
  async download(remoteUri: string, localPath: string): Promise<number> {
    const urls = await this.url([remoteUri], true);
    if (!urls.length || !urls[0].url) throw new Error(`no download url for ${remoteUri}`);
    const res = await fetchWithRetry(urls[0].url, {
      signal: AbortSignal.timeout(TIMEOUT_TRANSFER_MS),
    });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    // 流式写盘：大文件不再整包读进内存
    const sink = Bun.file(localPath).writer();
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink.write(value);
    }
    await sink.end();
    return statSync(localPath).size;
  }

  async me(): Promise<Record<string, any>> {
    return this.api<Record<string, any>>("GET", "/api/v4/user/me");
  }

  async capacity(): Promise<Record<string, any>> {
    return this.api<Record<string, any>>("GET", "/api/v4/user/capacity");
  }
}

export class CrApiError extends Error {
  code: number;
  path: string;
  constructor(code: number, msg: string, path: string) {
    super(`Cloudreve API error ${code} at ${path}: ${msg}`);
    this.code = code;
    this.path = path;
  }
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
