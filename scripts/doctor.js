#!/usr/bin/env node
'use strict';

/**
 * `npm run doctor` — non-interactive diagnostic for a Mail Workflow install.
 *
 * Read-only: it never writes a file, never prompts, and never mutates state.
 * Its output is meant to be pasted verbatim into a bug report, so it must not
 * leak secrets — only whether a variable is set, and its length.
 *
 * Exit code: 1 if any check FAILS, 0 otherwise. Warnings never fail the run.
 */

const os = require('node:os');

const {
  ENV_PATH,
  MIN_NODE_MAJOR,
  DEFAULT_PORT,
  GMAIL_CALLBACK_PATH,
  OUTLOOK_CALLBACK_PATH,
  OLLAMA_HOST,
  OLLAMA_PORT,
  color,
  ignoreEpipe,
  nodeMajor,
  readEnvFile,
  effectiveEnv,
  isBlank,
  parseUrlSafe,
  parseRedisUrl,
  tcpProbe,
  isPortFree,
} = require('./lib/env');

/** Width the check label is padded to, so every status line aligns. */
const LABEL_WIDTH = 26;

/** Indentation of the "Fix:" hint under a failing check. */
const FIX_INDENT = ' '.repeat(8);

/** Well-known placeholder secrets that must never reach a real install. */
const WEAK_SECRETS = new Set([
  'dev_secret',
  'devsecret',
  'secret',
  'changeme',
  'change_me',
  'password',
  'keyboard cat',
  'mysecret',
  'test',
  'todo',
]);

ignoreEpipe();

const say = (line = '') => process.stdout.write(`${line}\n`);

/** Running tally used for the final verdict and the summary counts. */
const tally = { ok: 0, warn: 0, fail: 0, skip: 0 };

const MARKERS = {
  ok: { text: '[ ok ]', paint: color.green },
  warn: { text: '[warn]', paint: color.yellow },
  fail: { text: '[fail]', paint: color.red },
  skip: { text: '[skip]', paint: color.dim },
};

/**
 * Print one aligned diagnostic line, plus an indented remedy when it is not ok.
 *
 * @param {'ok'|'warn'|'fail'|'skip'} status
 * @param {string} label Short check name.
 * @param {string} detail What was observed (never a secret value).
 * @param {string|string[]} [fix] Concrete action(s) the user should take.
 */
function report(status, label, detail, fix) {
  tally[status] += 1;
  const marker = MARKERS[status];
  say(`${marker.paint(marker.text)}  ${label.padEnd(LABEL_WIDTH)}  ${detail}`);
  if (fix) {
    const lines = Array.isArray(fix) ? fix : [fix];
    lines.forEach((line, index) => {
      const prefix = index === 0 ? 'Fix: ' : '     ';
      say(color.dim(`${FIX_INDENT}${prefix}${line}`));
    });
  }
}

/**
 * Print a section header.
 * @param {string} title
 */
function heading(title) {
  say();
  say(color.bold(title));
}

// --- Individual checks -------------------------------------------------------

/** Check 1 — the Node.js runtime satisfies package.json "engines". */
function checkNodeVersion() {
  const major = nodeMajor();
  if (major >= MIN_NODE_MAJOR) {
    report('ok', 'Node.js version', `${process.version} (>= ${MIN_NODE_MAJOR} required)`);
    return;
  }
  report('fail', 'Node.js version', `${process.version} — too old`, [
    `Install Node.js ${MIN_NODE_MAJOR} LTS or newer from https://nodejs.org/`,
    `With nvm: "nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}".`,
  ]);
}

/**
 * Check 2 — a .env file exists (or the configuration comes from the real
 * environment, which is normal on a PaaS).
 * @param {{exists: boolean, values: Record<string,string>}} envFile
 * @param {Record<string,string>} env Effective configuration.
 */
function checkEnvFile(envFile, env) {
  if (envFile.exists) {
    const count = Object.keys(envFile.values).length;
    report('ok', '.env file', `found (${count} variable${count === 1 ? '' : 's'})`);
    return;
  }
  const fromProcess = !isBlank(env.GMAIL_CLIENT_ID) || !isBlank(env.OUTLOOK_CLIENT_ID);
  if (fromProcess) {
    report('warn', '.env file', 'missing — using the process environment instead', [
      'That is expected on a hosting platform. Locally, run "npm run setup".',
    ]);
    return;
  }
  report('fail', '.env file', `not found at ${ENV_PATH}`, [
    'Run "npm run setup" to create it interactively,',
    'or copy .env.example to .env and fill in the values by hand.',
  ]);
}

/**
 * Check 3a — SESSION_SECRET is present, long enough and not a placeholder.
 * The value itself is never printed.
 * @param {Record<string,string>} env
 */
function checkSessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (isBlank(secret)) {
    report('fail', 'SESSION_SECRET', 'not set', [
      'The server refuses to start without it (unless NODE_ENV=development).',
      "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      'then put it in .env as SESSION_SECRET=<the value>. Or run "npm run setup".',
    ]);
    return;
  }
  if (WEAK_SECRETS.has(secret.trim().toLowerCase())) {
    report('warn', 'SESSION_SECRET', `set but looks like a placeholder (${secret.length} chars)`, [
      'Replace it with a random value:',
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    ]);
    return;
  }
  if (secret.length < 32) {
    report('warn', 'SESSION_SECRET', `set but short (${secret.length} chars, 32+ recommended)`, [
      'Regenerate a longer one:',
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    ]);
    return;
  }
  report('ok', 'SESSION_SECRET', `set (${secret.length} characters)`);
}

/**
 * Check 3b — the variables each enabled provider needs are all present.
 * @param {Record<string,string>} env
 * @returns {{gmail: boolean, outlook: boolean}} Which providers are enabled.
 */
function checkProviders(env) {
  const gmailKeys = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'];
  const outlookKeys = [
    'OUTLOOK_CLIENT_ID',
    'OUTLOOK_CLIENT_SECRET',
    'OUTLOOK_TENANT_ID',
    'OUTLOOK_REDIRECT_URI',
  ];
  // A provider counts as "enabled" as soon as one of its variables is set —
  // that way a half-filled block is reported instead of silently ignored.
  const gmail = gmailKeys.some((key) => !isBlank(env[key]));
  const outlook = outlookKeys.some((key) => !isBlank(env[key]));

  if (!gmail && !outlook) {
    report('fail', 'Email providers', 'none configured', [
      'Configure at least Gmail or Outlook: run "npm run setup".',
    ]);
    return { gmail, outlook };
  }

  /**
   * @param {string} label
   * @param {string[]} keys
   * @param {string} docs
   */
  const checkOne = (label, keys, docs) => {
    const missing = keys.filter((key) => isBlank(env[key]));
    if (missing.length === 0) {
      report('ok', label, `${keys.length} variables set`);
      return;
    }
    report('fail', label, `missing ${missing.join(', ')}`, [
      'Add the missing variable(s) to .env, or re-run "npm run setup".',
      `Where to find them: ${docs}`,
    ]);
  };

  if (gmail) {
    checkOne('Gmail credentials', gmailKeys, 'docs/setup/google-cloud.md');
    if (
      !isBlank(env.GMAIL_CLIENT_ID) &&
      !env.GMAIL_CLIENT_ID.endsWith('.apps.googleusercontent.com')
    ) {
      report('warn', 'Gmail client ID format', 'does not end with .apps.googleusercontent.com', [
        'Check you copied the OAuth "Client ID" from Google Cloud Console >',
        'Credentials, not the project number or the API key.',
      ]);
    }
  } else {
    report('skip', 'Gmail credentials', 'not configured');
  }

  if (outlook) {
    checkOne('Outlook credentials', outlookKeys, 'docs/setup/azure-ad.md');
  } else {
    report('skip', 'Outlook credentials', 'not configured');
  }

  return { gmail, outlook };
}

/**
 * Check 4 — THE consistency check.
 *
 * The single most common OAuth failure is a redirect URI that does not match
 * the port the server actually listens on, or that is missing the callback
 * path. Google/Microsoft then answer `redirect_uri_mismatch` with no useful
 * detail, so this is worth checking precisely.
 *
 * @param {Record<string,string>} env
 * @param {{gmail: boolean, outlook: boolean}} providers
 * @returns {number} The effective port the server will listen on.
 */
function checkConsistency(env, providers) {
  // Mirror src/app.js: PORT falls back to 3000, APP_ORIGIN to localhost:3000.
  const rawPort = isBlank(env.PORT) ? String(DEFAULT_PORT) : String(env.PORT).trim();
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    report('fail', 'PORT', `"${rawPort}" is not a valid port number`, [
      'Set PORT to a number between 1024 and 65535 in .env (e.g. PORT=3000).',
    ]);
    return DEFAULT_PORT;
  }
  report('ok', 'PORT', `${port}${isBlank(env.PORT) ? ' (default, PORT unset)' : ''}`);

  const rawOrigin = isBlank(env.APP_ORIGIN)
    ? `http://localhost:${DEFAULT_PORT}`
    : String(env.APP_ORIGIN).trim();
  const origin = parseUrlSafe(rawOrigin);

  if (!origin.ok) {
    report('fail', 'APP_ORIGIN', `"${rawOrigin}" is not a valid URL`, [
      `Set APP_ORIGIN=http://localhost:${port} in .env`,
      '(scheme + host + port, no trailing path).',
    ]);
    return port;
  }

  // APP_ORIGIN is what CORS allows, i.e. the URL the browser must use.
  // When it points at this machine, its port has to be the port we listen on.
  if (origin.isLocal && origin.port !== port) {
    report('fail', 'APP_ORIGIN vs PORT', `${origin.origin} but the server listens on ${port}`, [
      `Change APP_ORIGIN to http://localhost:${port} in .env,`,
      `or change PORT to ${origin.port}. They must be the same or the browser`,
      'requests will be blocked by CORS.',
    ]);
  } else if (origin.isLocal) {
    report('ok', 'APP_ORIGIN vs PORT', `${origin.origin} matches PORT=${port}`);
  } else {
    report('ok', 'APP_ORIGIN', `${origin.origin} (remote host — port need not match PORT)`);
  }

  // When APP_ORIGIN and PORT disagree on this machine, PORT is what the server
  // actually binds, so the suggested redirect URI must follow PORT. Otherwise
  // the two "Fix:" hints would contradict each other.
  const expectedOrigin =
    origin.isLocal && origin.port !== port ? `http://localhost:${port}` : origin.origin;

  /**
   * Validate one redirect URI against the expected origin, port and path.
   * @param {string} label
   * @param {string} key GMAIL_REDIRECT_URI or OUTLOOK_REDIRECT_URI.
   * @param {string} expectedPath
   * @param {string} console_ Where the same value must be registered.
   */
  const checkRedirect = (label, key, expectedPath, console_) => {
    const raw = env[key];
    const expected = `${expectedOrigin}${expectedPath}`;

    if (isBlank(raw)) {
      report('fail', label, 'not set', [
        `Add ${key}=${expected} to .env`,
        `and register the exact same URI in ${console_}.`,
      ]);
      return;
    }

    const uri = parseUrlSafe(raw);
    if (!uri.ok) {
      report('fail', label, `"${raw}" is not a valid URL`, [
        `Set ${key}=${expected} in .env`,
        `and register the exact same URI in ${console_}.`,
      ]);
      return;
    }

    const problems = [];
    if (uri.pathname !== expectedPath) {
      problems.push(`path is "${uri.pathname}" instead of "${expectedPath}"`);
    }
    if (uri.origin !== expectedOrigin) {
      problems.push(`origin is "${uri.origin}" instead of "${expectedOrigin}"`);
    }
    if (uri.isLocal && uri.port !== port) {
      problems.push(`port is ${uri.port} but the server listens on ${port}`);
    }

    if (problems.length === 0) {
      report('ok', label, uri.url.href);
      return;
    }

    report('fail', label, problems.join('; '), [
      `Set ${key}=${expected} in .env,`,
      `then register that EXACT string in ${console_}.`,
      'Both sides must match character for character (scheme, host, port, path,',
      'no trailing slash) or the provider answers "redirect_uri_mismatch".',
    ]);
  };

  if (providers.gmail) {
    checkRedirect(
      'GMAIL_REDIRECT_URI',
      'GMAIL_REDIRECT_URI',
      GMAIL_CALLBACK_PATH,
      'Google Cloud Console > Credentials > your OAuth client > Authorized redirect URIs'
    );
  } else {
    report('skip', 'GMAIL_REDIRECT_URI', 'Gmail not configured');
  }

  if (providers.outlook) {
    checkRedirect(
      'OUTLOOK_REDIRECT_URI',
      'OUTLOOK_REDIRECT_URI',
      OUTLOOK_CALLBACK_PATH,
      'Azure Portal > App registration > Authentication > Web > Redirect URIs'
    );
  } else {
    report('skip', 'OUTLOOK_REDIRECT_URI', 'Outlook not configured');
  }

  return port;
}

/**
 * Check 5 — the configured port is still bindable.
 * @param {number} port
 */
async function checkPortAvailable(port) {
  const { free, reason } = await isPortFree(port);
  if (free) {
    report('ok', `Port ${port}`, 'free');
    return;
  }
  if (reason === 'EACCES') {
    report('fail', `Port ${port}`, 'permission denied', [
      'Ports below 1024 need administrator rights. Pick a port >= 1024 in .env',
      '(and update APP_ORIGIN and the redirect URIs to match).',
    ]);
    return;
  }
  report('warn', `Port ${port}`, `already in use (${reason || 'EADDRINUSE'})`, [
    'If Mail Workflow is already running, this is expected.',
    `Otherwise find the process — Windows: netstat -ano | findstr :${port}`,
    `then taskkill /PID <pid> /F — macOS/Linux: lsof -i :${port} then kill <pid>.`,
    'Or change PORT in .env (and APP_ORIGIN + the redirect URIs with it).',
  ]);
}

/**
 * Check 6 — Redis reachability, without requiring the `redis` package.
 * @param {Record<string,string>} env
 */
async function checkRedis(env) {
  if (isBlank(env.REDIS_URL)) {
    report('warn', 'Redis', 'REDIS_URL not set — sessions are kept in memory', [
      'That is fine for local use, but restarting the server logs you out.',
      'For persistent sessions set REDIS_URL=redis://localhost:6379 in .env.',
    ]);
    return;
  }
  const parsed = parseRedisUrl(env.REDIS_URL);
  if (!parsed.ok) {
    report('fail', 'Redis', 'REDIS_URL is not a valid redis:// URL', [
      'Expected the form redis://[user:password@]host:port (or rediss:// for TLS).',
      'Example: REDIS_URL=redis://localhost:6379',
    ]);
    return;
  }
  const probe = await tcpProbe(parsed.host, parsed.port, 2000);
  if (probe.ok) {
    report('ok', 'Redis', `reachable at ${parsed.host}:${parsed.port}`);
    return;
  }
  report('fail', 'Redis', `unreachable at ${parsed.host}:${parsed.port} (${probe.reason})`, [
    'The server exits at startup when REDIS_URL is set but Redis is down.',
    'Start it (docker run -p 6379:6379 redis:7-alpine), fix the URL,',
    'or comment REDIS_URL out in .env to fall back to in-memory sessions.',
  ]);
}

/**
 * Check 7 — when local AI is allowed, Ollama should actually be listening.
 * @param {Record<string,string>} env
 */
async function checkOllama(env) {
  const enabled =
    String(env.ALLOW_LOCAL_AI || '')
      .trim()
      .toLowerCase() === 'true';
  if (!enabled) {
    report('skip', 'Ollama (local AI)', 'ALLOW_LOCAL_AI is not "true"');
    return;
  }
  const probe = await tcpProbe(OLLAMA_HOST, OLLAMA_PORT, 2000);
  if (probe.ok) {
    report('ok', 'Ollama (local AI)', `reachable at ${OLLAMA_HOST}:${OLLAMA_PORT}`);
    return;
  }
  report(
    'warn',
    'Ollama (local AI)',
    `not reachable at ${OLLAMA_HOST}:${OLLAMA_PORT} (${probe.reason})`,
    [
      'Install Ollama from https://ollama.com/, then run "ollama serve"',
      'and pull a model, e.g. "ollama pull llama3.1".',
      'If you do not use a local model, remove ALLOW_LOCAL_AI from .env.',
    ]
  );
}

/**
 * Check 8 — a production deployment pointing at localhost is a misconfiguration.
 * @param {Record<string,string>} env
 */
function checkNodeEnv(env) {
  const nodeEnv = isBlank(env.NODE_ENV) ? '' : String(env.NODE_ENV).trim();
  if (nodeEnv !== 'production') {
    report('ok', 'NODE_ENV', nodeEnv === '' ? 'not set (development defaults)' : nodeEnv);
    return;
  }

  const localish = ['APP_ORIGIN', 'GMAIL_REDIRECT_URI', 'OUTLOOK_REDIRECT_URI'].filter((key) => {
    if (isBlank(env[key])) return false;
    const parsed = parseUrlSafe(env[key]);
    return parsed.ok && parsed.isLocal;
  });

  if (localish.length === 0) {
    report('ok', 'NODE_ENV', 'production');
    return;
  }

  report('warn', 'NODE_ENV', `production, but ${localish.join(', ')} point at localhost`, [
    'In production these must use your public HTTPS origin, e.g.',
    'APP_ORIGIN=https://your-app.example.com and',
    'GMAIL_REDIRECT_URI=https://your-app.example.com/gmail/callback',
    '(register the same URIs in the provider console).',
    'If this machine is not a production host, remove NODE_ENV=production.',
  ]);
}

// --- Environment summary -----------------------------------------------------

/**
 * Resolve the npm version cheaply: `npm run doctor` exports it in the user
 * agent string, so no subprocess is needed in the common case.
 * @returns {string}
 */
function npmVersion() {
  const userAgent = process.env.npm_config_user_agent || '';
  const match = /npm\/(\S+)/.exec(userAgent);
  if (match) return match[1];
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('npm', ['-v'], {
      encoding: 'utf8',
      timeout: 5000,
      shell: process.platform === 'win32',
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    /* npm is not on PATH — not fatal for a diagnostic */
  }
  return 'unknown';
}

/** Print the block a user should copy into a bug report. */
function printEnvironmentSummary() {
  heading('Environment summary (paste this into a bug report)');
  const rows = [
    ['OS', `${os.type()} ${os.release()} (${process.platform})`],
    ['Arch', process.arch],
    ['Node.js', process.version],
    ['npm', npmVersion()],
    ['CPU cores', String(os.cpus().length || 'unknown')],
    ['Locale/TZ', Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'],
    ['Working dir', process.cwd()],
  ];
  const width = Math.max(...rows.map(([key]) => key.length));
  for (const [key, value] of rows) say(`  ${key.padEnd(width)}  ${value}`);
}

// --- Entry point -------------------------------------------------------------

async function main() {
  say();
  say(color.bold('Mail Workflow — doctor'));
  say(color.dim('Read-only diagnostic. Secret values are never printed.'));

  const envFile = readEnvFile(ENV_PATH);
  const env = effectiveEnv(envFile.values);

  heading('Runtime');
  checkNodeVersion();

  heading('Configuration');
  checkEnvFile(envFile, env);
  checkSessionSecret(env);
  const providers = checkProviders(env);

  heading('OAuth consistency');
  const port = checkConsistency(env, providers);

  heading('Services');
  await checkPortAvailable(port);
  await checkRedis(env);
  await checkOllama(env);
  checkNodeEnv(env);

  printEnvironmentSummary();

  heading('Result');
  say(
    `  ${tally.ok} ok · ${tally.warn} warning${tally.warn === 1 ? '' : 's'} · ` +
      `${tally.fail} failure${tally.fail === 1 ? '' : 's'} · ${tally.skip} skipped`
  );
  if (tally.fail > 0) {
    say(color.red('  Fix the [fail] lines above, then run "npm run doctor" again.'));
    say();
    return 1;
  }
  if (tally.warn > 0) {
    say(
      color.yellow('  No blocking problem. The warnings above are safe to ignore for local use.')
    );
    say();
    return 0;
  }
  say(color.green('  Everything looks good. Start the app with "npm start".'));
  say();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    say();
    say(color.red(`  doctor crashed: ${err && err.stack ? err.stack : err}`));
    say('  Fix: please open an issue with the message above.');
    process.exitCode = 1;
  });
