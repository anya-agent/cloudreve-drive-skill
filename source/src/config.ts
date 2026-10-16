// config loader: config.json + .env per SKILLS_RULE.md
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUriCandidates: string[];
  tokenFile: string;
  chunkSizeFallback: number;
}

function skillRoot(): string {
  // app.js bundle lives at skill root; when running source directly, go up one level
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, "config.json"))) return here;
  if (existsSync(join(here, "..", "config.json"))) return join(here, "..");
  if (existsSync(join(here, "..", "..", "config.json"))) return join(here, "..", "..");
  throw new Error("cannot locate skill root (config.json not found)");
}

export const SKILL_ROOT = skillRoot();

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function loadConfig(): AppConfig {
  const raw = JSON.parse(readFileSync(join(SKILL_ROOT, "config.json"), "utf8"));
  const env = parseEnvFile(join(SKILL_ROOT, ".env"));

  const resolve = (field: any): string => {
    if (typeof field === "string") return field;
    if (field && field.type === "env") {
      const v = env[field.id] ?? process.env[field.id];
      if (!v) throw new Error(`missing env value: ${field.id} (expected in ${join(SKILL_ROOT, ".env")})`);
      return v;
    }
    throw new Error(`bad config field: ${JSON.stringify(field)}`);
  };

  return {
    baseUrl: resolve(raw.baseUrl).replace(/\/+$/, ""),
    clientId: resolve(raw.clientId),
    clientSecret: resolve(raw.clientSecret),
    scopes: typeof raw.scopes === "string" ? raw.scopes : "",
    redirectUriCandidates: Array.isArray(raw.redirectUriCandidates)
      ? raw.redirectUriCandidates
      : ["http://127.0.0.1", "http://localhost"],
    tokenFile: typeof raw.tokenFile === "string" ? raw.tokenFile : "token.json",
    chunkSizeFallback: typeof raw.chunkSizeFallback === "number" ? raw.chunkSizeFallback : 10 * 1024 * 1024,
  };
}
