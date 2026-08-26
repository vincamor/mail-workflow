/**
 * @jest-environment jsdom
 */
// Polyfill structuredClone for jsdom (Node 18 has it, jsdom does not expose to globals)
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}
require('fake-indexeddb/auto');
const { describe, test, expect, beforeAll } = require('@jest/globals');

describe('aiChat — buildInitialContext', () => {
  let buildInitialContext;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/aiChat.js');
    buildInitialContext = mod.buildInitialContext;
  });

  test('formats header with subject and counts', () => {
    const emails = [
      { date: 1712000000000, from: 'a@x.com', bodyText: 'hello' },
      { date: 1712100000000, from: 'b@x.com', bodyText: 'world' },
    ];
    const ctx = buildInitialContext('Projet Alpha', emails, 2);
    expect(ctx).toContain('# Thread : Projet Alpha');
    expect(ctx).toContain('# 2 mails envoyes (sur 2 au total)');
  });

  test('sorts emails descending by date', () => {
    const emails = [
      { date: 1000, from: 'old@x.com', bodyText: 'OLD' },
      { date: 9000, from: 'new@x.com', bodyText: 'NEW' },
    ];
    const ctx = buildInitialContext('Subject', emails, 2);
    const oldIdx = ctx.indexOf('OLD');
    const newIdx = ctx.indexOf('NEW');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  test('caps at 20 emails', () => {
    const emails = Array.from({ length: 30 }, (_, i) => ({
      date: i * 1000,
      from: `user${i}@x.com`,
      bodyText: `body${i}`,
    }));
    const ctx = buildInitialContext('S', emails, 30);
    const count = (ctx.match(/## Mail /g) || []).length;
    expect(count).toBe(20);
    expect(ctx).toContain('20 mails envoyes (sur 30 au total)');
  });

  test('truncates bodies longer than 3000 chars', () => {
    const longBody = 'x'.repeat(5000);
    const emails = [{ date: 1000, from: 'a@x.com', bodyText: longBody }];
    const ctx = buildInitialContext('S', emails, 1);
    expect(ctx).toContain('xxx...');
    // Total context should be way less than 5000 chars of body + header overhead
    expect(ctx.length).toBeLessThan(5000 + 500);
  });

  test('handles missing date or from gracefully', () => {
    const emails = [{ bodyText: 'only body' }];
    const ctx = buildInitialContext('S', emails, 1);
    expect(ctx).toContain('De: inconnu');
    expect(ctx).toContain('inconnue'); // date unknown
  });
});

describe('aiChat — parseOpenAIChunk', () => {
  let parseOpenAIChunk;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/aiChat.js');
    parseOpenAIChunk = mod.parseOpenAIChunk;
  });

  test('parses OpenAI delta chunk', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}';
    const result = parseOpenAIChunk(line);
    expect(result).toEqual({ delta: 'Hello' });
  });

  test('parses OpenAI usage final chunk', () => {
    const line = 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}';
    const result = parseOpenAIChunk(line);
    expect(result).toEqual({ usage: { input_tokens: 100, output_tokens: 50 } });
  });

  test('handles OpenAI [DONE] sentinel', () => {
    expect(parseOpenAIChunk('data: [DONE]')).toEqual({ done: true });
  });

  test('returns null on malformed OpenAI chunk', () => {
    expect(parseOpenAIChunk('data: not json')).toBeNull();
    expect(parseOpenAIChunk('not a data line')).toBeNull();
  });
});

describe('aiChat — parseAnthropicChunk', () => {
  let parseAnthropicChunk;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/aiChat.js');
    parseAnthropicChunk = mod.parseAnthropicChunk;
  });

  test('parses Anthropic content_block_delta', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}';
    const result = parseAnthropicChunk(line);
    expect(result).toEqual({ delta: 'Hi' });
  });

  test('parses Anthropic message_delta usage', () => {
    const line = 'data: {"type":"message_delta","usage":{"output_tokens":25}}';
    const result = parseAnthropicChunk(line);
    expect(result).toEqual({ usage: { input_tokens: 0, output_tokens: 25 } });
  });

  test('parses Anthropic message_start initial usage', () => {
    const line = 'data: {"type":"message_start","message":{"usage":{"input_tokens":200}}}';
    const result = parseAnthropicChunk(line);
    expect(result).toEqual({ usage: { input_tokens: 200, output_tokens: 0 } });
  });

  test('returns null for Anthropic non-content events', () => {
    expect(parseAnthropicChunk('data: {"type":"ping"}')).toBeNull();
  });
});
