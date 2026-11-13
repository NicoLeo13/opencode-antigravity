import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { QuotaManager } from "../src/quota.js";
import { resetQuotaRuntimeCache } from "../src/quota-runtime.js";

/**
 * The quota worker runs on its own runtime, the one that answers agy's
 * `/usage` command. The fake ACP answers it with the recorded reply, so the
 * whole path is covered without a live Antigravity account.
 */
async function withFakeRuntime<T>(body: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-quota-live-"));
  const keys = [
    "OPENCODE_ANTIGRAVITY_DATA_DIR",
    "OPENCODE_ANTIGRAVITY_ACP_PATH",
    "OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH",
    "GEMINI_HOME",
    "OPENCODE_ANTIGRAVITY_QUOTA_TTL_MS",
    "OPENCODE_ANTIGRAVITY_QUOTA_MAX_STALE_MS",
  ];
  const saved = keys.map(key => process.env[key]);
  const fixture = join(import.meta.dir, "fixtures/fake-acp.mjs");
  const compatibility = fixtureCompatibility();
  try {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH = fixture;
    process.env.GEMINI_HOME = join(root, "gemini");
    await chmod(fixture, 0o755);
    resetQuotaRuntimeCache();
    return await body();
  } finally {
    resetQuotaRuntimeCache();
    compatibility.mockRestore();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(root, { recursive: true, force: true });
  }
}

test("the quota manager reads the live /usage reply and caches it", async () => {
  await withFakeRuntime(async () => {
    const manager = new QuotaManager();
    try {
      const live = await manager.getQuota();
      expect(live.version).toBe("quota-v1");
      expect(live.entries.map(entry => entry.name)).toEqual([
        "gemini-models-weekly",
        "gemini-models-5h",
        "claude-gpt-weekly",
        "claude-gpt-5h",
        "gemini-4-argon-weekly",
      ]);
      expect(live.entries[0]?.percentRemaining).toBe(75);

      // A second read comes from the cache, so the quota panel never waits
      // for a second ACP round trip.
      const cached = await manager.getQuota();
      expect(cached).toEqual(live);
    } finally {
      await manager.stop();
    }
  });
});

test("the quota manager answers from the cache while a refresh runs in the background", async () => {
  await withFakeRuntime(async () => {
    const manager = new QuotaManager();
    try {
      const live = await manager.getQuota();
      process.env.OPENCODE_ANTIGRAVITY_QUOTA_TTL_MS = "0";
      const stale = await manager.getQuota();
      expect(stale).toEqual(live);
    } finally {
      await manager.stop();
    }
  });
});

test("the quota manager does not spawn a worker on start() before quota is requested and drops idle workers", async () => {
  await withFakeRuntime(async () => {
    const manager = new QuotaManager({ workerIdleMs: 120, refreshIntervalMs: 40 });
    try {
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(manager.hasActiveWorker).toBe(false);

      const first = await manager.getQuota();
      expect(first.entries.length).toBeGreaterThan(0);
      expect(manager.hasActiveWorker).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(manager.hasActiveWorker).toBe(false);

      const second = await manager.getQuota({ forceRefresh: true });
      expect(second.entries.length).toBeGreaterThan(0);
      expect(manager.hasActiveWorker).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});

test("the quota manager cleans up when stop() runs while worker startup is in flight", async () => {
  await withFakeRuntime(async () => {
    const pidDir = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-quota-race-"));
    const pidFile = join(pidDir, "worker.pid");
    const slowScript = join(pidDir, "slow-acp.mjs");
    try {
      await Bun.write(
        slowScript,
        `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";
appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
    }, 120);
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-race" } }) + "\\n");
  }
});
`,
      );
      await chmod(slowScript, 0o755);
      process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH = slowScript;
      resetQuotaRuntimeCache();

      const manager = new QuotaManager();
      const pending = manager.getQuota().catch(() => undefined);
      const deadline = Date.now() + 2_000;
      let pid = 0;
      while (Date.now() < deadline) {
        const raw = await Bun.file(pidFile).text().catch(() => "");
        const parsed = Number(raw.trim());
        if (Number.isInteger(parsed) && parsed > 0) { pid = parsed; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pid).toBeGreaterThan(0);

      await manager.stop();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(manager.hasActiveWorker).toBe(false);
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });
});

