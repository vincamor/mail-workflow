const { describe, it, expect } = require('@jest/globals');

// Pure functions duplicated from src/public/js/aiFilter.js for testing
function parseAIFilterResponse(text) {
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objectMatch) throw new Error('No JSON found in the AI response');
  const parsed = JSON.parse(objectMatch[0]);
  if (!parsed.exclure || !parsed.garder)
    throw new Error('Invalid format: the "exclure" and "garder" fields are required');
  return {
    exclure: Array.isArray(parsed.exclure) ? parsed.exclure : [],
    garder: Array.isArray(parsed.garder) ? parsed.garder : [],
    incertain: Array.isArray(parsed.incertain) ? parsed.incertain : [],
  };
}

function validateFilterResults(aiResult, originalSubjects) {
  const originalSet = new Set(originalSubjects);
  return {
    exclure: aiResult.exclure.filter((s) => originalSet.has(s)),
    garder: aiResult.garder.filter((s) => originalSet.has(s)),
    incertain: aiResult.incertain.filter((s) => originalSet.has(s)),
  };
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function buildPass2Batches(subjects, maxTokensPerBatch = 7000) {
  const systemPromptTokens = 400;
  const outputReserve = 300;
  const available = maxTokensPerBatch - systemPromptTokens - outputReserve;
  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;
  for (const subject of subjects) {
    const subjectTokens = estimateTokens(subject.promptBlock);
    if (currentBatch.length > 0 && currentTokens + subjectTokens > available) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(subject);
    currentTokens += subjectTokens;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

describe('parseAIFilterResponse', () => {
  it('parses valid JSON', () => {
    const text = '{"exclure": ["A", "B"], "garder": ["C"], "incertain": ["D"]}';
    const result = parseAIFilterResponse(text);
    expect(result.exclure).toEqual(['A', 'B']);
    expect(result.garder).toEqual(['C']);
    expect(result.incertain).toEqual(['D']);
  });

  it('parses JSON wrapped in code fences', () => {
    const text = '```json\n{"exclure": ["A"], "garder": ["B"], "incertain": []}\n```';
    const result = parseAIFilterResponse(text);
    expect(result.exclure).toEqual(['A']);
  });

  it('parses JSON surrounded by text', () => {
    const text =
      'Here is my analysis:\n{"exclure": ["A"], "garder": ["B"], "incertain": []}\nHave a good day!';
    const result = parseAIFilterResponse(text);
    expect(result.exclure).toEqual(['A']);
  });

  it('throws when there is no JSON', () => {
    expect(() => parseAIFilterResponse('No JSON here')).toThrow('No JSON');
  });

  it('throws when the format is invalid', () => {
    expect(() => parseAIFilterResponse('{"foo": "bar"}')).toThrow('Invalid format');
  });

  it('falls back to empty arrays for the missing fields', () => {
    const text = '{"exclure": ["A"], "garder": ["B"]}';
    const result = parseAIFilterResponse(text);
    expect(result.incertain).toEqual([]);
  });
});

describe('validateFilterResults', () => {
  it('filters out the hallucinated subjects', () => {
    const aiResult = {
      exclure: ['A', 'Hallucinated'],
      garder: ['B', 'Invented'],
      incertain: ['C'],
    };
    const result = validateFilterResults(aiResult, ['A', 'B', 'C', 'D']);
    expect(result.exclure).toEqual(['A']);
    expect(result.garder).toEqual(['B']);
    expect(result.incertain).toEqual(['C']);
  });

  it('returns empty arrays when everything is hallucinated', () => {
    const result = validateFilterResults({ exclure: ['X'], garder: ['Y'], incertain: ['Z'] }, [
      'A',
      'B',
    ]);
    expect(result.exclure).toEqual([]);
    expect(result.garder).toEqual([]);
    expect(result.incertain).toEqual([]);
  });
});

describe('buildPass2Batches', () => {
  it('groups the subjects within the token budget', () => {
    const subjects = [
      { subject: 'A', promptBlock: 'x'.repeat(400) },
      { subject: 'B', promptBlock: 'x'.repeat(400) },
      { subject: 'C', promptBlock: 'x'.repeat(400) },
      { subject: 'D', promptBlock: 'x'.repeat(400) },
    ];
    const batches = buildPass2Batches(subjects, 7000);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(4);
  });

  it('splits when the budget is exceeded', () => {
    const subjects = [
      { subject: 'A', promptBlock: 'x'.repeat(10000) },
      { subject: 'B', promptBlock: 'x'.repeat(10000) },
      { subject: 'C', promptBlock: 'x'.repeat(10000) },
      { subject: 'D', promptBlock: 'x'.repeat(10000) },
    ];
    const batches = buildPass2Batches(subjects, 7000);
    expect(batches.length).toBe(2);
  });

  it('puts a large subject alone in its batch', () => {
    const subjects = [
      { subject: 'A', promptBlock: 'x'.repeat(30000) },
      { subject: 'B', promptBlock: 'x'.repeat(400) },
    ];
    const batches = buildPass2Batches(subjects, 7000);
    expect(batches.length).toBe(2);
  });

  it('returns an empty array when there are no subjects', () => {
    expect(buildPass2Batches([], 7000).length).toBe(0);
  });
});
