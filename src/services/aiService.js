/**
 * aiService.js — Multi-provider LLM request building + Ollama API key validation
 * + anti-SSRF validation of baseUrls provided by the client.
 */

const dns = require('dns').promises;
const net = require('net');

const OPENAI_COMPATIBLE_PROVIDERS = new Set(['openai', 'ollama', 'custom']);

// ─────────────────────────────────────────────
//  Anti-SSRF: validation of client baseUrls
//
//  Layered defense:
//  - Routes /api/ai/* require an authenticated session (requireAuth): the
//    proxy is NOT exposed anonymously to the Internet.
//  - openai / anthropic: strict allowlist of official domains (https only).
//  - ollama: loopback hosts (localhost:11434 etc.) are accepted only if
//    ALLOW_LOCAL_AI=true in the env (host:port allowlist, overridable via
//    LOCAL_AI_ALLOWED_HOSTS="host:port,host:port").
//  - ollama remote / custom: the hostname is resolved via DNS and ALL
//    returned addresses must be public (rejects loopback, RFC1918,
//    link-local/metadata 169.254.0.0/16, CGNAT, ::1, ::, fc00::/7, fe80::/10,
//    multicast, AND IPv6 forms IPv4-mapped/compat/NAT64 regardless of
//    their serialization — see isPrivateIPv6/ipv6ToBigInt).
//  - Outbound redirects are refused (redirect: 'manual' +
//    3xx rejection in fetchWithTimeout): a public provider cannot
//    redirect to a private/metadata IP without re-validation.
//  Accepted residual: a DNS rebinding (TOCTOU between resolution and fetch) remains
//  theoretically possible, but only for an ALREADY authenticated user
//  targeting the self-hosted app they are connected to — greatly reduced risk vs
//  an open anonymous proxy. Full mitigation = pinning the validated IP (not done).
// ─────────────────────────────────────────────

const PUBLIC_PROVIDER_HOSTS = {
  openai: new Set(['api.openai.com']),
  anthropic: new Set(['api.anthropic.com']),
};

// Known cloud metadata hostnames, explicitly blocked (defense in depth)
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // prudence
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a >= 224) return true; // multicast/broadcast
  return false;
}

// Converts an IPv6 address (any form: compressed, IPv4-mapped, -compat,
// NAT64, with embedded quad-dotted) to 128-bit BigInt. null if unparsable.
// NB: new URL() ALWAYS serializes IPv4-mapped as compressed hex
// (::ffff:127.0.0.1 -> ::ffff:7f00:1) — old dotted regex missed them.
function ipv6ToBigInt(ip) {
  let s = String(ip)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  // embedded quad-dotted at end of address -> convert to two hextets
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number);
    if (v4.some((n) => n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter(Boolean) : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function isPrivateIPv6(ip) {
  const n = ipv6ToBigInt(ip);
  if (n === null) return true; // unparsable → reject
  if (n === 0n || n === 1n) return true; // :: and ::1
  const high96 = n >> 32n;
  const embeddedV4 = () => {
    const v = Number(n & 0xffffffffn);
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
  };
  // IPv4-mapped ::ffff:0:0/96, IPv4-compat ::/96, NAT64 64:ff9b::/96 → test the v4
  const NAT64_PREFIX = 0x0064ff9bn << 64n; // 64:ff9b::/96 (96 high bits)
  if (high96 === 0xffffn || high96 === 0n || high96 === NAT64_PREFIX) {
    return isPrivateIPv4(embeddedV4());
  }
  const topByte = n >> 120n;
  if (topByte === 0xffn) return true; // ff00::/8 multicast
  if ((topByte & 0xfen) === 0xfcn) return true; // fc00::/7 (ULA)
  if (((n >> 112n) & 0xffc0n) === 0xfe80n) return true; // fe80::/10 (link-local)
  return false;
}

function isPrivateIp(ip) {
  const bare = String(ip)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return isPrivateIPv4(bare);
  if (net.isIPv6(bare)) return isPrivateIPv6(bare);
  return true; // unknown form → safety first
}

function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    (net.isIPv4(hostname) && hostname.startsWith('127.'))
  );
}

function getLocalAiAllowlist() {
  const raw = process.env.LOCAL_AI_ALLOWED_HOSTS || '127.0.0.1:11434,localhost:11434,[::1]:11434';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Validates a baseUrl provided by the client before any server-side fetch.
 * @param {string} provider - 'openai' | 'anthropic' | 'ollama' | 'custom'
 * @param {string} baseUrl
 * @throws {Error} with statusCode 400 if URL is rejected
 */
async function assertSafeProviderUrl(provider, baseUrl) {
  const reject = (msg) => {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  };

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    reject('invalid baseUrl');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject('baseUrl must use http or https');
  }

  const hostname = url.hostname.toLowerCase();
  // IPv6 hostname in a URL is in brackets — URL.hostname removes them already,
  // except [::1] format which we normalize for allowlist comparison
  const bareHost = hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(bareHost)) {
    reject('baseUrl rejected (internal endpoint)');
  }

  // Public providers: strict allowlist of official domains
  if (provider === 'openai' || provider === 'anthropic') {
    if (url.protocol !== 'https:' || !PUBLIC_PROVIDER_HOSTS[provider].has(bareHost)) {
      reject(`baseUrl not authorised for provider ${provider} (official domain required)`);
    }
    return;
  }

  // Local Ollama: only via explicit allowlist + env flag
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostPort = `${url.hostname}:${port}`.toLowerCase();
  if (isLoopbackHostname(bareHost)) {
    if (process.env.ALLOW_LOCAL_AI === 'true' && getLocalAiAllowlist().has(hostPort)) {
      return;
    }
    reject(
      'local baseUrl rejected — set ALLOW_LOCAL_AI=true to allow local Ollama (127.0.0.1:11434)'
    );
  }

  // remote ollama / custom: DNS resolution + rejection of private addresses
  let addresses;
  if (net.isIP(bareHost)) {
    addresses = [{ address: bareHost }];
  } else {
    try {
      addresses = await dns.lookup(bareHost, { all: true, verbatim: true });
    } catch {
      reject('baseUrl unresolvable (DNS)');
    }
  }
  if (!addresses || addresses.length === 0) {
    reject('baseUrl unresolvable (DNS)');
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      reject('baseUrl rejected (resolves to a private/loopback/link-local address)');
    }
  }
}

// ─────────────────────────────────────────────
//  Outbound fetch with timeout (AbortController)
// ─────────────────────────────────────────────

const OUTBOUND_TIMEOUT_MS = 30000;

/**
 * fetch with 30s timeout until header reception.
 * Timer is cancelled once response is received: body streaming
 * (chat SSE) is intentionally not time-limited.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = OUTBOUND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect: 'manual' — anti-SSRF: never follow a redirect (a
    // public provider could redirect to a private/metadata IP that
    // baseUrl validation did not see). A caller can override via options.
    const res = await fetch(url, { redirect: 'manual', ...options, signal: controller.signal });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      const err = new Error('Provider redirect rejected (anti-SSRF)');
      err.statusCode = 502;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an HTTP request config for the given LLM provider.
 * @param {Object} opts
 * @param {'openai'|'ollama'|'custom'|'anthropic'} opts.provider
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.baseUrl
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {boolean} opts.stream
 * @returns {{ url: string, headers: Object, body: Object, method: string }}
 */
function buildProviderRequest({ provider, apiKey, model, baseUrl, messages, stream }) {
  if (!apiKey) throw new Error('API key required');
  if (!model) throw new Error('Model required');
  if (!baseUrl) throw new Error('Provider URL required');

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      method: 'POST',
      url: `${cleanBaseUrl}/v1/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        messages,
        stream: !!stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      },
    };
  }

  if (provider === 'anthropic') {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body = {
      model,
      messages: nonSystemMessages,
      max_tokens: 4096,
      stream: !!stream,
    };
    if (systemMsg) {
      body.system = systemMsg.content;
    }

    return {
      method: 'POST',
      url: `${cleanBaseUrl}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    };
  }

  throw new Error('Unsupported provider');
}

/**
 * Send a request to the LLM provider.
 * @param {{ url: string, headers: Object, body: Object, method: string }} config
 * @returns {Promise<Response>}
 */
async function sendToProvider(config) {
  const response = await fetchWithTimeout(config.url, {
    method: config.method,
    headers: config.headers,
    body: JSON.stringify(config.body),
  });
  return response;
}

/**
 * Validate an API key for Ollama access.
 * If OLLAMA_API_KEY env var is not set, any key is accepted.
 * @param {string} apiKey
 * @returns {boolean}
 */
function validateOllamaApiKey(apiKey) {
  const envKey = process.env.OLLAMA_API_KEY;
  if (envKey === undefined) return true;
  return apiKey === envKey;
}

module.exports = {
  buildProviderRequest,
  sendToProvider,
  validateOllamaApiKey,
  assertSafeProviderUrl,
  fetchWithTimeout,
};
