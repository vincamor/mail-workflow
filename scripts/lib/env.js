'use strict';

/**
 * Shared helpers for `scripts/setup.js` and `scripts/doctor.js`.
 *
 * Constraints (deliberate):
 *  - Node built-ins only: these scripts must run BEFORE `npm install`.
 *  - CommonJS, like the rest of the backend.
 *  - No ANSI escapes unless stdout is a TTY and NO_COLOR is unset, so the
 *    output stays readable in cmd.exe, PowerShell, CI logs and pipes.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// --- Paths & constants -------------------------------------------------------

/** Repository root (scripts/lib/env.js -> scripts/ -> root). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_BACKUP_PATH = path.join(PROJECT_ROOT, '.env.bak');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');

/** Minimum supported Node.js major version (see package.json "engines"). */
const MIN_NODE_MAJOR = 20;

/** Port used by `src/app.js` when PORT is unset. */
const DEFAULT_PORT = 3000;

/** Callback paths mounted by src/routes/gmail.js and src/routes/outlook.js. */
const GMAIL_CALLBACK_PATH = '/gmail/callback';
const OUTLOOK_CALLBACK_PATH = '/outlook/callback';

/** Default local Ollama endpoint allowed by the anti-SSRF guard. */
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

/** Every variable the setup wizard is allowed to manage in .env. */
const MANAGED_KEYS = [
  'SESSION_SECRET',
  'APP_ORIGIN',
  'REDIS_URL',
  'PORT',
  'NODE_ENV',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REDIRECT_URI',
  'OUTLOOK_CLIENT_ID',
  'OUTLOOK_CLIENT_SECRET',
  'OUTLOOK_TENANT_ID',
  'OUTLOOK_REDIRECT_URI',
  'ALLOW_LOCAL_AI',
  'OLLAMA_API_KEY',
];

// --- Colors (TTY + NO_COLOR guarded) ----------------------------------------

const COLOR_ENABLED =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

/**
 * Wrap `text` in an SGR code, or return it untouched when colors are disabled.
 * @param {string} code SGR parameter (e.g. '32').
 * @param {string} text
 * @returns {string}
 */
function paint(code, text) {
  return COLOR_ENABLED ? `\u001b[${code}m${text}\u001b[0m` : String(text);
}

/** Minimal color palette. Every function is a no-op when colors are disabled. */
const color = {
  bold: (t) => paint('1', t),
  dim: (t) => paint('2', t),
  red: (t) => paint('31', t),
  green: (t) => paint('32', t),
  yellow: (t) => paint('33', t),
  blue: (t) => paint('34', t),
  cyan: (t) => paint('36', t),
};

// --- Node version ------------------------------------------------------------

/**
 * @returns {number} The running Node.js major version.
 */
function nodeMajor() {
  return Number.parseInt(process.versions.node.split('.')[0], 10);
}

/**
 * @returns {boolean} True when the running Node.js satisfies the engine floor.
 */
function isNodeSupported() {
  return nodeMajor() >= MIN_NODE_MAJOR;
}

// --- .env parsing / rendering ------------------------------------------------

/**
 * Strip a single pair of surrounding quotes, if present.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse dotenv-style content. Intentionally minimal (no interpolation, no
 * multi-line values) — it only needs to read files this project writes.
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnv(content) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = unquote(line.slice(eq + 1).trim());
    // Drop an unquoted trailing comment (` # ...`), like dotenv does.
    if (!/^["']/.test(line.slice(eq + 1).trim())) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }
  return values;
}

/**
 * Read and parse a dotenv file.
 * @param {string} [file] Defaults to the project's .env.
 * @returns {{exists: boolean, raw: string, values: Record<string, string>}}
 */
function readEnvFile(file = ENV_PATH) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { exists: true, raw, values: parseEnv(raw) };
  } catch {
    return { exists: false, raw: '', values: {} };
  }
}

/**
 * Merge file values with the real process environment. A variable exported in
 * the shell wins over the file — that is how `dotenv` behaves at runtime.
 * @param {Record<string, string>} fileValues
 * @returns {Record<string, string>}
 */
function effectiveEnv(fileValues) {
  /** @type {Record<string, string>} */
  const merged = { ...fileValues };
  for (const key of MANAGED_KEYS) {
    const fromProcess = process.env[key];
    if (typeof fromProcess === 'string' && fromProcess !== '') {
      merged[key] = fromProcess;
    }
  }
  return merged;
}

/**
 * @param {unknown} value
 * @returns {boolean} True when the value should be treated as "not configured".
 */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Quote a value only when it needs it, so the generated .env stays readable.
 * @param {string} value
 * @returns {string}
 */
function formatValue(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (clean === '') return '';
  if (/[\s#"']/.test(clean)) {
    return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return clean;
}

/**
 * Render a .env file from the .env.example template, preserving its comments,
 * section headers and variable order.
 *
 * Rules:
 *  - An active `KEY=` line whose key has a value becomes `KEY=<value>`.
 *  - An active `KEY=default` line whose key has NO value is commented out
 *    (`# KEY=default`) so the template's documentation survives without adding
 *    empty-variable noise.
 *  - A commented `# KEY=example` line is uncommented only when a value exists.
 *  - Keys absent from the template are appended in a trailing section.
 *
 * @param {string} templateText Content of .env.example.
 * @param {Record<string, string>} values Key -> value ('' means "leave unset").
 * @returns {string} The full .env content, newline-terminated.
 */
function renderEnvFromTemplate(templateText, values) {
  const activeRe = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
  const commentedRe = /^(\s*)#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
  const used = new Set();

  const lines = String(templateText)
    .split(/\r?\n/)
    .map((line) => {
      const active = activeRe.exec(line);
      if (active) {
        const [, indent, key, templateDefault] = active;
        if (!(key in values)) return line;
        used.add(key);
        if (isBlank(values[key])) {
          // Keep the template's own default visible, but commented out.
          return `${indent}# ${key}=${templateDefault.trim()}`;
        }
        return `${indent}${key}=${formatValue(values[key])}`;
      }

      const commented = commentedRe.exec(line);
      if (commented) {
        const [, indent, key] = commented;
        if (!(key in values) || isBlank(values[key])) return line;
        used.add(key);
        return `${indent}${key}=${formatValue(values[key])}`;
      }

      return line;
    });

  const extras = Object.keys(values).filter(
    (key) => !used.has(key) && !isBlank(values[key])
  );
  if (extras.length > 0) {
    lines.push('');
    lines.push('# --- Added by `npm run setup` ---');
    for (const key of extras) lines.push(`${key}=${formatValue(values[key])}`);
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// --- URL helpers -------------------------------------------------------------

/**
 * @param {string} protocol e.g. 'http:'
 * @returns {number|null}
 */
function defaultPortForProtocol(protocol) {
  if (protocol === 'http:') return 80;
  if (protocol === 'https:') return 443;
  return null;
}

/**
 * Parse a URL, returning a normalized description instead of throwing.
 * @param {string} value
 * @returns {{ok: boolean, url?: URL, origin?: string, port?: number|null, pathname?: string, isLocal?: boolean}}
 */
function parseUrlSafe(value) {
  try {
    const url = new URL(String(value).trim());
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : defaultPortForProtocol(url.protocol);
    const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      url.hostname.toLowerCase()
    );
    return {
      ok: true,
      url,
      origin: url.origin,
      port,
      pathname: url.pathname.replace(/\/+$/, '') || '/',
      isLocal,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Extract host/port from a redis:// or rediss:// URL.
 * @param {string} value
 * @returns {{ok: boolean, host?: string, port?: number}}
 */
function parseRedisUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['redis:', 'rediss:'].includes(url.protocol)) return { ok: false };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return { ok: false };
    return { ok: true, host, port: url.port ? Number.parseInt(url.port, 10) : 6379 };
  } catch {
    return { ok: false };
  }
}

/**
 * Build the redirect URIs matching a given port, for a localhost install.
 * @param {number|string} port
 * @returns {{gmail: string, outlook: string, origin: string}}
 */
function localUris(port) {
  const origin = `http://localhost:${port}`;
  return {
    origin,
    gmail: `${origin}${GMAIL_CALLBACK_PATH}`,
    outlook: `${origin}${OUTLOOK_CALLBACK_PATH}`,
  };
}

// --- Network probes (read-only) ---------------------------------------------

/**
 * Attempt a TCP connection. Never throws.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', (err) => finish({ ok: false, reason: err.code || err.message }));
  });
}

/**
 * Check whether a TCP port can still be bound, on one address. The listener is
 * released immediately — this has no lasting side effect.
 * @param {number} port
 * @param {string} host
 * @param {number} [timeoutMs]
 * @returns {Promise<{free: boolean, reason?: string}>}
 */
function isPortFreeOn(port, host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const server = net.createServer();
    const timer = setTimeout(() => finish({ free: true, reason: 'timeout' }), timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    server.once('error', (err) => finish({ free: false, reason: err.code || err.message }));
    server.once('listening', () => finish({ free: true }));
    try {
      server.listen({ port, host, exclusive: true });
    } catch (err) {
      finish({ free: false, reason: err.code || err.message });
    }
  });
}

/**
 * Check that a port is free on every address the server could bind. Windows
 * lets 0.0.0.0 and 127.0.0.1 be bound independently, so both are tested.
 * @param {number} port
 * @returns {Promise<{free: boolean, reason?: string}>}
 */
async function isPortFree(port) {
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const result = await isPortFreeOn(port, host);
    if (!result.free) return result;
  }
  return { free: true };
}

/**
 * Swallow EPIPE on stdout so piping the output ("npm run doctor | head")
 * never produces a crash dump instead of a diagnostic.
 */
function ignoreEpipe() {
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
  process.stderr.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

module.exports = {
  // paths & constants
  PROJECT_ROOT,
  ENV_PATH,
  ENV_BACKUP_PATH,
  ENV_EXAMPLE_PATH,
  MIN_NODE_MAJOR,
  DEFAULT_PORT,
  GMAIL_CALLBACK_PATH,
  OUTLOOK_CALLBACK_PATH,
  OLLAMA_HOST,
  OLLAMA_PORT,
  MANAGED_KEYS,
  // output
  COLOR_ENABLED,
  color,
  ignoreEpipe,
  // node
  nodeMajor,
  isNodeSupported,
  // env files
  parseEnv,
  readEnvFile,
  effectiveEnv,
  isBlank,
  formatValue,
  renderEnvFromTemplate,
  // urls
  defaultPortForProtocol,
  parseUrlSafe,
  parseRedisUrl,
  localUris,
  // network
  tcpProbe,
  isPortFree,
};
