const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { buildProviderRequest, sendToProvider, validateOllamaApiKey, assertSafeProviderUrl, fetchWithTimeout } = require('../services/aiService');
const { requireAuth } = require('../middleware/authMiddleware');

// Rate-limit sur tout /api/ai/* (même pattern que routes/gmail.js).
// 60 req/min : assez large pour le filtrage IA par batches, bloque l'abus open-proxy.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes IA. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false
});
router.use(aiLimiter);

// Auth obligatoire : le proxy IA n'est jamais exposé anonymement (défense
// principale contre l'abus open-proxy/SSRF — cf. aiService.js).
router.use(requireAuth);

/**
 * Valide la baseUrl client (anti-SSRF) — répond 400 et retourne false si refusée.
 */
async function ensureSafeBaseUrl(res, provider, baseUrl) {
  try {
    await assertSafeProviderUrl(provider, baseUrl);
    return true;
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
    return false;
  }
}

/**
 * POST /api/ai/model-info
 * Retrieve model context window size from the provider
 * Body: { provider, apiKey, model, baseUrl }
 */
router.post('/model-info', async (req, res) => {
  const { provider, apiKey, model, baseUrl } = req.body;

  if (!provider || !model || !baseUrl) {
    return res.status(400).json({ error: 'provider, model et baseUrl requis' });
  }

  if (!(await ensureSafeBaseUrl(res, provider, baseUrl))) return;

  // Ollama: use /api/show to get model info
  if (provider === 'ollama') {
    if (apiKey && !validateOllamaApiKey(apiKey)) {
      return res.status(401).json({ error: 'Cle API Ollama invalide' });
    }
    try {
      const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
      const response = await fetchWithTimeout(`${cleanBaseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model })
      });
      if (!response.ok) {
        return res.json({ contextLength: 8192, source: 'default' });
      }
      const data = await response.json();
      // Ollama returns model_info with context_length or num_ctx in parameters
      let contextLength = 8192;
      if (data.model_info) {
        // Look for context length keys in model_info
        for (const [key, value] of Object.entries(data.model_info)) {
          if (key.includes('context_length') && typeof value === 'number') {
            contextLength = value;
            break;
          }
        }
      }
      // Also check parameters for num_ctx
      if (data.parameters) {
        const numCtxMatch = data.parameters.match(/num_ctx\s+(\d+)/);
        if (numCtxMatch) contextLength = parseInt(numCtxMatch[1]);
      }
      return res.json({ contextLength, source: 'ollama', model });
    } catch (err) {
      return res.json({ contextLength: 8192, source: 'default' });
    }
  }

  // OpenAI: known context sizes for common models
  if (provider === 'openai') {
    const openaiContextSizes = {
      'gpt-4o': 128000,
      'gpt-4o-mini': 128000,
      'gpt-4-turbo': 128000,
      'gpt-4': 8192,
      'gpt-3.5-turbo': 16385,
      'o3-mini': 128000,
    };
    const contextLength = openaiContextSizes[model] || 128000;
    return res.json({ contextLength, source: 'openai-known', model });
  }

  // Anthropic: known context sizes
  if (provider === 'anthropic') {
    return res.json({ contextLength: 200000, source: 'anthropic-known', model });
  }

  // Custom: default to 8192 (conservative)
  return res.json({ contextLength: 8192, source: 'default', model });
});

// POST /api/ai/health — Test connection to the AI provider
router.post('/health', async (req, res) => {
  const { provider, apiKey, model, baseUrl } = req.body;

  if (!provider || !apiKey || !model || !baseUrl) {
    return res.status(400).json({ error: 'Champs requis : provider, apiKey, model, baseUrl' });
  }

  if (!(await ensureSafeBaseUrl(res, provider, baseUrl))) return;

  if (provider === 'ollama' && !validateOllamaApiKey(apiKey)) {
    return res.status(401).json({ error: 'Cle API Ollama invalide' });
  }

  try {
    const requestConfig = buildProviderRequest({
      provider,
      apiKey,
      model,
      baseUrl,
      messages: [{ role: 'user', content: 'Dis juste "OK".' }],
      stream: false,
    });

    const response = await sendToProvider(requestConfig);

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: `Connexion echouee: ${response.status} ${text}` });
    }

    return res.json({ status: 'ok', provider, model });
  } catch (err) {
    return res.status(502).json({ error: `Connexion echouee: ${err.message}` });
  }
});

// POST /api/ai/chat — Proxy to AI provider with streaming SSE
router.post('/chat', async (req, res) => {
  const { provider, apiKey, model, baseUrl, messages, stream = true } = req.body;

  if (!provider || !apiKey || !model || !baseUrl || !messages) {
    return res.status(400).json({ error: 'Champs requis : provider, apiKey, model, baseUrl, messages' });
  }

  if (!(await ensureSafeBaseUrl(res, provider, baseUrl))) return;

  if (provider === 'ollama' && !validateOllamaApiKey(apiKey)) {
    return res.status(401).json({ error: 'Cle API Ollama invalide' });
  }

  try {
    const requestConfig = buildProviderRequest({
      provider,
      apiKey,
      model,
      baseUrl,
      messages,
      stream,
    });

    const response = await sendToProvider(requestConfig);

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: `Connexion echouee: ${response.status} ${text}` });
    }

    // Non-streaming mode: return full JSON response
    if (!stream) {
      const data = await response.json();
      return res.json(data);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const body = response.body;

    // Handle client disconnect
    req.on('close', () => {
      if (body && typeof body.destroy === 'function') {
        body.destroy();
      } else if (body && typeof body.cancel === 'function') {
        body.cancel();
      }
    });

    // Node 18+ fetch returns a web ReadableStream — pipe via async iteration
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      try {
        for await (const chunk of body) {
          if (res.writableEnded) break;
          res.write(chunk);
        }
      } catch (err) {
        if (!res.writableEnded) {
          console.error('Stream error:', err.message);
        }
      }
      if (!res.writableEnded) res.end();
    } else if (body && typeof body.on === 'function') {
      // Node.js Readable stream
      body.on('data', (chunk) => res.write(chunk));
      body.on('end', () => res.end());
      body.on('error', (err) => {
        console.error('Stream error:', err.message);
        if (!res.writableEnded) res.end();
      });
    } else {
      // Fallback: read entire response
      const text = await response.text();
      res.write(text);
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      return res.status(502).json({ error: `Connexion echouee: ${err.message}` });
    }
    res.end();
  }
});

module.exports = router;
