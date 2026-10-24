import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
// Build into a temp dir so a concurrent `pnpm dev` keeps its own dist intact.
const dist = path.join(root, ".build-test-dist");

/**
 * These tests exercise the production bundles rather than the TypeScript
 * sources, so a packaging regression fails CI instead of only showing up in
 * Docker.
 */
describe("production build", () => {
  beforeAll(async () => {
    await run("node", ["scripts/build.mjs"], {
      cwd: root,
      env: { ...process.env, CORPIX_BUILD_DIR: ".build-test-dist" },
      timeout: 120_000,
    });
  }, 180_000);

  afterAll(async () => {
    await fs.rm(dist, { recursive: true, force: true });
  });

  it("emits both bundles", async () => {
    const server = await fs.stat(path.join(dist, "server.mjs"));
    const cli = await fs.stat(path.join(dist, "cli.mjs"));
    expect(server.size).toBeGreaterThan(100_000);
    expect(cli.size).toBeGreaterThan(50_000);
  });

  it("runs the CLI from the bundle", async () => {
    const { stdout } = await run("node", [path.join(dist, "cli.mjs"), "team"], {
      cwd: root,
      env: {
        ...process.env,
        LLM_PROVIDER: "mock",
        BOSS_MODEL: "boss-model",
        WORKER_MODEL: "worker-model",
        CHEAP_MODEL: "cheap-model",
        DATA_DIR: path.join(os.tmpdir(), `corpix-prod-cli-${Date.now()}`),
      },
      timeout: 60_000,
    });
    expect(stdout).toContain("Default software team");
    expect(stdout).toContain("Bruno");
  }, 90_000);

  it("serves the API and the built web app from the bundle", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-prod-srv-"));
    const port = 3200 + Math.floor(Math.random() * 300);
    const child = spawn("node", [path.join(dist, "server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        LLM_PROVIDER: "mock",
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: "127.0.0.1",
      },
      stdio: "ignore",
    });

    try {
      let health: Response | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        health = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
        if (health?.ok) break;
      }
      expect(health?.ok).toBe(true);
      const body = (await health?.json()) as { provider?: string };
      expect(body.provider).toBe("mock");

      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>Corpix</title>");
    } finally {
      child.kill("SIGKILL");
      // Wait for the process to actually exit before removing its data dir,
      // otherwise SQLite keeps the file open and the rm races the shutdown.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        setTimeout(resolve, 3_000);
      });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
