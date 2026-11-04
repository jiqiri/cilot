#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mcpLog } from "./log.js";
import { createProtocol } from "./protocol.js";
import { tools } from "./tools/index.js";

/**
 * A local MCP server for the tools OpenCode V2 can no longer load from a directory.
 *
 * V1 let an installation drop TypeScript files into `tools/` and the server compiled and ran
 * them. V2 has no such hook: its config exposes plugins, MCP servers and skills, and nothing
 * that executes a file from a user directory. So the three tools that were files become one
 * MCP server, registered in the V2 config, and OpenCode starts it as it would any other
 * local MCP.
 *
 * Transport is stdio, one JSON-RPC 2.0 document per line, which is what
 * `Mcp.LocalConfigEncoded` starts. The protocol itself lives in `protocol.ts`; this module
 * only connects it to the process streams.
 *
 * Nothing here writes to stdout except protocol frames. Tool output, including a generated
 * image, travels inside the reply as MCP content.
 */

function main(): void {
  // Safety net: a stray console.log anywhere in a dependency would land in the middle of a
  // protocol frame and break the stream for every later call.
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);

  mcpLog.info(`started (pid ${process.pid}, ${tools.length} tools)`);

  const protocol = createProtocol(tools, {
    write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log: mcpLog,
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    void protocol.handleLine(trimmed);
  });

  lines.on("close", () => {
    protocol.abortAll();
    mcpLog.info("stdin closed, exiting");
    process.exit(0);
  });

  process.stdout.on("error", () => process.exit(0));
}

main();
