import { chmod, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const result = await Bun.build({
  banner: "#!/usr/bin/env node",
  entrypoints: ["src/cli.ts"],
  minify: false,
  naming: "hmd.js",
  outdir: "dist",
  sourcemap: "external",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod("dist/hmd.js", 0o755);
