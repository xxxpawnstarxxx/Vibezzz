import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// Build number shown in the page's top-middle badge ("v6"). Bump
// `buildNumber` in package.json with each release.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { buildNumber: number };

export default defineConfig({
  server: { port: 5173, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: true },
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.buildNumber}`) },
});
