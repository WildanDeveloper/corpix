import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@corpix/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@corpix/agents": path.resolve(__dirname, "packages/agents/src/index.ts"),
      "@corpix/server/db": path.resolve(__dirname, "apps/server/src/db/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
