import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { getProxyBaseUrl, startProxy, stopProxy } from "../src/proxy.js";
import { isAddressInUse, preferredProxyPort, probeLoopbackHealth, sharedEndpointPort } from "../src/proxy-port.js";

test("preferredProxyPort reads the override, the test default and the shared port", () => {
  expect(preferredProxyPort({})).toBe(42123);
  expect(preferredProxyPort({ OPENCODE_ANTIGRAVITY_PROXY_PORT: "43000" })).toBe(43000);
  expect(preferredProxyPort({ OPENCODE_ANTIGRAVITY_PROXY_PORT: "0" })).toBe(0);
  expect(preferredProxyPort({ OPENCODE_ANTIGRAVITY_PROXY_PORT: "not a port" })).toBe(0);
  expect(preferredProxyPort({ NODE_ENV: "test" })).toBe(0);
  expect(preferredProxyPort({ BUN_TEST: "1" })).toBe(0);
});

test("isAddressInUse tells a busy port apart from a real fault", () => {
  expect(isAddressInUse(Object.assign(new Error("Failed to start server. Is port 42123 in use?"), { code: "EADDRINUSE" }))).toBe(true);
  expect(isAddressInUse(new Error("address already in use"))).toBe(true);
  expect(isAddressInUse(new Error("permission denied"))).toBe(false);
  expect(isAddressInUse(undefined)).toBe(false);
});

test("sharedEndpointPort names the shared endpoint only for a real port", () => {
  expect(sharedEndpointPort(42123)).toBe(42123);
  expect(sharedEndpointPort(0)).toBeNull();
});

test("probeLoopbackHealth recognizes another Antigravity proxy", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: () => Response.json({ ok: true, provider: "antigravity" }) });
  try {
    expect(await probeLoopbackHealth(server.port)).toBe(true);
  } finally {
    server.stop(true);
  }
  expect(await probeLoopbackHealth(server.port)).toBe(false);
});

test("a busy preferred port does not stop the plugin from loading", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-proxy-port-"));
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "OPENCODE_ANTIGRAVITY_ACP_PATH", "GEMINI_HOME", "OPENCODE_ANTIGRAVITY_PROXY_PORT"];
  const saved = keys.map(key => process.env[key]);
  const fixture = join(import.meta.dir, "fixtures/fake-acp.mjs");
  const compatibility = fixtureCompatibility();
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: () => new Response("busy") });
  try {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    process.env.GEMINI_HOME = join(root, "gemini");
    process.env.OPENCODE_ANTIGRAVITY_PROXY_PORT = String(blocker.port);
    await chmod(fixture, 0o755);

    // The port is taken, so the proxy has to move to an ephemeral one instead
    // of throwing and taking the whole provider down with it.
    const port = await startProxy(root);
    expect(port).not.toBe(blocker.port);
    expect(port).toBeGreaterThan(0);

    const health = await fetch(`${getProxyBaseUrl().replace(/\/v1$/, "")}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).provider).toBe("antigravity");
  } finally {
    await stopProxy(root);
    blocker.stop(true);
    compatibility.mockRestore();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(root, { recursive: true, force: true });
  }
});
