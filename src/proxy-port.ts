import { DEFAULT_PROXY_PORT } from "./constants.js";

/**
 * The loopback port every OpenCode instance tries to share.
 *
 * The instance that owns it serves the shared quota endpoint that
 * OpenCode Quota reads. The other instances keep serving their own model
 * traffic on an ephemeral port, so a busy port never stops a plugin from
 * loading.
 */
export const SHARED_PROXY_PORT = DEFAULT_PROXY_PORT;

/**
 * The port this process tries to bind first.
 *
 * `OPENCODE_ANTIGRAVITY_PROXY_PORT` overrides it. Port `0` asks the
 * operating system for an ephemeral port, which also means the process owns
 * no shared quota endpoint.
 */
export function preferredProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCODE_ANTIGRAVITY_PROXY_PORT;
  if (raw !== undefined) {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value < 65_536 ? value : 0;
  }
  if (env.NODE_ENV === "test" || env.BUN_TEST === "1") return 0;
  return SHARED_PROXY_PORT;
}

/** True when a failed bind means "the port is taken" rather than a real fault. */
export function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.toUpperCase() === "EADDRINUSE") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /address already in use|is port \d+ in use/i.test(message);
}

/**
 * The port the shared quota endpoint names, or `null` when this process has
 * no shared endpoint at all.
 */
export function sharedEndpointPort(preferred: number): number | null {
  return preferred > 0 ? preferred : null;
}

/**
 * True when another Antigravity proxy already answers on `port`.
 *
 * The health route is cheap and unauthenticated, so this probe never starts
 * an ACP worker on the other instance.
 */
export async function probeLoopbackHealth(port: number, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { provider?: unknown };
    return body?.provider === "antigravity";
  } catch {
    return false;
  }
}
