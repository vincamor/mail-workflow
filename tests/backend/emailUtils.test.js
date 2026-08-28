const { describe, it, expect } = require('@jest/globals');
const {
  shouldExcludeEmail,
  isTokenError,
  parseFiltersFromRequest,
  normalizeSubject,
  isSenderRepetitive,
  extractEmailAddress,
} = require('../../src/services/emailUtils');

// ─────────────────────────────────────────────
//  shouldExcludeEmail
// ─────────────────────────────────────────────

describe('shouldExcludeEmail', () => {
  const email = {
    subject: 'Weekly newsletter from Promo Corp',
    from: 'noreply@notifications.example.com',
  };

  it('returns false if no filters', () => {
    expect(shouldExcludeEmail(email, null)).toBe(false);
    expect(shouldExcludeEmail(email, undefined)).toBe(false);
  });

  it('returns false if no filter matches', () => {
    const filters = {
      excludeNoSubject: false,
      excludeNotifications: false,
      excludePromotional: false,
      blacklistedSenders: [],
      blacklistedKeywords: [],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(false);
  });

  it('excludes emails without a subject', () => {
    const filters = { excludeNoSubject: true };
    expect(shouldExcludeEmail({ subject: '', from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: '  ', from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: null, from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Hello', from: 'a@b.com' }, filters)).toBe(false);
  });

  it('excludes notifications by keyword (from or subject)', () => {
    const filters = {
      excludeNotifications: true,
      notificationKeywords: ['noreply', 'notifications'],
    };
    // Match in from
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    // Match in subject (keyword 'notifications' in the subject)
    expect(
      shouldExcludeEmail(
        { subject: 'Your notifications are ready', from: 'user@corp.com' },
        filters
      )
    ).toBe(true);
    // No match
    expect(shouldExcludeEmail({ subject: 'Hello', from: 'alice@corp.com' }, filters)).toBe(false);
  });

  it('excludes promotional emails by keyword in the subject', () => {
    const filters = {
      excludePromotional: true,
      promotionalKeywords: ['newsletter', 'promo'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(
      shouldExcludeEmail({ subject: 'Meeting tomorrow', from: 'boss@corp.com' }, filters)
    ).toBe(false);
  });

  it('excludes blacklisted senders', () => {
    const filters = {
      blacklistedSenders: ['notifications.example.com'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Hi', from: 'friend@other.com' }, filters)).toBe(false);
  });

  it('excludes by blacklisted keywords in the subject', () => {
    const filters = {
      blacklistedKeywords: ['newsletter'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Project update', from: 'team@corp.com' }, filters)).toBe(
      false
    );
  });

  it('excludes blacklisted subjects (with Re:/Fwd: normalisation)', () => {
    const filters = {
      blacklistedSubjects: ['Project Update', 'Weekly Report'],
    };
    // Exact match
    expect(shouldExcludeEmail({ subject: 'Project Update', from: 'a@b.com' }, filters)).toBe(true);
    // With Re: prefix — should still match
    expect(shouldExcludeEmail({ subject: 'Re: Project Update', from: 'a@b.com' }, filters)).toBe(
      true
    );
    // With Fwd: prefix
    expect(shouldExcludeEmail({ subject: 'Fwd: Weekly Report', from: 'a@b.com' }, filters)).toBe(
      true
    );
    // With FW: prefix
    expect(shouldExcludeEmail({ subject: 'FW: Weekly Report', from: 'a@b.com' }, filters)).toBe(
      true
    );
    // No match
    expect(shouldExcludeEmail({ subject: 'Something Else', from: 'a@b.com' }, filters)).toBe(false);
    // Empty blacklistedSubjects
    expect(
      shouldExcludeEmail(
        { subject: 'Project Update', from: 'a@b.com' },
        { blacklistedSubjects: [] }
      )
    ).toBe(false);
  });

  it('is case-insensitive', () => {
    const filters = {
      blacklistedKeywords: ['NEWSLETTER'],
    };
    expect(
      shouldExcludeEmail({ subject: 'weekly Newsletter update', from: 'a@b.com' }, filters)
    ).toBe(true);
  });

  it('combines multiple filters (OR logic — first match is enough)', () => {
    const filters = {
      excludeNoSubject: true,
      excludeNotifications: true,
      notificationKeywords: ['noreply'],
      blacklistedSenders: ['spam@evil.com'],
    };
    // Match via notifications
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    // Match via blacklistedSenders
    expect(shouldExcludeEmail({ subject: 'Buy now!', from: 'spam@evil.com' }, filters)).toBe(true);
    // No match
    expect(shouldExcludeEmail({ subject: 'Real email', from: 'colleague@work.com' }, filters)).toBe(
      false
    );
  });
});

// ─────────────────────────────────────────────
//  isTokenError
// ─────────────────────────────────────────────

describe('isTokenError', () => {
  it('detects 401 errors (code)', () => {
    expect(isTokenError({ code: 401 })).toBe(true);
  });

  it('detects 401 errors (statusCode)', () => {
    expect(isTokenError({ statusCode: 401 })).toBe(true);
  });

  it('detects invalid_grant in the message', () => {
    expect(isTokenError({ message: 'Error: invalid_grant' })).toBe(true);
  });

  it('detects Token in the message', () => {
    expect(isTokenError({ message: 'Token expired' })).toBe(true);
    expect(isTokenError({ message: 'token revoked' })).toBe(true);
  });

  it('returns false for non-token errors', () => {
    expect(isTokenError({ code: 500, message: 'Internal server error' })).toBe(false);
    expect(isTokenError({ message: 'Network error' })).toBe(false);
    expect(isTokenError({})).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  parseFiltersFromRequest
// ─────────────────────────────────────────────

describe('parseFiltersFromRequest', () => {
  it('parses filters from query string', () => {
    const filters = { excludeNoSubject: true };
    const req = {
      query: { filters: JSON.stringify(filters), afterDate: '1710000000000' },
      body: {},
    };
    const result = parseFiltersFromRequest(req);
    expect(result.filters).toEqual(filters);
    expect(result.afterDate).toBe('1710000000000');
  });

  it('falls back to body.filters if query.filters is absent', () => {
    const filters = { blacklistedSenders: ['spam@evil.com'] };
    const req = {
      query: {},
      body: { filters },
    };
    const result = parseFiltersFromRequest(req);
    expect(result.filters).toEqual(filters);
    expect(result.afterDate).toBeNull();
  });

  it('returns null if no filter', () => {
    const req = { query: {}, body: {} };
    const result = parseFiltersFromRequest(req);
    expect(result.filters).toBeNull();
    expect(result.afterDate).toBeNull();
  });
});

// ─────────────────────────────────────────────
//  normalizeSubject
// ─────────────────────────────────────────────

describe('normalizeSubject', () => {
  it('removes the Re:/Fwd:/Fw:/Tr: prefixes', () => {
    expect(normalizeSubject('Re: Hello')).toBe('hello');
    expect(normalizeSubject('Fwd: Re: Hello')).toBe('re hello');
    expect(normalizeSubject('FW: Test')).toBe('test');
    expect(normalizeSubject('Tr: Bonjour')).toBe('bonjour');
  });

  it('removes dates and numbers', () => {
    expect(normalizeSubject('Votre digest du 01/03/2026')).toBe('votre digest du');
    expect(normalizeSubject('Alerte connexion #42')).toBe('alerte connexion');
    expect(normalizeSubject('Rapport semaine 12')).toBe('rapport semaine');
  });

  it('removes punctuation and normalizes spaces', () => {
    expect(normalizeSubject('  Hello,  World!  ')).toBe('hello world');
    expect(normalizeSubject('[URGENT] Action requise')).toBe('urgent action requise');
  });

  it('handles empty or null subjects', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject(null)).toBe('');
    expect(normalizeSubject(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────
//  isSenderRepetitive
// ─────────────────────────────────────────────

describe('isSenderRepetitive', () => {
  it('detects nearly identical subjects (5/5 identical)', () => {
    const subjects = [
      'Votre digest du 01/03',
      'Votre digest du 02/03',
      'Votre digest du 03/03',
      'Votre digest du 04/03',
      'Votre digest du 05/03',
    ];
    expect(isSenderRepetitive(subjects, [100, 120, 110, 105, 115])).toBe(true);
  });

  it('detects 3/5 identical (60% = default threshold)', () => {
    const subjects = [
      'Deployment crashed for MailProject!',
      'Deployment crashed for MailProject!',
      'Deployment crashed for MailProject!',
      'Trial Plan Alert',
      'Start Collecting Referral Credits',
    ];
    // 3/5 = 60% → ceil(5 * 0.6) = 3 → doit trigger
    expect(isSenderRepetitive(subjects, [1000, 1200, 1100, 900, 800])).toBe(true);
  });

  it('does not detect a colleague with varied subjects', () => {
    const subjects = [
      'Reunion budget Q2',
      'Re: Question API auth',
      'Feedback design review',
      'Dispo jeudi ?',
      'Fwd: Article interessant',
    ];
    expect(isSenderRepetitive(subjects, [45, 890, 12, 200, 156])).toBe(false);
  });

  it('detects large templated emails via body length if subjects differ', () => {
    const subjects = [
      'Commande #1234 expediee',
      'Commande #5678 expediee',
      'Commande #9012 en cours',
      'Commande #3456 livree',
      'Commande #7890 confirmee',
    ];
    const bodyLengths = [2340, 2312, 2298, 2350, 2325];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(true);
  });

  it('does not detect large emails with highly varied body lengths', () => {
    const subjects = [
      'Projet Alpha update',
      'Projet Beta review',
      'Projet Gamma specs',
      'Budget annuel draft',
      'Planning Q3',
    ];
    const bodyLengths = [1200, 5400, 800, 3200, 15000];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(false);
  });

  it('does not trigger body check for small emails', () => {
    const subjects = ['Salut', 'OK', 'Merci', 'RDV', 'Yes'];
    const bodyLengths = [10, 12, 8, 11, 9];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(false);
  });

  it('ignores body lengths of 0 in the body check', () => {
    const subjects = ['A', 'B', 'C', 'D', 'E'];
    // Body lengths avec des 0 (HTML-only mails) — ne doit pas trigger
    const bodyLengths = [0, 0, 0, 0, 0];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(false);
  });

  it('handles empty or undefined subjects in the list', () => {
    const subjects = ['', '', '', undefined, null];
    expect(isSenderRepetitive(subjects, [100, 100, 100, 100, 100])).toBe(true);
  });

  it('detects 4/5 identical (above 60%)', () => {
    const subjects = [
      'Alerte de securite du 01/03',
      'Alerte de securite du 02/03',
      'Alerte de securite du 03/03',
      'Alerte de securite du 04/03',
      'Bienvenue sur notre plateforme',
    ];
    expect(isSenderRepetitive(subjects, [100, 100, 100, 100, 100])).toBe(true);
  });

  it('does not detect 2/5 identical (below 60%)', () => {
    const subjects = [
      'Alerte connexion',
      'Alerte connexion',
      'Reunion equipe',
      'Compte rendu projet',
      'Planning vacances',
    ];
    expect(isSenderRepetitive(subjects, [50, 60, 55, 200, 300])).toBe(false);
  });

  it('works with 10 samples (re-evaluation)', () => {
    const subjects = [
      'Digest #1',
      'Digest #2',
      'Digest #3',
      'Digest #4',
      'Digest #5',
      'Digest #6',
      'Welcome!',
      'Digest #7',
      'Digest #8',
      'Settings update',
    ];
    // 8/10 identiques apres normalisation = 80% > 60% → spam
    expect(isSenderRepetitive(subjects, new Array(10).fill(100))).toBe(true);
  });
});

// ─────────────────────────────────────────────
//  normalizeSubject — additional edge cases
// ─────────────────────────────────────────────

describe('normalizeSubject — edge cases', () => {
  it('handles nested multiple prefixes', () => {
    // Only the first prefix is removed (by design)
    expect(normalizeSubject('Re: Fwd: Re: Hello')).toBe('fwd re hello');
  });

  it('handles unicode characters (accents, etc.)', () => {
    expect(normalizeSubject('Réunion préparatoire été')).toBe('réunion préparatoire été');
  });

  it('handles subjects with only numbers/dates', () => {
    expect(normalizeSubject('01/03/2026 - 42')).toBe('');
  });

  it('handles very long subjects without crashing', () => {
    const longSubject = 'A'.repeat(10000);
    const result = normalizeSubject(longSubject);
    expect(result.length).toBeLessThanOrEqual(10000);
    expect(result).toBe('a'.repeat(10000));
  });
});

// ─────────────────────────────────────────────
//  extractEmailAddress
// ─────────────────────────────────────────────

describe('extractEmailAddress', () => {
  it('extracts email from the "Name <email>" format', () => {
    expect(extractEmailAddress('Railway <hello@notify.railway.app>')).toBe(
      'hello@notify.railway.app'
    );
    expect(extractEmailAddress('Banque Populaire <bcpmail@cpm.co.ma>')).toBe('bcpmail@cpm.co.ma');
    expect(extractEmailAddress('"Disney+" <disneyplus@mail.disney.com>')).toBe(
      'disneyplus@mail.disney.com'
    );
  });

  it('returns email as is if no angle brackets', () => {
    expect(extractEmailAddress('contact@test.com')).toBe('contact@test.com');
    expect(extractEmailAddress('CONTACT@TEST.COM')).toBe('contact@test.com');
  });

  it('handles empty or null cases', () => {
    expect(extractEmailAddress('')).toBe('');
    expect(extractEmailAddress(null)).toBe('');
    expect(extractEmailAddress(undefined)).toBe('');
  });

  it('handles names with special characters', () => {
    expect(extractEmailAddress('"Sélection Quora" <digest@quora.com>')).toBe('digest@quora.com');
    expect(extractEmailAddress('=?UTF-8?Q?Railway?= <hello@notify.railway.app>')).toBe(
      'hello@notify.railway.app'
    );
  });
});
