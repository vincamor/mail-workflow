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

  it('retourne false si pas de filtres', () => {
    expect(shouldExcludeEmail(email, null)).toBe(false);
    expect(shouldExcludeEmail(email, undefined)).toBe(false);
  });

  it('retourne false si aucun filtre ne match', () => {
    const filters = {
      excludeNoSubject: false,
      excludeNotifications: false,
      excludePromotional: false,
      blacklistedSenders: [],
      blacklistedKeywords: [],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(false);
  });

  it('exclut les emails sans sujet', () => {
    const filters = { excludeNoSubject: true };
    expect(shouldExcludeEmail({ subject: '', from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: '  ', from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: null, from: 'a@b.com' }, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Hello', from: 'a@b.com' }, filters)).toBe(false);
  });

  it('exclut les notifications par keyword (from ou subject)', () => {
    const filters = {
      excludeNotifications: true,
      notificationKeywords: ['noreply', 'notifications'],
    };
    // Match dans from
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    // Match dans subject (keyword 'notifications' dans le sujet)
    expect(
      shouldExcludeEmail(
        { subject: 'Your notifications are ready', from: 'user@corp.com' },
        filters
      )
    ).toBe(true);
    // Pas de match
    expect(shouldExcludeEmail({ subject: 'Hello', from: 'alice@corp.com' }, filters)).toBe(false);
  });

  it('exclut les promotions par keyword dans le sujet', () => {
    const filters = {
      excludePromotional: true,
      promotionalKeywords: ['newsletter', 'promo'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(
      shouldExcludeEmail({ subject: 'Meeting tomorrow', from: 'boss@corp.com' }, filters)
    ).toBe(false);
  });

  it('exclut les expediteurs blacklistes', () => {
    const filters = {
      blacklistedSenders: ['notifications.example.com'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Hi', from: 'friend@other.com' }, filters)).toBe(false);
  });

  it('exclut par mots-cles blacklistes dans le sujet', () => {
    const filters = {
      blacklistedKeywords: ['newsletter'],
    };
    expect(shouldExcludeEmail(email, filters)).toBe(true);
    expect(shouldExcludeEmail({ subject: 'Project update', from: 'team@corp.com' }, filters)).toBe(
      false
    );
  });

  it('exclut les sujets blacklistés (avec normalisation Re:/Fwd:)', () => {
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

  it('est case-insensitive', () => {
    const filters = {
      blacklistedKeywords: ['NEWSLETTER'],
    };
    expect(
      shouldExcludeEmail({ subject: 'weekly Newsletter update', from: 'a@b.com' }, filters)
    ).toBe(true);
  });

  it('combine plusieurs filtres (OR logic — premier match suffit)', () => {
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
    // Aucun match
    expect(shouldExcludeEmail({ subject: 'Real email', from: 'colleague@work.com' }, filters)).toBe(
      false
    );
  });
});

// ─────────────────────────────────────────────
//  isTokenError
// ─────────────────────────────────────────────

describe('isTokenError', () => {
  it('detecte les erreurs 401 (code)', () => {
    expect(isTokenError({ code: 401 })).toBe(true);
  });

  it('detecte les erreurs 401 (statusCode)', () => {
    expect(isTokenError({ statusCode: 401 })).toBe(true);
  });

  it('detecte invalid_grant dans le message', () => {
    expect(isTokenError({ message: 'Error: invalid_grant' })).toBe(true);
  });

  it('detecte Token dans le message', () => {
    expect(isTokenError({ message: 'Token expired' })).toBe(true);
    expect(isTokenError({ message: 'token revoked' })).toBe(true);
  });

  it('retourne false pour les erreurs non-token', () => {
    expect(isTokenError({ code: 500, message: 'Internal server error' })).toBe(false);
    expect(isTokenError({ message: 'Network error' })).toBe(false);
    expect(isTokenError({})).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  parseFiltersFromRequest
// ─────────────────────────────────────────────

describe('parseFiltersFromRequest', () => {
  it('parse les filtres depuis query string', () => {
    const filters = { excludeNoSubject: true };
    const req = {
      query: { filters: JSON.stringify(filters), afterDate: '1710000000000' },
      body: {},
    };
    const result = parseFiltersFromRequest(req);
    expect(result.filters).toEqual(filters);
    expect(result.afterDate).toBe('1710000000000');
  });

  it('fallback sur body.filters si query.filters absent', () => {
    const filters = { blacklistedSenders: ['spam@evil.com'] };
    const req = {
      query: {},
      body: { filters },
    };
    const result = parseFiltersFromRequest(req);
    expect(result.filters).toEqual(filters);
    expect(result.afterDate).toBeNull();
  });

  it('retourne null si aucun filtre', () => {
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
  it('retire les prefixes Re:/Fwd:/Fw:/Tr:', () => {
    expect(normalizeSubject('Re: Hello')).toBe('hello');
    expect(normalizeSubject('Fwd: Re: Hello')).toBe('re hello');
    expect(normalizeSubject('FW: Test')).toBe('test');
    expect(normalizeSubject('Tr: Bonjour')).toBe('bonjour');
  });

  it('retire les dates et chiffres', () => {
    expect(normalizeSubject('Votre digest du 01/03/2026')).toBe('votre digest du');
    expect(normalizeSubject('Alerte connexion #42')).toBe('alerte connexion');
    expect(normalizeSubject('Rapport semaine 12')).toBe('rapport semaine');
  });

  it('retire la ponctuation et normalise les espaces', () => {
    expect(normalizeSubject('  Hello,  World!  ')).toBe('hello world');
    expect(normalizeSubject('[URGENT] Action requise')).toBe('urgent action requise');
  });

  it('gere les sujets vides ou null', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject(null)).toBe('');
    expect(normalizeSubject(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────
//  isSenderRepetitive
// ─────────────────────────────────────────────

describe('isSenderRepetitive', () => {
  it('detecte des sujets quasi-identiques (5/5 identiques)', () => {
    const subjects = [
      'Votre digest du 01/03',
      'Votre digest du 02/03',
      'Votre digest du 03/03',
      'Votre digest du 04/03',
      'Votre digest du 05/03',
    ];
    expect(isSenderRepetitive(subjects, [100, 120, 110, 105, 115])).toBe(true);
  });

  it('detecte 3/5 identiques (60% = seuil par defaut)', () => {
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

  it('ne detecte pas un collegue avec des sujets varies', () => {
    const subjects = [
      'Reunion budget Q2',
      'Re: Question API auth',
      'Feedback design review',
      'Dispo jeudi ?',
      'Fwd: Article interessant',
    ];
    expect(isSenderRepetitive(subjects, [45, 890, 12, 200, 156])).toBe(false);
  });

  it('detecte des gros mails template via body length si sujets differents', () => {
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

  it('ne detecte pas des gros mails avec body lengths tres varies', () => {
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

  it('ne declenche pas le body check pour petits mails', () => {
    const subjects = ['Salut', 'OK', 'Merci', 'RDV', 'Yes'];
    const bodyLengths = [10, 12, 8, 11, 9];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(false);
  });

  it('ignore les body lengths a 0 dans le body check', () => {
    const subjects = ['A', 'B', 'C', 'D', 'E'];
    // Body lengths avec des 0 (HTML-only mails) — ne doit pas trigger
    const bodyLengths = [0, 0, 0, 0, 0];
    expect(isSenderRepetitive(subjects, bodyLengths)).toBe(false);
  });

  it('gere les sujets vides ou undefined dans la liste', () => {
    const subjects = ['', '', '', undefined, null];
    expect(isSenderRepetitive(subjects, [100, 100, 100, 100, 100])).toBe(true);
  });

  it('detecte 4/5 identiques (au dessus de 60%)', () => {
    const subjects = [
      'Alerte de securite du 01/03',
      'Alerte de securite du 02/03',
      'Alerte de securite du 03/03',
      'Alerte de securite du 04/03',
      'Bienvenue sur notre plateforme',
    ];
    expect(isSenderRepetitive(subjects, [100, 100, 100, 100, 100])).toBe(true);
  });

  it('ne detecte pas 2/5 identiques (sous 60%)', () => {
    const subjects = [
      'Alerte connexion',
      'Alerte connexion',
      'Reunion equipe',
      'Compte rendu projet',
      'Planning vacances',
    ];
    expect(isSenderRepetitive(subjects, [50, 60, 55, 200, 300])).toBe(false);
  });

  it('fonctionne avec 10 samples (reevaluation)', () => {
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
//  normalizeSubject — edge cases supplementaires
// ─────────────────────────────────────────────

describe('normalizeSubject — edge cases', () => {
  it('gere les prefixes multiples imbriques', () => {
    // Seul le premier prefixe est retire (par design)
    expect(normalizeSubject('Re: Fwd: Re: Hello')).toBe('fwd re hello');
  });

  it('gere les caracteres unicode (accents, etc.)', () => {
    expect(normalizeSubject('Réunion préparatoire été')).toBe('réunion préparatoire été');
  });

  it('gere les sujets avec uniquement des chiffres/dates', () => {
    expect(normalizeSubject('01/03/2026 - 42')).toBe('');
  });

  it('gere les sujets tres longs sans crash', () => {
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
  it('extrait email depuis le format "Name <email>"', () => {
    expect(extractEmailAddress('Railway <hello@notify.railway.app>')).toBe(
      'hello@notify.railway.app'
    );
    expect(extractEmailAddress('Banque Populaire <bcpmail@cpm.co.ma>')).toBe('bcpmail@cpm.co.ma');
    expect(extractEmailAddress('"Disney+" <disneyplus@mail.disney.com>')).toBe(
      'disneyplus@mail.disney.com'
    );
  });

  it('retourne email tel quel si pas de chevrons', () => {
    expect(extractEmailAddress('contact@test.com')).toBe('contact@test.com');
    expect(extractEmailAddress('CONTACT@TEST.COM')).toBe('contact@test.com');
  });

  it('gere les cas vides ou null', () => {
    expect(extractEmailAddress('')).toBe('');
    expect(extractEmailAddress(null)).toBe('');
    expect(extractEmailAddress(undefined)).toBe('');
  });

  it('gere les noms avec caracteres speciaux', () => {
    expect(extractEmailAddress('"Sélection Quora" <digest@quora.com>')).toBe('digest@quora.com');
    expect(extractEmailAddress('=?UTF-8?Q?Railway?= <hello@notify.railway.app>')).toBe(
      'hello@notify.railway.app'
    );
  });
});
