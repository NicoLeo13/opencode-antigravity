import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QUOTA_RUNTIME_SHA256, resetQuotaRuntimeCache, resolveQuotaRuntime, verifyPinnedRuntime } from "../src/quota-runtime.js";

async function withOverride<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH;
  try {
    if (value === undefined) delete process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH;
    else process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH = value;
    resetQuotaRuntimeCache();
    return await body();
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH; else process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH = saved;
    resetQuotaRuntimeCache();
  }
}

test("the configured quota runtime is used as given", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-quota-runtime-"));
  const executable = join(root, "agy_acp_server.par");
  try {
    await writeFile(executable, "not the real runtime");
    await chmod(executable, 0o755);
    await withOverride(executable, async () => {
      expect(await resolveQuotaRuntime()).toBe(executable);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing quota runtime yields no runtime", async () => {
  await withOverride(join("/nonexistent", "agy_acp_server.par"), async () => {
    expect(await resolveQuotaRuntime()).toBeNull();
  });
});

test("a platform without a pinned runtime yields no runtime", async () => {
  await withOverride(undefined, async () => {
    expect(await resolveQuotaRuntime("sunos", "sparc")).toBeNull();
  });
});

test("the pinned checksum rejects a file that is not the official runtime", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-quota-hash-"));
  const file = join(root, "agy_acp_server.par");
  try {
    await writeFile(file, "not the official runtime");
    expect(await verifyPinnedRuntime(file, "linux", "x64")).toBe(false);
    expect(await verifyPinnedRuntime(join(root, "missing"), "linux", "x64")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pin covers the platforms the fork ships a runtime for", () => {
  expect(Object.keys(QUOTA_RUNTIME_SHA256).length).toBeGreaterThan(0);
  for (const hash of Object.values(QUOTA_RUNTIME_SHA256)) {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  }
});
