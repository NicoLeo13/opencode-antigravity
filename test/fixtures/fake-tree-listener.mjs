#!/usr/bin/env bun

import fs from "node:fs";
import { createServer } from "node:net";

// Descendant of the fake ACP server. It shares the detached process group with
// its parent, so only a group-wide signal can terminate it, and it holds a
// localhost socket that must be released when the tree dies.
const infoFile = process.env.FAKE_TREE_INFO_FILE;
const server = createServer((socket) => socket.end());
server.on("error", () => process.exit(1));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (infoFile) fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port }));
});
setInterval(() => {}, 1_000);
