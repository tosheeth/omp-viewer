import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_DIR = join(homedir(), ".omp-viewer");
const TOKEN_FILE = join(TOKEN_DIR, "token");

/**
 * Shared secret gating the dashboard WebSocket. The server and every
 * connecting party (extension, popup) independently derive the same path
 * and read-or-create the same token — no IPC needed to agree on it, the
 * same way the server port itself needs no discovery file.
 *
 * Without this, any local process that can reach 127.0.0.1:<port> could
 * connect and read session cwd/todo state (or, once ask-tool answering
 * ships, answer the model's questions on your behalf). The token file is
 * written under the user's home directory, which on both Windows (NTFS
 * per-profile ACLs) and Linux (mode 0600) is not readable by other local
 * accounts by default.
 */
export function getOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const token = randomBytes(24).toString("hex");
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
