import type { ApiExecutor } from "./api.ts";
import type { SharedCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { getSwaggerUrl } from "./config.ts";

interface CheckResult {
  error?: string;
  ok: boolean | null;
  status?: number;
}

export interface DoctorResult {
  checks: {
    auth: CheckResult & { configured: boolean; identity?: Record<string, unknown> };
    cache: CheckResult & { path: string };
    swagger: CheckResult;
  };
  endpoints: {
    api: string;
    swagger: string;
    web: string;
  };
  ok: boolean;
  token: { present: boolean };
  version: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicIdentity(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const identity: Record<string, unknown> = {};
  for (const key of ["id", "name", "email", "userPath"] as const) {
    if (record[key] !== undefined) identity[key] = record[key];
  }
  return Object.keys(identity).length ? identity : undefined;
}

export class Doctor {
  constructor(
    private readonly version: string,
    private readonly config: Config,
    private readonly cache: Pick<SharedCache, "checkWritable">,
    private readonly api: Pick<ApiExecutor, "request">,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async run(): Promise<DoctorResult> {
    const swaggerUrl = getSwaggerUrl(this.config);
    const [cache, swagger] = await Promise.all([this.checkCache(), this.checkSwagger(swaggerUrl)]);
    const auth = await this.checkAuth();
    const ok = cache.ok === true && swagger.ok === true && (!auth.configured || auth.ok === true);
    return {
      checks: { auth, cache, swagger },
      endpoints: { api: this.config.apiUrl, swagger: swaggerUrl, web: this.config.webUrl },
      ok,
      token: { present: Boolean(this.config.token) },
      version: this.version,
    };
  }

  private async checkCache(): Promise<DoctorResult["checks"]["cache"]> {
    const check = await this.cache.checkWritable();
    return {
      ...(check.error ? { error: check.error } : {}),
      ok: check.ok,
      path: check.root,
    };
  }

  private async checkSwagger(url: string): Promise<CheckResult> {
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json" },
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { error: message(error), ok: false };
    }
  }

  private async checkAuth(): Promise<DoctorResult["checks"]["auth"]> {
    if (!this.config.token) return { configured: false, ok: null };
    try {
      const response = await this.api.request("GET", "/me", { cacheMs: 0, fresh: true });
      if (response.status < 200 || response.status >= 300) {
        return { configured: true, ok: false, status: response.status };
      }
      const value = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
      const identity = publicIdentity(value);
      return {
        configured: true,
        ...(identity ? { identity } : {}),
        ok: true,
        status: response.status,
      };
    } catch (error) {
      return { configured: true, error: message(error), ok: false };
    }
  }
}

function checkText(check: CheckResult): string {
  if (check.ok === null) return "SKIP";
  if (check.status !== undefined) return `${check.ok ? "OK" : "FAIL"} (HTTP ${check.status})`;
  return check.ok ? "OK" : `FAIL${check.error ? ` (${check.error})` : ""}`;
}

export function formatDoctor(result: DoctorResult): string {
  const auth = result.checks.auth;
  const lines = [
    `Version:  ${result.version}`,
    `API:      ${result.endpoints.api}`,
    `Web:      ${result.endpoints.web}`,
    `Swagger:  ${result.endpoints.swagger}`,
    `Token:    ${result.token.present ? "present" : "not set"}`,
    `Cache:    ${checkText(result.checks.cache)} ${result.checks.cache.path}`,
    `Swagger:  ${checkText(result.checks.swagger)}`,
    `Auth:     ${auth.configured ? checkText(auth) : "SKIP (token not set)"}`,
  ];
  if (auth.identity) lines.push(`Identity: ${JSON.stringify(auth.identity)}`);
  return `${lines.join("\n")}\n`;
}
