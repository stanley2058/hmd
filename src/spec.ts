import type { Config } from "./config.ts";
import { getSwaggerUrl, UPSTREAM_SWAGGER_URL } from "./config.ts";
import type { CacheEntry } from "./cache.ts";
import { SharedCache } from "./cache.ts";

export interface OpenAPIParameter {
  description?: string;
  in: "cookie" | "header" | "path" | "query";
  name: string;
  required?: boolean;
  schema?: OpenAPISchema;
}

export interface OpenAPISchema {
  anyOf?: OpenAPISchema[];
  format?: string;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  type?: string;
}

export interface OpenAPIOperation {
  description?: string;
  operationId?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    content?: Record<string, { schema?: OpenAPISchema }>;
    required?: boolean;
  };
  tags?: string[];
}

export interface OpenAPIPath {
  delete?: OpenAPIOperation;
  get?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
  patch?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
}

export interface OpenAPIDocument {
  info?: { title?: string; version?: string };
  openapi?: string;
  paths: Record<string, OpenAPIPath>;
}

export interface Operation {
  method: HttpMethod;
  operation: OpenAPIOperation;
  parameters: OpenAPIParameter[];
  path: string;
}

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function isOpenAPIDocument(value: unknown): value is OpenAPIDocument {
  return Boolean(value && typeof value === "object" && "paths" in value);
}

export function listOperations(document: OpenAPIDocument): Operation[] {
  const operations: Operation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method.toLowerCase() as Lowercase<HttpMethod>];
      if (!operation?.operationId) continue;
      operations.push({
        method,
        operation,
        parameters: [...(pathItem.parameters || []), ...(operation.parameters || [])],
        path,
      });
    }
  }
  return operations;
}

export function findOperation(
  document: OpenAPIDocument,
  operationId: string,
): Operation | undefined {
  return listOperations(document).find(
    (candidate) => candidate.operation.operationId?.toLowerCase() === operationId.toLowerCase(),
  );
}

export function formatSpecSummary(document: OpenAPIDocument, swaggerUrl: string): string {
  const lines = formatOperationTable(document);
  return [
    "",
    "Operations (use with `hmd api call <operation-id>`):",
    "",
    lines,
    "",
    `Active Swagger: ${swaggerUrl}`,
    `Upstream Swagger: ${UPSTREAM_SWAGGER_URL}`,
  ].join("\n");
}

export function formatOperationTable(document: OpenAPIDocument): string {
  const operations = listOperations(document).toSorted((left, right) =>
    left.operation.operationId!.localeCompare(right.operation.operationId!, undefined, {
      sensitivity: "base",
    }),
  );
  const operationIdWidth = Math.max(
    "OPERATION ID".length,
    ...operations.map(({ operation }) => operation.operationId!.length),
  );
  const lines = operations.map(({ method, operation, path }) => {
    return `  ${operation.operationId!.padEnd(operationIdWidth)}  ${method.padEnd(6)}  ${path}`;
  });
  return [`  ${"OPERATION ID".padEnd(operationIdWidth)}  METHOD  PATH`, ...lines].join("\n");
}

export class SpecStore {
  readonly url: string;

  constructor(
    private readonly config: Config,
    private readonly cache: SharedCache,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = getSwaggerUrl(config);
  }

  async load(options: { force?: boolean } = {}): Promise<OpenAPIDocument> {
    const cached = await this.cache.read<OpenAPIDocument>("spec", this.url);
    if (!options.force && cached && this.cache.isFresh(cached, this.config.specCacheMs)) {
      return cached.value;
    }

    try {
      return await this.refresh(cached);
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  }

  private async refresh(cached?: CacheEntry<OpenAPIDocument>): Promise<OpenAPIDocument> {
    const headers = new Headers({ Accept: "application/json" });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await this.fetcher(this.url, { headers });

    if (response.status === 304 && cached) {
      await this.cache.write(
        "spec",
        this.url,
        cached.value,
        cached.etag ? { etag: cached.etag } : {},
      );
      return cached.value;
    }
    if (!response.ok) {
      throw new Error(`Could not fetch Swagger from ${this.url}: HTTP ${response.status}`);
    }

    const document: unknown = await response.json();
    if (!isOpenAPIDocument(document)) {
      throw new Error(`Invalid OpenAPI document from ${this.url}`);
    }
    const etag = response.headers.get("etag");
    await this.cache.write("spec", this.url, document, etag ? { etag } : {});
    return document;
  }
}
