import { createHash } from "node:crypto";

import type { Config } from "./config.ts";
import { SharedCache } from "./cache.ts";
import { fieldValueAsString, isFileFieldValue, type Field } from "./fields.ts";
import type { HttpMethod, OpenAPISchema, Operation } from "./spec.ts";
import { findOperation, SpecStore } from "./spec.ts";
import { HmdError, type TransportAttempt } from "./diagnostics.ts";

interface CachedResponse {
  body: string;
  headers: Record<string, string>;
  status: number;
}

export interface ExecuteOptions {
  cacheMs: number;
  fields?: Field[];
  fresh?: boolean;
  headers?: string[];
  input?: Uint8Array;
  offline?: boolean;
}

export interface ApiResult {
  attempts: TransportAttempt[];
  body: Uint8Array;
  fetchedAt?: string;
  headers: Headers;
  source: "api" | "cache";
  status: number;
}

function credentialFingerprint(token?: string): string {
  if (!token) return "anonymous";
  return createHash("sha256").update(token).digest("hex");
}

function parseHeaders(values: string[] = []): Headers {
  const headers = new Headers();
  for (const value of values) {
    const index = value.indexOf(":");
    if (index <= 0) throw new Error(`Invalid header "${value}". Expected Name: value.`);
    headers.append(value.slice(0, index).trim(), value.slice(index + 1).trim());
  }
  return headers;
}

function schemaProperties(schema?: OpenAPISchema): Record<string, OpenAPISchema> {
  if (!schema) return {};
  if (schema.properties) return schema.properties;
  for (const alternative of schema.anyOf || []) {
    if (alternative.properties) return alternative.properties;
  }
  return {};
}

function contentTypeFor(operation: Operation): string | undefined {
  return Object.keys(operation.operation.requestBody?.content || {})[0];
}

function responseFromCache(
  value: CachedResponse,
  fetchedAt: string,
  attempts: TransportAttempt[],
): ApiResult {
  return {
    attempts,
    body: Buffer.from(value.body, "base64"),
    fetchedAt,
    headers: new Headers(value.headers),
    source: "cache",
    status: value.status,
  };
}

export class ApiExecutor {
  constructor(
    private readonly config: Config,
    private readonly cache: SharedCache,
    private readonly specs: SpecStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call(operationId: string, options: ExecuteOptions): Promise<ApiResult> {
    let document = await this.specs.load();
    let operation = findOperation(document, operationId);
    if (!operation) {
      document = await this.specs.load({ force: true });
      operation = findOperation(document, operationId);
    }
    if (!operation) {
      throw new HmdError("UNKNOWN_OPERATION", `Unknown operationId "${operationId}".`, {
        details: { operationId },
      });
    }
    return this.executeOperation(operation, options);
  }

  async request(method: string, path: string, options: ExecuteOptions): Promise<ApiResult> {
    const normalizedMethod = method.toUpperCase();
    if (!["DELETE", "GET", "PATCH", "POST", "PUT"].includes(normalizedMethod)) {
      throw new Error(`Unsupported HTTP method "${method}".`);
    }
    const fields = options.fields || [];
    const url = this.resolveApiUrl(path);
    for (const field of fields)
      url.searchParams.append(field.name, fieldValueAsString(field.value));
    return this.send(
      normalizedMethod as HttpMethod,
      url,
      options,
      options.input ? Buffer.from(options.input) : undefined,
    );
  }

  private async executeOperation(
    operation: Operation,
    options: ExecuteOptions,
  ): Promise<ApiResult> {
    const fields = options.fields || [];
    const byName = new Map<string, Field[]>();
    for (const field of fields) {
      const values = byName.get(field.name) || [];
      values.push(field);
      byName.set(field.name, values);
    }

    let path = operation.path;
    const query = new URLSearchParams();
    const headerFields = new Headers();
    for (const parameter of operation.parameters) {
      const values = byName.get(parameter.name) || [];
      if (parameter.required && values.length === 0) {
        throw new Error(`Missing required ${parameter.in} field "${parameter.name}".`);
      }
      if (parameter.in === "path" && values[0]) {
        path = path.replace(
          `{${parameter.name}}`,
          encodeURIComponent(fieldValueAsString(values[0].value)),
        );
      } else if (parameter.in === "query") {
        for (const field of values) query.append(parameter.name, fieldValueAsString(field.value));
      } else if (parameter.in === "header") {
        for (const field of values)
          headerFields.append(parameter.name, fieldValueAsString(field.value));
      }
      byName.delete(parameter.name);
    }
    if (/\{[^}]+\}/.test(path))
      throw new Error(`Not all path fields were supplied for ${operation.path}.`);

    const url = this.resolveApiUrl(path);
    for (const [name, value] of query) url.searchParams.append(name, value);
    const requestHeaders = [...(options.headers || [])];
    for (const [name, value] of headerFields) requestHeaders.push(`${name}: ${value}`);

    let body: BodyInit | undefined = options.input ? Buffer.from(options.input) : undefined;
    const operationContentType = contentTypeFor(operation);
    if (
      body &&
      !requestHeaders.some((header) => header.toLowerCase().startsWith("content-type:"))
    ) {
      if (operationContentType) requestHeaders.push(`Content-Type: ${operationContentType}`);
    }
    if (!body && byName.size > 0 && operationContentType === "multipart/form-data") {
      const form = new FormData();
      for (const [name, values] of byName) {
        for (const { value } of values) {
          if (isFileFieldValue(value)) {
            const bytes = value.data.buffer.slice(
              value.data.byteOffset,
              value.data.byteOffset + value.data.byteLength,
            ) as ArrayBuffer;
            form.append(name, new Blob([bytes]), value.filename);
          } else {
            form.append(name, String(value));
          }
        }
      }
      body = form;
    } else if (!body && byName.size > 0) {
      const bodySchema = Object.values(operation.operation.requestBody?.content || {})[0]?.schema;
      const properties = schemaProperties(bodySchema);
      const jsonBody: Record<string, unknown> = {};
      for (const [name, values] of byName) {
        const schema = properties[name];
        jsonBody[name] =
          schema?.type === "array" || values.length > 1
            ? values.map((field) =>
                isFileFieldValue(field.value)
                  ? Buffer.from(field.value.data).toString("utf8")
                  : field.value,
              )
            : isFileFieldValue(values[0]?.value)
              ? Buffer.from(values[0].value.data).toString("utf8")
              : values[0]?.value;
      }
      body = Buffer.from(JSON.stringify(jsonBody));
      requestHeaders.push(`Content-Type: ${operationContentType || "application/json"}`);
    }

    return this.send(
      operation.method,
      url,
      {
        ...options,
        headers: requestHeaders,
      },
      body,
    );
  }

  private resolveApiUrl(path: string): URL {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      const base = new URL(this.config.apiUrl);
      if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
        throw new Error(`Refusing API request outside ${this.config.apiUrl}.`);
      }
      return url;
    }
    return new URL(`${this.config.apiUrl}/${path.replace(/^\/+/, "")}`);
  }

  private async send(
    method: HttpMethod,
    url: URL,
    options: ExecuteOptions,
    requestBody?: BodyInit,
  ): Promise<ApiResult> {
    const headers = parseHeaders(options.headers);
    headers.set("Accept", headers.get("Accept") || "application/json");
    if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const key = JSON.stringify({
      accept: headers.get("Accept"),
      credential: credentialFingerprint(this.config.token),
      method,
      url: url.toString(),
    });
    const cached =
      method === "GET" ? await this.cache.read<CachedResponse>("responses", key) : undefined;
    const cacheAttempt: TransportAttempt | undefined =
      method === "GET"
        ? {
            ...(cached?.fetchedAt ? { fetchedAt: cached.fetchedAt } : {}),
            method,
            result:
              cached && options.fresh
                ? "bypass"
                : cached
                  ? this.cache.isFresh(cached, options.cacheMs)
                    ? "hit"
                    : "stale"
                  : "miss",
            source: "cache",
            url: url.toString(),
            ...(cached && options.fresh ? { detail: "ignored by --fresh" } : {}),
          }
        : undefined;
    const attempts = cacheAttempt ? [cacheAttempt] : [];
    if (!options.fresh && cached && this.cache.isFresh(cached, options.cacheMs)) {
      return responseFromCache(cached.value, cached.fetchedAt, attempts);
    }
    if (options.offline) {
      if (cached) return responseFromCache(cached.value, cached.fetchedAt, attempts);
      throw new HmdError("CACHE_MISS", `No cached response for ${method} ${url}.`, { attempts });
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...(requestBody ? { body: requestBody } : {}),
        headers,
        method,
      });
    } catch (error) {
      const attempt: TransportAttempt = {
        detail: error instanceof Error ? error.message : String(error),
        method,
        result: "error",
        source: "api",
        url: url.toString(),
      };
      throw new HmdError("NETWORK_ERROR", `Could not reach ${url.origin}.`, {
        attempts: [...attempts, attempt],
        cause: error,
      });
    }
    attempts.push({
      method,
      result: "response",
      source: "api",
      status: response.status,
      url: url.toString(),
    });
    let responseBody: Uint8Array;
    try {
      responseBody = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      attempts.push({
        detail: error instanceof Error ? error.message : String(error),
        method,
        result: "error",
        source: "api",
        url: url.toString(),
      });
      throw new HmdError("NETWORK_ERROR", `Could not read the response from ${url.origin}.`, {
        attempts,
        cause: error,
      });
    }
    const result: ApiResult = {
      attempts,
      body: responseBody,
      headers: response.headers,
      source: "api",
      status: response.status,
    };
    if (method === "GET" && response.ok && options.cacheMs > 0) {
      const entry = await this.cache.write<CachedResponse>("responses", key, {
        body: Buffer.from(responseBody).toString("base64"),
        headers: Object.fromEntries(response.headers),
        status: response.status,
      });
      result.fetchedAt = entry.fetchedAt;
    }
    return result;
  }
}
