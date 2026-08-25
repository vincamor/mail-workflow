/**
 * aiService.js — Multi-provider LLM request building + Ollama API key validation
 * + validation anti-SSRF des baseUrl fournies par le client.
 */

const dns = require('dns').promises;
const net = require('net');

const OPENAI_COMPATIBLE_PROVIDERS = new Set(['openai', 'ollama', 'custom']);

// ─────────────────────────────────────────────
//  Anti-SSRF : validation des baseUrl client
//
//  Défense en couches :
//  - Les routes /api/ai/* exigent une session authentifiée (requireAuth) : le
//    proxy n'est PAS exposé anonymement à Internet.
//  - openai / anthropic : allowlist stricte de domaines officiels (https only).
//  - ollama : les hosts loopback (localhost:11434 etc.) ne sont acceptés que si
//    ALLOW_LOCAL_AI=true dans l'env (allowlist host:port, surchargeable via
//    LOCAL_AI_ALLOWED_HOSTS="host:port,host:port").
//  - ollama distant / custom : le hostname est résolu via DNS et TOUTES les
//    adresses retournées doivent être publiques (rejet loopback, RFC1918,
//    link-local/metadata 169.254.0.0/16, CGNAT, ::1, ::, fc00::/7, fe80::/10,
//    multicast, ET les formes IPv6 IPv4-mapped/compat/NAT64 quelle que soit
//    leur sérialisation — cf. isPrivateIPv6/ipv6ToBigInt).
//  - Les redirections sortantes sont refusées (redirect: 'manual' +
//    rejet des 3xx dans fetchWithTimeout) : un provider public ne peut pas
//    rediriger vers une IP privée/metadata non re-validée.
//  Résiduel accepté : un DNS rebinding (TOCTOU entre résolution et fetch) reste
//  théoriquement possible, mais seulement pour un utilisateur DÉJÀ authentifié
//  ciblant l'app self-hosted à laquelle il est connecté — risque très réduit vs
//  un open proxy anonyme. Mitigation complète = pin de l'IP validée (non fait).
// ─────────────────────────────────────────────

const PUBLIC_PROVIDER_HOSTS = {
  openai: new Set(['api.openai.com']),
  anthropic: new Set(['api.anthropic.com']),
};

// Hostnames metadata cloud connus, bloqués explicitement (défense en profondeur)
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true; // prudence
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;          // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true;                     // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16/12
  if (a === 192 && b === 168) return true;                     // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;           // 100.64/10 (CGNAT)
  if (a >= 224) return true;                                   // multicast/broadcast
  return false;
}

// Convertit une adresse IPv6 (toute forme : compressée, IPv4-mapped, -compat,
// NAT64, avec quad-pointé embarqué) en BigInt 128 bits. null si non parsable.
// NB : new URL() sérialise TOUJOURS les IPv4-mapped en hexa compressé
// (::ffff:127.0.0.1 -> ::ffff:7f00:1) — l'ancienne regex dotted les ratait.
function ipv6ToBigInt(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // quad-pointé embarqué en fin d'adresse -> convertir en deux hextets
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number);
    if (v4.some(n => n > 255)) return null;
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
  if (n === null) return true;                                // non parsable → refus
  if (n === 0n || n === 1n) return true;                      // :: et ::1
  const high96 = n >> 32n;
  const embeddedV4 = () => {
    const v = Number(n & 0xffffffffn);
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
  };
  // IPv4-mapped ::ffff:0:0/96, IPv4-compat ::/96, NAT64 64:ff9b::/96 → tester le v4
  const NAT64_PREFIX = 0x0064ff9bn << 64n;                    // 64:ff9b::/96 (96 bits de poids fort)
  if (high96 === 0xffffn || high96 === 0n || high96 === NAT64_PREFIX) {
    return isPrivateIPv4(embeddedV4());
  }
  const topByte = n >> 120n;
  if (topByte === 0xffn) return true;                         // ff00::/8 multicast
  if ((topByte & 0xfen) === 0xfcn) return true;               // fc00::/7 (ULA)
  if (((n >> 112n) & 0xffc0n) === 0xfe80n) return true;       // fe80::/10 (link-local)
  return false;
}

function isPrivateIp(ip) {
  const bare = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return isPrivateIPv4(bare);
  if (net.isIPv6(bare)) return isPrivateIPv6(bare);
  return true;                                                // forme inconnue → prudence
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' ||
    hostname === '::1' ||
    (net.isIPv4(hostname) && hostname.startsWith('127.'));
}

function getLocalAiAllowlist() {
  const raw = process.env.LOCAL_AI_ALLOWED_HOSTS || '127.0.0.1:11434,localhost:11434,[::1]:11434';
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Valide une baseUrl fournie par le client avant tout fetch côté serveur.
 * @param {string} provider - 'openai' | 'anthropic' | 'ollama' | 'custom'
 * @param {string} baseUrl
 * @throws {Error} avec statusCode 400 si l'URL est refusée
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
    reject('baseUrl invalide');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject('baseUrl doit utiliser http ou https');
  }

  const hostname = url.hostname.toLowerCase();
  // hostname IPv6 dans une URL est entre crochets — URL.hostname les retire déjà,
  // sauf le format [::1] qu'on normalise pour la comparaison allowlist
  const bareHost = hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(bareHost)) {
    reject('baseUrl refusée (endpoint interne)');
  }

  // Providers publics : allowlist stricte de domaines officiels
  if (provider === 'openai' || provider === 'anthropic') {
    if (url.protocol !== 'https:' || !PUBLIC_PROVIDER_HOSTS[provider].has(bareHost)) {
      reject(`baseUrl non autorisée pour le provider ${provider} (domaine officiel requis)`);
    }
    return;
  }

  // Ollama local : uniquement via allowlist explicite + flag env
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostPort = `${url.hostname}:${port}`.toLowerCase();
  if (isLoopbackHostname(bareHost)) {
    if (process.env.ALLOW_LOCAL_AI === 'true' && getLocalAiAllowlist().has(hostPort)) {
      return;
    }
    reject('baseUrl locale refusée — définir ALLOW_LOCAL_AI=true pour autoriser Ollama local (127.0.0.1:11434)');
  }

  // ollama distant / custom : résolution DNS + rejet des adresses privées
  let addresses;
  if (net.isIP(bareHost)) {
    addresses = [{ address: bareHost }];
  } else {
    try {
      addresses = await dns.lookup(bareHost, { all: true, verbatim: true });
    } catch {
      reject('baseUrl irrésoluble (DNS)');
    }
  }
  if (!addresses || addresses.length === 0) {
    reject('baseUrl irrésoluble (DNS)');
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      reject('baseUrl refusée (résout vers une adresse privée/loopback/link-local)');
    }
  }
}

// ─────────────────────────────────────────────
//  Fetch sortant avec timeout (AbortController)
// ─────────────────────────────────────────────

const OUTBOUND_TIMEOUT_MS = 30000;

/**
 * fetch avec timeout de 30s jusqu'à la réception des headers.
 * Le timer est annulé une fois la réponse reçue : le streaming du body
 * (chat SSE) n'est volontairement pas limité en durée.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = OUTBOUND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect: 'manual' — anti-SSRF : ne jamais suivre une redirection (un
    // provider public pourrait rediriger vers une IP privée/metadata que la
    // validation baseUrl n'a pas vue). Un caller peut surcharger via options.
    const res = await fetch(url, { redirect: 'manual', ...options, signal: controller.signal });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      const err = new Error('Redirection du provider refusée (anti-SSRF)');
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
  if (!apiKey) throw new Error('Cle API requise');
  if (!model) throw new Error('Modele requis');
  if (!baseUrl) throw new Error('URL du provider requise');

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      method: 'POST',
      url: `${cleanBaseUrl}/v1/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

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

  throw new Error('Provider non supporte');
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
