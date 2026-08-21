import type { Config } from "../src/config.ts";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://api.example.test/v1",
    cacheDir: "/unused",
    responseCacheMs: 5 * 60 * 1000,
    specCacheMs: 24 * 60 * 60 * 1000,
    token: "secret-token",
    webUrl: "https://example.test",
    ...overrides,
  };
}
