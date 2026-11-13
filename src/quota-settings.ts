import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { info, warn } from "./log.js";

export function getOpencodeQuotaSettingsPath(): string {
  const env = process.env;
  const home = homedir();
  const configBase = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const configDir = env.OPENCODE_CONFIG_DIR?.trim()
    ? resolve(env.OPENCODE_CONFIG_DIR.trim())
    : join(configBase, "opencode");
  return join(configDir, "opencode-quota", "settings.jsonc");
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1");
}

type QuotaCustomProvider = {
  id: string;
  providerId: string;
  label: string;
  mode: string;
  url: string;
  format: string;
  enabled: boolean;
  [key: string]: unknown;
};

type QuotaSettings = {
  version?: number;
  providers?: {
    custom?: QuotaCustomProvider[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const DEFAULT_SETTINGS_HEADER = `// OpenCode Quota settings: only the ones you changed. A missing key uses its default.
// Every setting and its default: https://github.com/slkiser/opencode-quota/blob/main/docs/readme/configuration.md
// Edit it by hand or ask your agent; OpenCode Quota keeps your comments when it saves.
`;

export async function reconcileQuotaSettings(port: number): Promise<boolean> {
  if ((process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1") && !process.env.OPENCODE_ANTIGRAVITY_ENABLE_TEST_QUOTA_RECONCILE) {
    return false;
  }
  const targetPath = getOpencodeQuotaSettingsPath();
  const targetDir = dirname(targetPath);

  // If the opencode-quota directory does not exist, opencode-quota is not initialized
  if (!existsSync(targetDir) && !existsSync(targetPath)) {
    return false;
  }

  const expectedUrl = `http://127.0.0.1:${port}/quota`;
  let rawContent = "";
  let headerComments = DEFAULT_SETTINGS_HEADER;
  let parsed: QuotaSettings = { version: 6, providers: {} };

  if (existsSync(targetPath)) {
    try {
      rawContent = await readFile(targetPath, "utf8");
      const matchedHeader = rawContent.match(/^(\/\/[^\n]*\n)*/);
      if (matchedHeader && matchedHeader[0].trim()) {
        headerComments = matchedHeader[0];
      }
      const stripped = stripJsonComments(rawContent);
      parsed = JSON.parse(stripped) as QuotaSettings;
    } catch (error) {
      warn("Could not read or parse opencode-quota settings.jsonc", { cause: error, path: targetPath });
      return false;
    }
  }

  parsed.version ??= 6;
  parsed.providers ??= {};
  parsed.providers.custom ??= [];

  const existingIndex = parsed.providers.custom.findIndex((entry) => entry.id === "antigravity");
  const desiredEntry: QuotaCustomProvider = {
    id: "antigravity",
    providerId: "antigravity",
    label: "Antigravity",
    mode: "remote-api",
    url: expectedUrl,
    apiKeyEnv: "OPENCODE_ANTIGRAVITY_API_KEY",
    format: "quota-v1",
    enabled: true,
  };

  if (existingIndex !== -1) {
    const current = parsed.providers.custom[existingIndex]!;
    if (
      current.url === expectedUrl &&
      current.mode === "remote-api" &&
      current.format === "quota-v1" &&
      current.apiKeyEnv === "OPENCODE_ANTIGRAVITY_API_KEY" &&
      current.enabled === true
    ) {
      return false; // Already up to date
    }
    parsed.providers.custom[existingIndex] = { ...current, ...desiredEntry };
  } else {
    parsed.providers.custom.push(desiredEntry);
  }

  const output = `${headerComments}${JSON.stringify(parsed, null, 2)}\n`;

  try {
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await writeFile(targetPath, output, { encoding: "utf8", mode: 0o600 });
    info("Synchronized opencode-quota custom provider settings", { url: expectedUrl, path: targetPath });
    return true;
  } catch (error) {
    warn("Failed to write opencode-quota settings.jsonc", { cause: error, path: targetPath });
    return false;
  }
}
