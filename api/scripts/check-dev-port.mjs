#!/usr/bin/env node

// Pre-dev port safety check: verifies that the port this API instance will
// actually bind is free, and fails loudly with an actionable message when it
// is not. It NEVER kills anything — killing whatever holds a hardcoded port
// destroyed parallel dev sessions binding a different NESSIE_API_PORT.
//
// Port resolution (first wins):
//   1. process.env.NESSIE_API_PORT
//   2. NESSIE_API_PORT from a simple KEY=VALUE parse of ../.env (repo root)
//   3. 5454 (the documented local dev default)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_ENV_PATH = path.join(API_DIR, '..', '.env');
const DEFAULT_PORT = 5454;

function readPortFromEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'NESSIE_API_PORT') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

function resolvePort() {
  const raw = process.env.NESSIE_API_PORT ?? readPortFromEnvFile(ROOT_ENV_PATH);
  if (raw == null) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `predev: NESSIE_API_PORT "${raw}" is not a valid port (1-65535); fix it before starting the dev server.`,
    );
    process.exit(1);
  }
  return port;
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      resolve({ free: false, code: err.code });
    });
    server.once('listening', () => {
      server.close(() => resolve({ free: true }));
    });
    server.listen({ port, host: '0.0.0.0' });
  });
}

function describeHolder(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const lines = out.split('\n');
    if (lines.length < 2) return null;
    // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const cols = lines[1].split(/\s+/);
    return { command: cols[0], pid: cols[1], detail: out };
  } catch {
    return null; // lsof unavailable or nothing matched
  }
}

const port = resolvePort();
const result = await probePort(port);

if (result.free) {
  process.exit(0);
}

if (result.code && result.code !== 'EADDRINUSE') {
  console.error(
    `predev: could not probe port ${port} (${result.code}); resolve this before starting the dev server.`,
  );
  process.exit(1);
}

console.error(`predev: port ${port} is already in use; this API instance cannot start.`);
const holder = describeHolder(port);
if (holder) {
  console.error(`predev: held by pid ${holder.pid} (${holder.command}):`);
  console.error(holder.detail);
  console.error(
    `predev: if that process is safe to stop, run: kill ${holder.pid}`,
  );
} else {
  console.error('predev: could not identify the holding process (lsof unavailable).');
  console.error(`predev: inspect it yourself with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
}
console.error(
  'predev: or point this instance elsewhere by setting NESSIE_API_PORT to a free port.',
);
process.exit(1);
