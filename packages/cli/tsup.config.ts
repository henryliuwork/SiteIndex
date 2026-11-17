import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  clean: true,
  dts: false,
  minify: true,
  sourcemap: false,
  external: ["playwright-core"],
  // Bundle pure-JS runtime packages so the installed CLI runs without node_modules.
  noExternal: [/^(?!playwright-core(?:\/|$)).*/u],
});
