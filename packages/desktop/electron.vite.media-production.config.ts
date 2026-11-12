import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@siteindex/core", "@siteindex/shared"] })],
    build: {
      outDir: "out/main",
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "media-production-harness": resolve("src/main/media-production-harness.ts"),
          "job-worker": resolve("src/main/job-worker.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
});
