#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Importing the fake ACP server keeps this process a protocol endpoint while it
// also owns a descendant listener, mirroring agy_acp_server.par plus
// localharness_external.
import "./fake-acp.mjs";

const listener = spawn(process.execPath, [fileURLToPath(new URL("./fake-tree-listener.mjs", import.meta.url))], { stdio: "ignore" });
listener.on("error", () => { /* the tree is only observable through pids */ });

// Stay alive after the owning process disappears: only a real signal may end
// this tree, so an orphan is visible to the test instead of exiting quietly.
setInterval(() => {}, 1_000);
process.on("exit", () => { try { listener.kill(); } catch { /* already gone */ } });
