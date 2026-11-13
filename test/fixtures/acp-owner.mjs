#!/usr/bin/env bun

import { AcpWorker } from "../../src/acp-process.ts";

// Stands in for the opencode process that owns an Antigravity tree. It is a
// separate process so a test can kill it with a real signal and observe what
// survives.
const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM", "exit"];
const counts = () => JSON.stringify(Object.fromEntries(SIGNALS.map((signal) => [signal, process.listenerCount(signal)])));

const executable = process.argv[2];
if (!executable) {
  process.stderr.write("acp-owner: missing ACP executable\n");
  process.exit(64);
}

process.stdout.write(`BASELINE ${counts()}\n`);

const worker = new AcpWorker({ cwd: process.cwd(), executableArgs: [], stallTimeoutMs: 10_000, printTimeoutMs: 10_000 }, executable);
await worker.start();
await new Promise((resolve) => process.stdout.write("READY\n", resolve));

const mode = process.env.FAKE_OWNER_MODE;
if (mode === "stop" || mode === "exit") {
  process.stdin.resume();
  process.stdin.once("end", async () => {
    if (mode === "stop") {
      await worker.stop(true);
      await new Promise((resolve) => process.stdout.write(`STOPPED ${counts()}\n`, resolve));
    }
    process.exit(0);
  });
}

setInterval(() => {}, 1_000);
