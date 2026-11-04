/**
 * A logger that is safe inside an MCP stdio server.
 *
 * stdout carries JSON-RPC frames, so a single stray `console.log` corrupts the protocol and
 * the client sees a parse error instead of a reply. The bot's own logger writes to stdout,
 * which is right for a service and wrong here, so MCP code logs to stderr only.
 */

function format(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level}] [mcp] ${message}`;
}

export const mcpLog = {
  debug(message: string): void {
    if (process.env.MCP_LOG_LEVEL === "debug") {
      process.stderr.write(`${format("debug", message)}\n`);
    }
  },
  info(message: string): void {
    process.stderr.write(`${format("info", message)}\n`);
  },
  warn(message: string): void {
    process.stderr.write(`${format("warn", message)}\n`);
  },
  error(message: string): void {
    process.stderr.write(`${format("error", message)}\n`);
  },
};
