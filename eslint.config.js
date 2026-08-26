'use strict';

// eslint.config.js — Mail Workflow
//
// Philosophy: this project has no compiler and no bundler (see CLAUDE.md —
// "No build step"). The only automated net that catches a typo'd variable
// name, a stray `==`, or a `var` shadowing a loop is this linter. So this
// config is deliberately NOT a style enforcer — Prettier owns formatting
// (indentation, quotes, line length, trailing commas, …) and its rule set is
// applied last via `eslint-config-prettier` precisely so formatting rules
// never fight Prettier. What's left here is aimed at *real* errors:
// undefined variables (`no-undef`), unreachable/dead code, accidental
// double-equals, `var` instead of `let`/`const`.
//
// The codebase is ~22k lines of pre-existing code. Rules that would produce
// hundreds of pre-existing violations for near-zero bug-catching value
// (e.g. failing on unused `catch (e)` bindings, or on `console.log` in a
// project that logs deliberately both server- and client-side) are tuned
// down rather than left to blanket-fail `npm run lint` on day one.

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

// Rules shared by every JS config block below (kept small on purpose).
const commonRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': [
    'error',
    {
      // Codebase has many intentionally-unused function params (callback
      // signatures dictated by an external API) prefixed with `_`.
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      // Codebase has many `catch (e) {}` blocks that never touch `e`.
      // Flagging those would be hundreds of no-benefit errors.
      caughtErrors: 'none',
    },
  ],
  // This project logs deliberately to the console, both in the Express
  // backend (startup/diagnostic logs) and in the browser (debug traces
  // prefixed with emoji, e.g. "🔍 DEBUG: …"). Console output is a feature
  // here, not a lint smell.
  'no-console': 'off',
  // Many existing `catch (e) {}` blocks are intentionally empty (best-effort
  // cleanup, optional-feature detection, etc.).
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['warn', 'smart'],
  'no-var': 'error',
  'prefer-const': 'warn',
  // The one rule in this config most likely to catch a real bug in a
  // no-build, no-typecheck project: references to variables that don't
  // exist (typos, missing imports, globals not declared for this file's
  // environment).
  'no-undef': 'error',
};

module.exports = [
  // ─── Ignores (flat config has no separate .eslintignore) ───
  {
    ignores: [
      '**/node_modules/**',
      'package-lock.json',
      '**/*.jsonl',
      'src/public/demo/**',
      'coverage/**',
    ],
  },

  // ─── 1. Backend: src/**/*.js, CommonJS, Node globals ───
  // Excludes src/public/** (browser ES modules, handled below) and
  // src/services/emailAnalyzer_browser.js (dual-nature file, handled in its
  // own block below — see the comment there for why).
  {
    files: ['src/**/*.js'],
    ignores: ['src/public/**', 'src/services/emailAnalyzer_browser.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2023,
      globals: {
        ...globals.node,
      },
    },
    rules: commonRules,
  },

  // ─── 2. Front-end: src/public/**/*.js, ES modules, browser globals ───
  // src/public/js/package.json sets {"type":"module"} — these files use
  // native `import`/`export` and run unbundled in the browser.
  {
    files: ['src/public/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: {
        ...globals.browser,
      },
    },
    rules: commonRules,
  },

  // ─── 3. src/services/emailAnalyzer_browser.js — dual-nature file ───
  // Inspected the file directly: it ends with a plain `export default { … }`
  // block and contains NO `module.exports` — despite living under
  // src/services/ (a CommonJS directory with no package.json of its own),
  // its actual syntax is 100% ES module (only `export default`, no
  // `require`/`module.exports` anywhere in the file). It's also never
  // `require()`-d or dynamically `import()`-ed by Jest: tests/frontend/
  // progressiveLoading.test.js inlines a copy of its logic instead, with an
  // explicit comment "ES module can't be required directly in Jest/Node".
  // So Jest never parses this file at all — only the browser (via
  // `<script type="module">` / a relative import from src/public/js/app.js
  // as "/services/emailAnalyzer_browser.js") ever loads it.
  // Verdict: sourceType 'module' is the only choice that matches its real
  // syntax, and browser globals are correct since it runs client-side
  // (uses `atob`, `TextDecoder`, `FileSystemFileHandle`, etc.).
  {
    files: ['src/services/emailAnalyzer_browser.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: {
        ...globals.browser,
      },
    },
    rules: commonRules,
  },

  // ─── 4. tests/backend/** — CommonJS, Node + Jest globals ───
  {
    files: ['tests/backend/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2023,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: commonRules,
  },

  // ─── 5. tests/frontend/** — ES modules, Node + browser (jsdom) + Jest globals ───
  // These files load ESM front-end modules via dynamic `import()` inside
  // async Jest hooks/tests (some also `require('@jest/globals')` for the
  // test API itself — `require` is a Node global, not a keyword, so that's
  // valid regardless of sourceType) and run under `@jest-environment jsdom`,
  // exercising browser globals (window, document, structuredClone, …)
  // alongside Node ones.
  {
    files: ['tests/frontend/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.jest,
      },
    },
    rules: commonRules,
  },

  // ─── 6. scripts/**/*.js — CommonJS, Node globals ───
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2023,
      globals: {
        ...globals.node,
      },
    },
    rules: commonRules,
  },

  // ─── Prettier last: turn off any formatting-related rules so they never
  // conflict with `prettier --write` / `prettier --check`. ───
  prettierConfig,
];
