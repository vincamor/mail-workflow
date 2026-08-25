const { describe, it, expect } = require('@jest/globals');

// Aucun mock MSAL n'est nécessaire : le ConfidentialClientApplication mort a été
// supprimé du service. Ce mock existait pour empêcher son initialisation réelle,
// et c'est précisément lui qui masquait le crash au démarrage avec des secrets
// vides. Le service se charge maintenant sans aucune credential.
const { formatOutlookEmail, buildOutlookQuery } = require('../../src/services/outlookService');

describe('formatOutlookEmail', () => {
  it('normalise un message Outlook Graph en format JSONL unifié', () => {
    const raw = {
      id: 'o-msg-1',
      conversationId: 'conv-1',
      subject: 'Hello world',
      bodyPreview: 'Preview',
      from: {
        emailAddress: { name: 'Alice', address: 'alice@example.com' }
      },
      toRecipients: [
        { emailAddress: { name: 'Bob', address: 'bob@example.com' } }
      ],
      ccRecipients: [
        { emailAddress: { name: 'Carol', address: 'carol@example.com' } }
      ],
      sentDateTime: '2025-03-12T10:00:00Z',
      internetMessageId: '<o-msg-1@example.com>',
      categories: ['cat1'],
      body: {
        contentType: 'HTML',
        content: '<p>Hello <b>world</b></p>'
      },
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<prev@example.com>' },
        { name: 'References', value: '<root@example.com> <prev@example.com>' }
      ]
    };

    const formatted = formatOutlookEmail(raw);

    expect(formatted).toBeTruthy();
    expect(formatted.id).toBe('o-msg-1');
    expect(formatted.threadId).toBe('conv-1');
    expect(formatted.subject).toBe('Hello world');
    expect(formatted.from).toBe('Alice <alice@example.com>');
    expect(formatted.to).toBe('Bob <bob@example.com>');
    expect(formatted.cc).toBe('Carol <carol@example.com>');
    expect(formatted.internalDate).toBe(String(new Date('2025-03-12T10:00:00Z').getTime()));
    expect(formatted.messageId).toBe('<o-msg-1@example.com>');
    expect(formatted.inReplyTo).toBe('<prev@example.com>');
    expect(formatted.references).toBe('<root@example.com> <prev@example.com>');
    expect(formatted.bodyText).toContain('Hello world');
  });

  it('aligne les champs principaux avec formatGmailEmail pour des emails équivalents', () => {
    const gmailLike = {
      id: 'g-1',
      threadId: 'thread-1',
      labelIds: [],
      snippet: 'Preview',
      internalDate: String(new Date('2025-03-12T10:00:00Z').getTime()),
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello world' },
          { name: 'From', value: 'Alice <alice@example.com>' },
          { name: 'To', value: 'Bob <bob@example.com>' },
          { name: 'Cc', value: 'Carol <carol@example.com>' }
        ],
        body: { data: '' }
      }
    };

    const gmailFormatted = {
      id: gmailLike.id,
      threadId: gmailLike.threadId,
      subject: 'Hello world',
      from: 'Alice <alice@example.com>',
      to: 'Bob <bob@example.com>',
      cc: 'Carol <carol@example.com>',
      internalDate: gmailLike.internalDate
    };

    const outlookFormatted = formatOutlookEmail({
      id: 'o-1',
      conversationId: 'thread-1',
      subject: 'Hello world',
      bodyPreview: 'Preview',
      from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
      toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.com' } }],
      ccRecipients: [{ emailAddress: { name: 'Carol', address: 'carol@example.com' } }],
      sentDateTime: '2025-03-12T10:00:00Z',
      internetMessageId: '<o-1@example.com>',
      categories: [],
      body: { contentType: 'Text', content: 'Preview' },
      internetMessageHeaders: []
    });

    expect(outlookFormatted.subject).toBe(gmailFormatted.subject);
    expect(outlookFormatted.from).toBe(gmailFormatted.from);
    expect(outlookFormatted.to).toBe(gmailFormatted.to);
    expect(outlookFormatted.cc).toBe(gmailFormatted.cc);
    expect(typeof outlookFormatted.internalDate).toBe('string');
  });
});

describe('buildOutlookQuery', () => {
  it('génère un filtre receivedDateTime gt ISO à partir de internalDate en ms', () => {
    const filters = null;
    const internalDateMs = String(Date.UTC(2025, 2, 12));

    const filter = buildOutlookQuery(filters, internalDateMs);

    expect(filter).toMatch(/^receivedDateTime gt 2025-03-12T00:00:00\.000Z$/);
  });
});

