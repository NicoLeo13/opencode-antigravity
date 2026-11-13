import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const ownerFixture = join(import.meta.dir, "fixtures", "acp-owner.mjs");
const treeFixture = join(import.meta.dir, "fixtures", "fake-acp-tree.mjs");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

async function startOwner(infoFile: string, mode?: string): Promise<{ owner: ChildProcess; stdout: () => string }> {
  const owner = spawn(process.execPath, [ownerFixture, treeFixture], {
    env: {
      ...process.env,
      FAKE_TREE_INFO_FILE: infoFile,
      ...(mode ? { FAKE_OWNER_MODE: mode } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the owner never became ready")), 20_000);
    owner.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    owner.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("the owner exited before it was ready"));
    });
  });
  return { owner, stdout: () => output };
}

async function readTreeInfo(infoFile: string): Promise<{ pid: number; port: number }> {
  const found = await waitUntil(() => {
    try {
      readFileSyncOnce(infoFile);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error("the fake tree never reported its descendant");
  return JSON.parse(await readFile(infoFile, "utf8")) as { pid: number; port: number };
}

function readFileSyncOnce(path: string): void {
  // Synchronous existence check so the poll loop stays cheap.
  if (!existsSync(path)) throw new Error("missing");
  const content = readFileSync(path, "utf8");
  if (!content.trim()) throw new Error("empty");
}

describe("Antigravity tree ownership", () => {
  const owners: ChildProcess[] = [];
  const directories: string[] = [];

  beforeAll(async () => {
    await chmod(treeFixture, 0o755);
  });

  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      if (!owner.killed) owner.kill("SIGKILL");
    }
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  test("terminates the detached tree when the owner is closed with SIGHUP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-tree-hup-"));
    directories.push(directory);
    const infoFile = join(directory, "tree.json");
    const { owner } = await startOwner(infoFile);
    owners.push(owner);

    const info = await readTreeInfo(infoFile);
    expect(isAlive(info.pid)).toBe(true);
    expect(await canConnect(info.port)).toBe(true);

    owner.kill("SIGHUP");

    expect(await waitUntil(() => !isAlive(info.pid))).toBe(true);
    expect(await canConnect(info.port)).toBe(false);
  });

  test("terminates the detached tree when the owner is closed with SIGINT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-tree-int-"));
    directories.push(directory);
    const infoFile = join(directory, "tree.json");
    const { owner } = await startOwner(infoFile);
    owners.push(owner);

    const info = await readTreeInfo(infoFile);
    expect(isAlive(info.pid)).toBe(true);

    owner.kill("SIGINT");

    expect(await waitUntil(() => !isAlive(info.pid))).toBe(true);
    expect(await canConnect(info.port)).toBe(false);
  });

  test("terminates the detached tree when the owner is closed with SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-tree-term-"));
    directories.push(directory);
    const infoFile = join(directory, "tree.json");
    const { owner } = await startOwner(infoFile);
    owners.push(owner);

    const info = await readTreeInfo(infoFile);
    expect(isAlive(info.pid)).toBe(true);

    owner.kill("SIGTERM");

    expect(await waitUntil(() => !isAlive(info.pid))).toBe(true);
    expect(await canConnect(info.port)).toBe(false);
  });

  test("terminates the detached tree when the owner exits normally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-tree-exit-"));
    directories.push(directory);
    const infoFile = join(directory, "tree.json");
    const { owner } = await startOwner(infoFile, "exit");
    owners.push(owner);

    const info = await readTreeInfo(infoFile);
    expect(isAlive(info.pid)).toBe(true);

    owner.stdin?.end();

    expect(await waitUntil(() => !isAlive(info.pid))).toBe(true);
    expect(await canConnect(info.port)).toBe(false);
  });

  test("terminates the detached tree and restores signal listeners when worker.stop() runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-tree-stop-"));
    directories.push(directory);
    const infoFile = join(directory, "tree.json");
    const { owner, stdout } = await startOwner(infoFile, "stop");
    owners.push(owner);

    const info = await readTreeInfo(infoFile);
    expect(isAlive(info.pid)).toBe(true);

    const exited = new Promise<number | null>((resolve) => {
      owner.once("exit", (code) => resolve(code));
    });
    owner.stdin?.end();
    expect(await exited).toBe(0);

    const baselineLine = stdout().split("\n").find((line) => line.startsWith("BASELINE "));
    const stoppedLine = stdout().split("\n").find((line) => line.startsWith("STOPPED "));
    expect(baselineLine).toBeDefined();
    expect(stoppedLine).toBeDefined();
    expect(stoppedLine!.replace("STOPPED ", "")).toBe(baselineLine!.replace("BASELINE ", ""));

    expect(await waitUntil(() => !isAlive(info.pid))).toBe(true);
    expect(await canConnect(info.port)).toBe(false);
  });
});
