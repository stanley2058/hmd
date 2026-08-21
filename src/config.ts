import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.hackmd.io/v1";
export const UPSTREAM_SWAGGER_URL = `${DEFAULT_API_URL}/docs/swagger.json`;

export interface Config {
  apiUrl: string;
  cacheDir: string;
  responseCacheMs: number;
  specCacheMs: number;
  token?: string;
  webUrl: string;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function deriveWebUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname === "api.hackmd.io") url.hostname = "hackmd.io";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return withoutTrailingSlash(url.toString());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): Config {
  const apiUrl = withoutTrailingSlash(env.HMD_API_URL || DEFAULT_API_URL);
  const xdgCache = env.XDG_CACHE_HOME || join(userHome, ".cache");
  const token = env.HMD_TOKEN || env.HMD_API_ACCESS_TOKEN;

  return {
    apiUrl,
    cacheDir: env.HMD_CACHE_DIR || join(xdgCache, "hmd"),
    responseCacheMs: 5 * 60 * 1000,
    specCacheMs: 24 * 60 * 60 * 1000,
    ...(token ? { token } : {}),
    webUrl: withoutTrailingSlash(env.HMD_WEB_URL || deriveWebUrl(apiUrl)),
  };
}

export function getSwaggerUrl(config: Config): string {
  return `${config.apiUrl}/docs/swagger.json`;
}
