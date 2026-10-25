import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(artifactDir, "../.test-dist");

if (!process.env.API_TEST_DATABASE_URL) {
  console.error(
    "Set API_TEST_DATABASE_URL to a dedicated, empty PostgreSQL test database with the app schema before running these integration tests.",
  );
  process.exit(2);
}

try {
  await rm(outputDir, { recursive: true, force: true });
  await build({
    entryPoints: [path.resolve(artifactDir, "storeroom-isolation.test.ts")],
    outfile: path.join(outputDir, "storeroom-isolation.test.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    logLevel: "info",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
globalThis.require = __bannerCrReq(import.meta.url);`,
    },
    external: [
      "@clerk/express",
      "@clerk/shared",
      "cors",
      "cookie-parser",
      "drizzle-orm",
      "express",
      "http-proxy-middleware",
      "pino",
      "pino-http",
      "pino-pretty",
    ],
  });

  const result = spawnSync(
    process.execPath,
    ["--test", path.join(outputDir, "storeroom-isolation.test.mjs")],
    {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
