// Loads the REAL src/services/emailAnalyzer_browser.js, not a copy of it.
//
// That file is an ES module served as-is to the browser, but it lives outside
// src/public/js/ (which carries the package.json `"type":"module"` marker), so
// Node sees it as CommonJS and refuses its `export default`. We evaluate it as
// an ES module inside a vm context instead.
//
// This helper exists because tests used to work around that by inlining copies
// of the analyzer's functions. A copied test passes while the real code is
// broken, which is worse than no test — and the analyzer produces the
// {nodes, links} shape the whole visualisation depends on.
//
// The vm context supplies only the browser globals the module actually touches.
// If the analyzer starts using another global, the failure will be explicit
// here rather than silently diverging from production.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ANALYZER = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'services',
  'emailAnalyzer_browser.js'
);

/**
 * @returns {Promise<object>} the analyzer's default export, evaluated from the
 *   production source file.
 */
async function loadRealAnalyzer() {
  const source = fs.readFileSync(ANALYZER, 'utf8');
  const context = vm.createContext({
    console,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape,
    unescape,
  });
  const mod = new vm.SourceTextModule(source, { context, identifier: ANALYZER });
  await mod.link(() => {
    throw new Error('emailAnalyzer_browser.js must have no imports');
  });
  await mod.evaluate();
  return mod.namespace.default;
}

module.exports = { loadRealAnalyzer, ANALYZER };
