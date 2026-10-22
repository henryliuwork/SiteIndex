import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const desktopRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@siteindex/core", "@siteindex/shared"] })],
    build: { rollupOptions: { input: resolve(desktopRoot, "src/main/index.ts") } },
  },
  preload: {
    define: {
      __SITEINDEX_MOCK_UI__: JSON.stringify(process.env.VITE_MOCK === "1"),
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(desktopRoot, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(desktopRoot, "src/renderer/fallback.html") },
    },
    server: { host: "127.0.0.1", port: 5174, strictPort: true },
  },
});
