const { describe, it, expect } = require('@jest/globals');
const { formatGmailEmail, buildGmailQuery } = require('../../src/services/gmailService');

describe('formatGmailEmail', () => {
  it('normalise un email Gmail brut en format JSONL unifié', () => {
    const raw = {
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      snippet: 'A short preview',
      internalDate: '1740218400000',
      sizeEstimate: 1234,
      historyId: '42',
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello world' },
          { name: 'From', value: 'Alice <alice@example.com>' },
          { name: 'To', value: 'Bob <bob@example.com>' },
          { name: 'Cc', value: 'Carol <carol@example.com>' },
          { name: 'Date', value: 'Wed, 12 Mar 2025 10:00:00 +0000' },
          { name: 'Message-ID', value: '<msg-1@example.com>' },
          { name: 'In-Reply-To', value: '<prev@example.com>' },
          { name: 'References', value: '<root@example.com> <prev@example.com>' }
        ],
        body: { data: '' }
      }
    };

    const formatted = formatGmailEmail(raw);

    expect(formatted).toBeTruthy();
    expect(formatted.id).toBe('msg-1');
    expect(formatted.threadId).toBe('thread-1');
    expect(formatted.subject).toBe('Hello world');
    expect(formatted.from).toBe('Alice <alice@example.com>');
    expect(formatted.to).toBe('Bob <bob@example.com>');
    expect(formatted.cc).toBe('Carol <carol@example.com>');
    expect(formatted.internalDate).toBe('1740218400000');
    expect(formatted.messageId).toBe('<msg-1@example.com>');
    expect(formatted.inReplyTo).toBe('<prev@example.com>');
    expect(formatted.references).toBe('<root@example.com> <prev@example.com>');
  });
});

describe('buildGmailQuery', () => {
  it('génère une query avec after:YYYY/MM/DD à partir de internalDate en ms', () => {
    const filters = null;
    const internalDateMs = String(Date.UTC(2025, 2, 12)); // 2025-03-12T00:00:00.000Z

    const query = buildGmailQuery(filters, internalDateMs);

    expect(query).toMatch(/^after:2025\/03\/12$/);
  });
});

