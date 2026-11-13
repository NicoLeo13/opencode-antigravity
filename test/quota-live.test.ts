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
