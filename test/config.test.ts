import { describe, expect, test } from "bun:test";

import { getSwaggerUrl, loadConfig } from "../src/config.ts";

describe("configuration", () => {
  test("uses HMD_API_URL for requests and Swagger discovery", () => {
    const config = loadConfig(
      {
        HMD_API_URL: "http://127.0.0.1:3000/v1/",
        HMD_CACHE_DIR: "/tmp/hmd-test-cache",
        HMD_TOKEN: "token",
      },
      "/home/tester",
    );

    expect(config.apiUrl).toBe("http://127.0.0.1:3000/v1");
    expect(config.webUrl).toBe("http://127.0.0.1:3000");
    expect(config.cacheDir).toBe("/tmp/hmd-test-cache");
    expect(config.token).toBe("token");
    expect(getSwaggerUrl(config)).toBe("http://127.0.0.1:3000/v1/docs/swagger.json");
  });

  test("keeps compatibility with HMD_API_ACCESS_TOKEN", () => {
    expect(loadConfig({ HMD_API_ACCESS_TOKEN: "legacy" }, "/home/tester").token).toBe("legacy");
  });
});
