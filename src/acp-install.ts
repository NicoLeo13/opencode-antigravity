import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import { acquireFileLock } from "./file-lock.js";

export const ACP_VERSION = "1.3.0";

/**
 * SHA-256 of the official zip for each `${platform}-${arch}` key.
 *
 * To re-pin after bumping ACP_VERSION, download
 * https://dl.google.com/agy-extensions/releases/<os>/agy-acp-server-<version>-<platform>-<cpu>.zip
 * (os: macos|windows|linux, cpu: x86_64|arm64) and run sha256sum on it.
 */
export const ACP_ARTIFACT_SHA256: Record<string, string> = {
  "darwin-arm64": "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
  "darwin-x64": "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
  "linux-arm64": "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
  "linux-x64": "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
  "win32-arm64": "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3",
  "win32-x64": "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9",
};

export function acpDistribution(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !cpu) throw new Error(`No official Antigravity distribution for ${platform}-${arch}`);
  return {
    url: `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${ACP_VERSION}-${platform === "win32" ? "windows" : platform}-${cpu}.zip`,
    executable: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
    companion: platform === "win32" ? "localharness_external.exe" : "localharness_external",
    sha256: ACP_ARTIFACT_SHA256[`${platform}-${arch}`],
  };
}

export function acpInstallDirectory(): string {
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity", `acp-server-${ACP_VERSION}`);
}

/** Reject an archive whose SHA-256 does not match the pinned official value. */
export function verifyAcpArchive(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Official ACP archive checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Extract only the two official executables, never archive-supplied paths. */
export function unpackAcpArchive(bytes: Uint8Array, names: string[]): Record<string, Uint8Array> {
  const files = unzipSync(bytes, { filter: (file) => names.includes(basename(file.name)) });
  const result: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    const name = basename(path);
    if (result[name]) throw new Error(`Duplicate executable in ACP archive: ${name}`);
    if (!content.length) throw new Error(`Empty executable in ACP archive: ${name}`);
    result[name] = content;
  }
  if (names.some((name) => !result[name])) throw new Error("Official ACP archive is missing a required executable");
  return result;
}

/** Lazy first-request installation; shared across sessions and server processes. */
export async function installAcpServer(directory = acpInstallDirectory(), download: typeof fetch = fetch): Promise<string> {
  const distribution = acpDistribution();
  const executable = join(directory, distribution.executable);
  const ready = async () => {
    try {
      await Promise.all([distribution.executable, distribution.companion].map((name) =>
        access(join(directory, name), process.platform === "win32" ? constants.F_OK : constants.X_OK),
      ));
      return true;
    } catch { return false; }
  };
  if (await ready()) return executable;
  await mkdir(directory, { recursive: true });
  const release = await acquireFileLock(join(directory, ".install.lock"), 180_000);
  let staging: string | undefined;
  try {
    if (await ready()) return executable;
    const response = await download(distribution.url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
    if (!response.ok) throw new Error(`Official ACP download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (distribution.sha256) verifyAcpArchive(bytes, distribution.sha256);
    const files = unpackAcpArchive(bytes, [distribution.executable, distribution.companion]);
    staging = await mkdtemp(join(directory, ".install-"));
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(staging, name), bytes, { mode: 0o755 });
      await chmod(join(staging, name), 0o755);
    }
    // Publish the companion first, and the discoverable ACP executable last.
    for (const name of [distribution.companion, distribution.executable]) {
      await rename(join(staging, name), join(directory, name));
    }
    return executable;
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await release(); }
  }
}
