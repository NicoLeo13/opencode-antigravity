import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { info, warn } from "./log.js";

/**
 * SHA-256 of the official Antigravity ACP runtime that answers agy's own
 * `/usage` command, per `${platform}-${arch}`.
 *
 * The runtime the fork pins for model traffic (1.3.0) does not implement
 * that command at all: it forwards `/usage` to the model as a prompt. The
 * quota worker therefore runs on this runtime instead. It exposes no host
 * tools, so the host-tool isolation profile does not apply to it: the worker
 * only sends `/usage` and reads the reply.
 *
 * To re-pin, install the runtime from the official release and run
 * sha256sum on `agy_acp_server.par`.
 */
export const QUOTA_RUNTIME_SHA256: Record<string, string> = {
  "linux-x64": "8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04",
};

const EXECUTABLE = "agy_acp_server.par";

/** Where the official runtime installer keeps the current release. */
function managedRuntimePaths(): string[] {
  const home = homedir();
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return [
    join(home, ".local", "opt", "agy-acp", "current", EXECUTABLE),
    join(dataHome, "agy-acp", "current", EXECUTABLE),
  ];
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let resolved: { path: string } | null | undefined;

/**
 * The runtime that answers `/usage`, or `null` when no verified official
 * runtime is installed.
 *
 * `OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH` overrides the lookup and is trusted
 * as given, like the model runtime's own path override.
 */
export async function resolveQuotaRuntime(platform: string = process.platform, arch: string = process.arch): Promise<string | null> {
  if (resolved !== undefined) return resolved?.path ?? null;
  resolved = await resolve(platform, arch);
  return resolved?.path ?? null;
}

/** True when the file is the pinned official runtime for this platform. */
export async function verifyPinnedRuntime(path: string, platform: string = process.platform, arch: string = process.arch): Promise<boolean> {
  const expected = QUOTA_RUNTIME_SHA256[`${platform}-${arch}`];
  if (!expected) return false;
  const actual = await sha256(path).catch(() => "");
  return actual === expected;
}

/** Test seam: forget the resolved runtime. */
export function resetQuotaRuntimeCache(): void {
  resolved = undefined;
}

async function resolve(platform: string, arch: string): Promise<{ path: string } | null> {
  const override = process.env.OPENCODE_ANTIGRAVITY_QUOTA_ACP_PATH?.trim();
  if (override) {
    if (!(await isExecutable(override))) {
      warn("The configured Antigravity quota runtime is not executable", { path: override });
      return null;
    }
    info("Using the configured Antigravity quota runtime", { path: override });
    return { path: override };
  }

  const expected = QUOTA_RUNTIME_SHA256[`${platform}-${arch}`];
  if (!expected) {
    warn("No pinned Antigravity quota runtime for this platform", { platform, arch });
    return null;
  }

  for (const path of managedRuntimePaths()) {
    if (!(await isExecutable(path))) continue;
    if (!(await verifyPinnedRuntime(path, platform, arch))) {
      warn("The installed Antigravity quota runtime does not match the pinned checksum", { path });
      continue;
    }
    info("Using the official Antigravity quota runtime", { path });
    return { path };
  }

  warn("No official Antigravity runtime that answers /usage is installed", { platform, arch });
  return null;
}
