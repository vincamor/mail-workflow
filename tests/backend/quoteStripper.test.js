const { describe, it, expect } = require('@jest/globals');
const { stripQuotedText } = require('../../src/services/quoteStripper');

// Each fixture: we verify that the content BEFORE the quoted text is preserved
// and that everything from the marker (included) is removed, all trim()ed.

describe('stripQuotedText — Gmail FR', () => {
  it('cuts at the marker "Le ... a écrit :"', () => {
    const body = [
      'Bonjour Marc,',
      '',
      'Merci pour ton retour, je regarde ca demain.',
      '',
      'Vincent',
      '',
      'Le mar. 12 avril 2026 à 14:30, Jean Dupont <jean@example.com> a écrit :',
      '> Salut Vincent,',
      '> Peux-tu valider la PR ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Bonjour Marc');
    expect(result).toContain('Merci pour ton retour');
    expect(result).toContain('Vincent');
    expect(result).not.toContain('Jean Dupont');
    expect(result).not.toContain('a écrit');
    expect(result).not.toContain('Peux-tu valider');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Gmail EN with day-name', () => {
  it('cuts at the marker "On Thu, Sep 19, 2024 at 10:15 AM, ... wrote:"', () => {
    const body = [
      'Hi Alice,',
      '',
      'Thanks for the update, I will check the dashboard tomorrow.',
      '',
      'Best,',
      'Vincent',
      '',
      'On Thu, Sep 19, 2024 at 10:15 AM, Alice <alice@x.com> wrote:',
      'Hey Vincent, please review the new metrics report.',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Hi Alice');
    expect(result).toContain('Thanks for the update');
    expect(result).not.toContain('wrote:');
    expect(result).not.toContain('alice@x.com');
    expect(result).not.toContain('metrics report');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Gmail EN variant (day-name + day-month-year)', () => {
  it('cuts at the marker "On Mon 19 Sep 2024 at 10:15, ... wrote:"', () => {
    const body = [
      'Hello Bob,',
      '',
      'Please find attached the updated proposal.',
      '',
      'Cheers',
      '',
      'On Mon 19 Sep 2024 at 10:15, Bob <bob@x.com> wrote:',
      'Could you send the proposal by Friday?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Hello Bob');
    expect(result).toContain('updated proposal');
    expect(result).not.toContain('bob@x.com');
    expect(result).not.toContain('by Friday');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Outlook dividers', () => {
  it('cuts at the marker "-----Original Message-----"', () => {
    const body = [
      'Bonjour,',
      '',
      'Voici la reponse a ta question sur le devis.',
      '',
      '-----Original Message-----',
      'From: Jean <jean@x.com>',
      'Sent: 12 April 2026 14:30',
      'To: Vincent <vincent@x.com>',
      'Subject: Devis',
      '',
      'Peux-tu me renvoyer le devis ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Bonjour');
    expect(result).toContain('reponse a ta question');
    expect(result).not.toContain('Original Message');
    expect(result).not.toContain('Devis');
    expect(result).not.toContain('Peux-tu me renvoyer');
    expect(result).toBe(result.trim());
  });

  it('cuts at the marker "------ Forwarded message ------"', () => {
    const body = [
      'FYI ci-dessous.',
      '',
      '------ Forwarded message ------',
      'From: Alice <alice@x.com>',
      'Subject: Reunion',
      '',
      'Reunion a 15h.',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('FYI ci-dessous');
    expect(result).not.toContain('Forwarded message');
    expect(result).not.toContain('Reunion a 15h');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Underscore separator', () => {
  it('cuts on a line with at least 5 underscores', () => {
    const body = [
      'Voici les conclusions de la reunion.',
      '',
      'Cordialement,',
      'Vincent',
      '',
      '_______________________________',
      'From: Marc <marc@x.com>',
      'Subject: Compte-rendu',
      '',
      'Peux-tu rediger le CR ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('conclusions de la reunion');
    expect(result).toContain('Vincent');
    expect(result).not.toContain('Compte-rendu');
    expect(result).not.toContain('rediger le CR');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Outlook header block', () => {
  it('cuts at the block "From: ... Sent: ... To:"', () => {
    const body = [
      'Bonjour,',
      '',
      'Je confirme ma presence a la reunion.',
      '',
      'From: Jean Dupont',
      'Sent: 12 April 2026 14:30',
      'To: Marc <marc@x.com>',
      'Subject: Reunion projet',
      '',
      'Es-tu dispo demain ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Bonjour');
    expect(result).toContain('confirme ma presence');
    expect(result).not.toContain('Jean Dupont');
    expect(result).not.toContain('Reunion projet');
    expect(result).not.toContain('Es-tu dispo');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Outlook FR "De :"', () => {
  it('cuts on a line starting with "De : ... <...@..."', () => {
    const body = [
      'Voici les chiffres a jour.',
      '',
      'A bientot,',
      'Vincent',
      '',
      'De : Jean Dupont <jean@x.com>',
      'Envoye : 12 avril 2026 14:30',
      'A : Vincent',
      '',
      'Peux-tu mettre a jour les chiffres ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('chiffres a jour');
    expect(result).toContain('Vincent');
    expect(result).not.toContain('Jean Dupont');
    expect(result).not.toContain('Peux-tu mettre');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Outlook FR "Envoyé :"', () => {
  it('cuts on a line starting with "Envoyé :"', () => {
    const body = [
      'Reponse rapide : oui je valide.',
      '',
      'Envoyé : 12 avril 2026 14:30',
      'Sujet : Validation budget',
      '',
      'Peux-tu valider le budget Q2 ?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Reponse rapide');
    expect(result).toContain('oui je valide');
    expect(result).not.toContain('Validation budget');
    expect(result).not.toContain('budget Q2');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — Outlook EN "Sent :"', () => {
  it('cuts on a line starting with "Sent :"', () => {
    const body = [
      'Quick reply: confirmed.',
      '',
      'Sent : 12 April 2026 14:30',
      'Subject: Project sync',
      '',
      'Can we sync about the project tomorrow?',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Quick reply');
    expect(result).toContain('confirmed');
    expect(result).not.toContain('Project sync');
    expect(result).not.toContain('sync about the project');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — quoted lines "> ..."', () => {
  it('cuts at the first line starting with > even without a marker', () => {
    const body = [
      'Merci pour les informations.',
      '',
      'Je reviens vers toi rapidement.',
      '',
      '> Voici le rapport en piece jointe',
      '> et les chiffres associes.',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Merci pour les informations');
    expect(result).toContain('Je reviens vers toi');
    expect(result).not.toContain('rapport en piece jointe');
    expect(result).not.toContain('chiffres associes');
    expect(result).toBe(result.trim());
  });
});

describe('stripQuotedText — no quoted text', () => {
  it('returns content trim()ed unchanged if no marker', () => {
    const body = [
      'Bonjour Marc,',
      '',
      'Voici un mail simple sans aucune citation.',
      'Le projet avance bien.',
      '',
      'Cordialement,',
      'Vincent',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result).toContain('Bonjour Marc');
    expect(result).toContain('Voici un mail simple');
    expect(result).toContain('Le projet avance bien');
    expect(result).toContain('Vincent');
    expect(result).toBe(result.trim());
  });

  it('preserves content even with initial trim()', () => {
    const body = '\n\n  Contenu unique sans citation.  \n\n';
    const result = stripQuotedText(body);
    expect(result).toBe('Contenu unique sans citation.');
  });
});

describe('stripQuotedText — empty or null input', () => {
  it('returns empty string for null', () => {
    expect(stripQuotedText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(stripQuotedText(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(stripQuotedText('')).toBe('');
  });
});
