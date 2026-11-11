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
          "media-recovery-harness": resolve("src/main/media-recovery-harness.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
});
