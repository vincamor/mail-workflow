#!/usr/bin/env node
/**
 * `npm run demo` — starts the app on the bundled sample dataset.
 *
 * No .env, no OAuth credentials, no account, no folder picking: the front-end
 * reads src/public/demo/*.jsonl through a fake file handle (see
 * src/public/js/demo.js) and never writes anything.
 *
 * src/app.js exits immediately unless SESSION_SECRET is set OR NODE_ENV is
 * "development" — and the whole point of the demo is that it runs with no .env
 * at all, so we set NODE_ENV here, BEFORE requiring the app.
 *
 * NODE_ENV is set in JS rather than with the `NODE_ENV=x node ...` shell prefix:
 * that syntax fails on Windows PowerShell and cmd, and cross-env would mean a new
 * dependency in a project that deliberately keeps its tree small.
 */

'use strict';

process.env.NODE_ENV = 'development';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATASET = path.join(__dirname, '..', 'src', 'public', 'demo', 'gmail_emails.jsonl');

if (!fs.existsSync(DATASET)) {
  console.error('Demo dataset missing:', DATASET);
  console.error('Regenerate it with: node scripts/generate-demo-data.js');
  process.exit(1);
}

// A real .env, if there is one, always wins: we load it first and only fill the
// gaps afterwards. dotenv is already a dependency of the app, so this adds none.
require('dotenv').config({ quiet: true });

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}/?demo=1`;

// No OAuth placeholders are needed here. The provider modules used to build an
// MSAL client at require() time, which threw on an empty secret and stopped the
// server from booting without a .env — precisely the situation this script
// exists to support. That dead client has been removed, so the app now loads
// with no credentials at all. Demo mode never walks an OAuth path anyway: no
// login screen, no /gmail or /outlook call.

require('../src/app.js');

// Let the server finish binding before we announce (and open) the URL.
setTimeout(() => {
  console.log('');
  console.log('  Mail Workflow — DEMO MODE');
  console.log('  Sample data, read-only. Nothing is written to disk.');
  console.log('');
  console.log(`  ${URL}`);
  console.log('');
  openBrowser(URL);
}, 400);

/** Best-effort browser launch — never fails the demo if it cannot open. */
function openBrowser(url) {
  if (process.env.DEMO_NO_OPEN) return;
  try {
    const cmd =
      process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [url] }
          : { file: 'xdg-open', args: [url] };
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser available — the URL above is enough */
    });
    child.unref();
  } catch (e) {
    /* best effort only */
  }
}
