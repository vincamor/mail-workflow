const { describe, it, expect } = require('@jest/globals');
const { buildProviderRequest, validateOllamaApiKey, assertSafeProviderUrl } = require('../../src/services/aiService');

// ─────────────────────────────────────────────
//  buildProviderRequest
// ─────────────────────────────────────────────

describe('buildProviderRequest', () => {
  const baseMessages = [
    { role: 'user', content: 'Bonjour' },
  ];

  const baseArgs = {
    provider: 'openai',
    apiKey: 'sk-test-123',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com',
    messages: baseMessages,
    stream: false,
  };

  it('builds OpenAI request correctly', () => {
    const config = buildProviderRequest(baseArgs);
    expect(config.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(config.headers['Authorization']).toBe('Bearer sk-test-123');
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.body.model).toBe('gpt-4o');
    expect(config.body.messages).toEqual(baseMessages);
    expect(config.body.stream).toBe(false);
  });

  it('builds Ollama request (OpenAI-compatible format)', () => {
    const config = buildProviderRequest({
      ...baseArgs,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: 'ollama-key',
      model: 'llama3',
    });
    expect(config.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(config.headers['Authorization']).toBe('Bearer ollama-key');
    expect(config.body.model).toBe('llama3');
    expect(config.body.messages).toEqual(baseMessages);
  });

  it('builds Anthropic request with system message separated', () => {
    const messages = [
      { role: 'system', content: 'Tu es un assistant email.' },
      { role: 'user', content: 'Resume ce fil.' },
    ];
    const config = buildProviderRequest({
      ...baseArgs,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      messages,
    });
    expect(config.url).toBe('https://api.anthropic.com/v1/messages');
    expect(config.headers['x-api-key']).toBe('sk-ant-test');
    expect(config.headers['anthropic-version']).toBe('2023-06-01');
    expect(config.body.system).toBe('Tu es un assistant email.');
    expect(config.body.messages).toEqual([
      { role: 'user', content: 'Resume ce fil.' },
    ]);
    expect(config.body.max_tokens).toBe(4096);
  });

  it('builds Custom request (OpenAI format with custom URL)', () => {
    const config = buildProviderRequest({
      ...baseArgs,
      provider: 'custom',
      baseUrl: 'https://my-llm.example.com',
      apiKey: 'custom-key',
      model: 'my-model',
    });
    expect(config.url).toBe('https://my-llm.example.com/v1/chat/completions');
    expect(config.headers['Authorization']).toBe('Bearer custom-key');
    expect(config.body.model).toBe('my-model');
  });

  it('rejects unknown provider', () => {
    expect(() => buildProviderRequest({ ...baseArgs, provider: 'gemini' }))
      .toThrow('Provider non supporte');
  });

  it('rejects empty apiKey', () => {
    expect(() => buildProviderRequest({ ...baseArgs, apiKey: '' }))
      .toThrow('Cle API requise');
  });

  it('rejects empty model', () => {
    expect(() => buildProviderRequest({ ...baseArgs, model: '' }))
      .toThrow('Modele requis');
  });

  it('rejects empty baseUrl', () => {
    expect(() => buildProviderRequest({ ...baseArgs, baseUrl: '' }))
      .toThrow('URL du provider requise');
  });

  it('passes stream: true in body', () => {
    const config = buildProviderRequest({ ...baseArgs, stream: true });
    expect(config.body.stream).toBe(true);
  });

  it('handles Anthropic messages without system message', () => {
    const messages = [
      { role: 'user', content: 'Salut' },
    ];
    const config = buildProviderRequest({
      ...baseArgs,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      messages,
    });
    expect(config.body.system).toBeUndefined();
    expect(config.body.messages).toEqual(messages);
  });

  it('strips trailing slash from baseUrl', () => {
    const config = buildProviderRequest({
      ...baseArgs,
      baseUrl: 'https://api.openai.com/',
    });
    expect(config.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

// ─────────────────────────────────────────────
//  validateOllamaApiKey
// ─────────────────────────────────────────────

describe('validateOllamaApiKey', () => {
  const originalEnv = process.env.OLLAMA_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OLLAMA_API_KEY = originalEnv;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it('accepts any key when OLLAMA_API_KEY not defined', () => {
    delete process.env.OLLAMA_API_KEY;
    expect(validateOllamaApiKey('random-key')).toBe(true);
    expect(validateOllamaApiKey('')).toBe(true);
  });

  it('accepts correct key', () => {
    process.env.OLLAMA_API_KEY = 'my-secret-key';
    expect(validateOllamaApiKey('my-secret-key')).toBe(true);
  });

  it('rejects wrong key', () => {
    process.env.OLLAMA_API_KEY = 'my-secret-key';
    expect(validateOllamaApiKey('wrong-key')).toBe(false);
  });

  it('rejects empty key when OLLAMA_API_KEY is defined', () => {
    process.env.OLLAMA_API_KEY = 'my-secret-key';
    expect(validateOllamaApiKey('')).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  assertSafeProviderUrl — anti-SSRF (régression des bypass prouvés en revue)
//  Ces cas verrouillent notamment les formes IPv6 IPv4-mapped sérialisées en
//  hexa par new URL() (::ffff:127.0.0.1 -> ::ffff:7f00:1), qui échappaient à
//  l'ancienne regex dotted.
// ─────────────────────────────────────────────

describe('assertSafeProviderUrl (anti-SSRF)', () => {
  const blocked = [
    ['custom', 'http://[::ffff:127.0.0.1]:11434/', 'IPv6-mapped loopback'],
    ['custom', 'http://[::ffff:169.254.169.254]/', 'IPv6-mapped metadata cloud'],
    ['custom', 'http://[::ffff:a9fe:a9fe]/', 'IPv6-mapped metadata (hexa direct)'],
    ['ollama', 'http://[::ffff:127.0.0.1]:11434/', 'gate ALLOW_LOCAL_AI non contournable'],
    ['custom', 'http://[64:ff9b::7f00:1]/', 'NAT64 loopback'],
    ['custom', 'http://[::1]/', 'IPv6 loopback'],
    ['custom', 'http://[fe80::1]/', 'IPv6 link-local'],
    ['custom', 'http://[fc00::1]/', 'IPv6 ULA'],
    ['custom', 'http://2130706433/', 'IPv4 en décimal (127.0.0.1)'],
    ['custom', 'http://0x7f000001/', 'IPv4 en hexa (127.0.0.1)'],
    ['custom', 'http://api.openai.com@169.254.169.254/', 'userinfo trompeur'],
    ['custom', 'ftp://8.8.8.8/', 'protocole non http(s)'],
    ['openai', 'https://evil.example.com/', 'openai hors allowlist'],
    ['anthropic', 'http://api.anthropic.com/', 'anthropic sans https'],
  ];

  for (const [provider, url, label] of blocked) {
    it(`bloque : ${label}`, async () => {
      await expect(assertSafeProviderUrl(provider, url)).rejects.toThrow();
    });
  }

  const allowed = [
    ['custom', 'http://8.8.8.8/', 'IP publique littérale'],
    ['custom', 'http://[::ffff:8.8.8.8]/', 'IPv6-mapped vers IP publique'],
    ['custom', 'http://[2606:4700:4700::1111]/', 'IPv6 public'],
    ['openai', 'https://api.openai.com', 'openai domaine officiel'],
    ['anthropic', 'https://api.anthropic.com', 'anthropic domaine officiel'],
  ];

  for (const [provider, url, label] of allowed) {
    it(`autorise : ${label}`, async () => {
      await expect(assertSafeProviderUrl(provider, url)).resolves.toBeUndefined();
    });
  }

  it('autorise Ollama local uniquement si ALLOW_LOCAL_AI=true', async () => {
    const prev = process.env.ALLOW_LOCAL_AI;
    process.env.ALLOW_LOCAL_AI = 'true';
    await expect(assertSafeProviderUrl('ollama', 'http://127.0.0.1:11434/')).resolves.toBeUndefined();
    delete process.env.ALLOW_LOCAL_AI;
    await expect(assertSafeProviderUrl('ollama', 'http://127.0.0.1:11434/')).rejects.toThrow();
    if (prev !== undefined) process.env.ALLOW_LOCAL_AI = prev;
  });
});
