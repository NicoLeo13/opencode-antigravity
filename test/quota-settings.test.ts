import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getOpencodeQuotaSettingsPath, reconcileQuotaSettings } from "../src/quota-settings.js";

async function withConfigDir<T>(body: (configDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-quota-settings-"));
  const saved = { configDir: process.env.OPENCODE_CONFIG_DIR, flag: process.env.OPENCODE_ANTIGRAVITY_ENABLE_TEST_QUOTA_RECONCILE };
  try {
    process.env.OPENCODE_CONFIG_DIR = join(root, "config");
    process.env.OPENCODE_ANTIGRAVITY_ENABLE_TEST_QUOTA_RECONCILE = "1";
    // The reconciler never creates the directory: an absent one means the
    // OpenCode Quota plugin is not installed.
    await mkdir(join(process.env.OPENCODE_CONFIG_DIR, "opencode-quota"), { recursive: true });
    return await body(join(root, "config"));
  } finally {
    if (saved.configDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = saved.configDir;
    if (saved.flag === undefined) delete process.env.OPENCODE_ANTIGRAVITY_ENABLE_TEST_QUOTA_RECONCILE; else process.env.OPENCODE_ANTIGRAVITY_ENABLE_TEST_QUOTA_RECONCILE = saved.flag;
    await rm(root, { recursive: true, force: true });
  }
}

test("reconcileQuotaSettings points the Antigravity provider at the given port", async () => {
  await withConfigDir(async () => {
    expect(await reconcileQuotaSettings(42123)).toBe(true);
    const settings = JSON.parse(await readFile(getOpencodeQuotaSettingsPath(), "utf8").then(text => text.replace(/^\/\/[^\n]*\n/gm, "")));
    expect(settings.providers.custom).toEqual([
      {
        id: "antigravity",
        providerId: "antigravity",
        label: "Antigravity",
        mode: "remote-api",
        url: "http://127.0.0.1:42123/quota",
        apiKeyEnv: "OPENCODE_ANTIGRAVITY_API_KEY",
        format: "quota-v1",
        enabled: true,
      },
    ]);
  });
});

test("reconcileQuotaSettings keeps the user's comments and the other providers", async () => {
  await withConfigDir(async (configDir) => {
    await mkdir(join(configDir, "opencode-quota"), { recursive: true });
    const path = join(configDir, "opencode-quota", "settings.jsonc");
    await writeFile(path, '// keep me\n{\n  "version": 6,\n  "providers": { "off": ["opencode-go"] }\n}\n');

    expect(await reconcileQuotaSettings(42123)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.startsWith("// keep me")).toBe(true);
    const settings = JSON.parse(text.replace(/^\/\/[^\n]*\n/gm, ""));
    expect(settings.providers.off).toEqual(["opencode-go"]);
    expect(settings.providers.custom).toHaveLength(1);
  });
});

test("reconcileQuotaSettings leaves an up to date file alone", async () => {
  await withConfigDir(async () => {
    expect(await reconcileQuotaSettings(42123)).toBe(true);
    const before = await readFile(getOpencodeQuotaSettingsPath(), "utf8");
    expect(await reconcileQuotaSettings(42123)).toBe(false);
    expect(await readFile(getOpencodeQuotaSettingsPath(), "utf8")).toBe(before);
  });
});

test("reconcileQuotaSettings moves the endpoint when the port changes", async () => {
  await withConfigDir(async () => {
    expect(await reconcileQuotaSettings(42123)).toBe(true);
    expect(await reconcileQuotaSettings(42124)).toBe(true);
    const text = await readFile(getOpencodeQuotaSettingsPath(), "utf8");
    expect(text).toContain("http://127.0.0.1:42124/quota");
    expect(text).not.toContain("42123/quota");
  });
});
