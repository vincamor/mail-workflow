const { describe, it, expect, beforeAll } = require('@jest/globals');

// These three functions used to be COPIED here from src/public/js/aiFilter.js.
// A copied test passes while the real code is broken, so they are now imported
// from the production module. aiFilter.js is an ES module under src/public/js/,
// which carries the package.json `"type":"module"` marker, so a dynamic import
// resolves it — the same pattern aiChat.test.js already uses.
let parseAIFilterResponse, validateFilterResults, buildPass2Batches;

beforeAll(async () => {
  const mod = await import('../../src/public/js/aiFilter.js');
  ({ parseAIFilterResponse, validateFilterResults, buildPass2Batches } = mod);
});

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

  it('throws when there is no JSON and nothing quoted to fall back on', () => {
    expect(() => parseAIFilterResponse('No JSON here')).toThrow('No JSON');
  });

  // The copy this suite used to test threw 'Invalid format' here. The real
  // parser does not: normalizeResult turns any missing or non-array field into
  // an empty array, so a well-formed object with the wrong keys is a no-op
  // rather than an error. The AI is asked for those keys but is not trusted to
  // return them.
  it('normalises an object with unexpected keys to empty arrays', () => {
    expect(parseAIFilterResponse('{"foo": "bar"}')).toEqual({
      exclure: [],
      garder: [],
      incertain: [],
    });
  });

  // This fallback path exists only in the real module — the inlined copy never
  // had it, so it had never been tested. When the model answers without valid
  // JSON, the parser salvages the quoted strings and treats them as exclusions.
  it('falls back to extracting quoted subjects when the JSON is unusable', () => {
    expect(parseAIFilterResponse('I would drop "Newsletter A" and "Receipt B".')).toEqual({
      exclure: ['Newsletter A', 'Receipt B'],
      garder: [],
      incertain: [],
    });
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
