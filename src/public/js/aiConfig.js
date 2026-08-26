/**
 * Module de configuration du provider IA
 * Gestion de la persistance dans localStorage
 */

const STORAGE_KEY = 'mailproject-ai-config';

const PROVIDER_DEFAULTS = {
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:4b',
    placeholder: 'gemma3:4b, llama3.2, mistral...',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    placeholder: 'gpt-4o-mini, gpt-4o, o3-mini...',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    placeholder: 'claude-sonnet-4-20250514, claude-haiku-4-5-20251001...',
  },
  custom: { baseUrl: '', model: '', placeholder: 'nom du modele' },
};

export function getAIConfig() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Config IA corrompue dans localStorage, reset');
  }
  return { provider: 'ollama', apiKey: '', model: 'gemma3:4b', baseUrl: 'http://localhost:11434' };
}

export function saveAIConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearAIConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

export function getProviderDefaults(provider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
}

export async function testAIConnection(config) {
  try {
    const response = await fetch('/api/ai/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await response.json();
    if (response.ok) {
      return { ok: true, message: `Connecte a ${data.provider} (${data.model})` };
    }
    return { ok: false, message: data.error || 'Connexion echouee' };
  } catch (err) {
    return { ok: false, message: `Erreur reseau: ${err.message}` };
  }
}
