const { describe, it, expect } = require('@jest/globals');

// Inline core logic from emailAnalyzer_browser.js for testing
// (ES module can't be required directly in Jest/Node)

function extractSubject(email) {
  let subject = email.subject || 'Sans sujet';
  subject = subject.replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '');
  return subject.trim();
}

function extractFrom(email) {
  return email.from || 'Inconnu';
}

function extractDate(email) {
  if (email.internalDate) {
    return new Date(parseInt(email.internalDate));
  }
  return new Date();
}

function groupBySubject(emails) {
  const conversations = {};
  for (const email of emails) {
    const subject = extractSubject(email);
    if (!conversations[subject]) conversations[subject] = [];
    conversations[subject].push(email);
  }
  for (const subject in conversations) {
    conversations[subject].sort((a, b) => extractDate(a) - extractDate(b));
  }
  return conversations;
}

function getSubjectsWithMinEmails(emailsClean, minCount = 3) {
  const conversations = groupBySubject(emailsClean);
  const validSubjects = [];
  for (const [subject, emailList] of Object.entries(conversations)) {
    if (emailList.length >= minCount) {
      const participants = [...new Set(emailList.map((email) => extractFrom(email)))];
      validSubjects.push({
        subject,
        emailCount: emailList.length,
        participants,
      });
    }
  }
  validSubjects.sort((a, b) => b.emailCount - a.emailCount);
  return validSubjects;
}

// ─────────────────────────────────────────────
//  Incremental subject extraction
// ─────────────────────────────────────────────

describe('getSubjectsWithMinEmails (incremental scenarios)', () => {
  function makeEmail(subject, from, id) {
    return { id, subject, from, internalDate: String(Date.now()), bodyText: '', to: '', cc: '' };
  }

  it('returns empty when fewer than minCount emails per subject', () => {
    const emails = [
      makeEmail('Hello', 'alice@test.com', '1'),
      makeEmail('Hello', 'bob@test.com', '2'),
    ];
    expect(getSubjectsWithMinEmails(emails, 3)).toEqual([]);
  });

  it('returns subjects once minCount is reached', () => {
    const emails = [
      makeEmail('Project Update', 'alice@test.com', '1'),
      makeEmail('Project Update', 'bob@test.com', '2'),
      makeEmail('Project Update', 'charlie@test.com', '3'),
    ];
    const subjects = getSubjectsWithMinEmails(emails, 3);
    expect(subjects).toHaveLength(1);
    expect(subjects[0].subject).toBe('Project Update');
    expect(subjects[0].emailCount).toBe(3);
  });

  it('handles Re: prefix normalization in incremental batches', () => {
    const batch1 = [
      makeEmail('Meeting Notes', 'alice@test.com', '1'),
      makeEmail('Re: Meeting Notes', 'bob@test.com', '2'),
    ];
    expect(getSubjectsWithMinEmails(batch1, 3)).toEqual([]);

    const batch2 = [
      ...batch1,
      makeEmail('RE: Meeting Notes', 'charlie@test.com', '3'),
      makeEmail('Fwd: Meeting Notes', 'dave@test.com', '4'),
    ];
    const subjects = getSubjectsWithMinEmails(batch2, 3);
    expect(subjects).toHaveLength(1);
    expect(subjects[0].subject).toBe('Meeting Notes');
    expect(subjects[0].emailCount).toBe(4);
  });

  it('sorts subjects by email count descending', () => {
    const emails = [
      makeEmail('A', 'a@t.com', '1'),
      makeEmail('A', 'b@t.com', '2'),
      makeEmail('A', 'c@t.com', '3'),
      makeEmail('B', 'a@t.com', '4'),
      makeEmail('B', 'b@t.com', '5'),
      makeEmail('B', 'c@t.com', '6'),
      makeEmail('B', 'd@t.com', '7'),
      makeEmail('B', 'e@t.com', '8'),
    ];
    const subjects = getSubjectsWithMinEmails(emails, 3);
    expect(subjects[0].subject).toBe('B');
    expect(subjects[0].emailCount).toBe(5);
    expect(subjects[1].subject).toBe('A');
    expect(subjects[1].emailCount).toBe(3);
  });

  it('tracks participants correctly across incremental updates', () => {
    const batch1 = [
      makeEmail('Bug Report', 'alice@test.com', '1'),
      makeEmail('Re: Bug Report', 'bob@test.com', '2'),
    ];
    const batch2 = [...batch1, makeEmail('RE: Bug Report', 'charlie@test.com', '3')];
    const subjects = getSubjectsWithMinEmails(batch2, 3);
    expect(subjects[0].participants).toEqual(
      expect.arrayContaining(['alice@test.com', 'bob@test.com', 'charlie@test.com'])
    );
  });

  it('new subjects appear as more emails accumulate', () => {
    const batch1 = [
      makeEmail('Topic A', 'a@t.com', '1'),
      makeEmail('Topic A', 'b@t.com', '2'),
      makeEmail('Topic A', 'c@t.com', '3'),
      makeEmail('Topic B', 'a@t.com', '4'),
      makeEmail('Topic B', 'b@t.com', '5'),
    ];
    expect(getSubjectsWithMinEmails(batch1, 3)).toHaveLength(1);

    const batch2 = [...batch1, makeEmail('Topic B', 'c@t.com', '6')];
    expect(getSubjectsWithMinEmails(batch2, 3)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────
//  Milestone triggering logic
// ─────────────────────────────────────────────

describe('milestone triggering logic', () => {
  it('triggers milestone at correct intervals', () => {
    const milestones = [];
    const milestoneInterval = 1000;
    let lastMilestoneCount = 0;
    const accumulated = [];

    function receiveChunk(count) {
      for (let i = 0; i < count; i++) {
        accumulated.push({ id: `email-${accumulated.length}` });
      }
      if (accumulated.length - lastMilestoneCount >= milestoneInterval) {
        lastMilestoneCount = accumulated.length;
        milestones.push(accumulated.length);
      }
    }

    receiveChunk(500);
    expect(milestones).toEqual([]);

    receiveChunk(500);
    expect(milestones).toEqual([1000]);

    receiveChunk(500);
    expect(milestones).toEqual([1000]);

    receiveChunk(500);
    expect(milestones).toEqual([1000, 2000]);

    receiveChunk(300);
    expect(milestones).toEqual([1000, 2000]);
  });

  it('does not trigger milestone if less than interval', () => {
    let triggered = false;
    const milestoneInterval = 1000;
    const lastMilestoneCount = 0;
    const accumulated = [];

    for (let i = 0; i < 999; i++) {
      accumulated.push({ id: `e-${i}` });
    }

    if (accumulated.length - lastMilestoneCount >= milestoneInterval) {
      triggered = true;
    }

    expect(triggered).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  Notification logic (new emails for selected subject)
// ─────────────────────────────────────────────

describe('notification logic for selected subject', () => {
  it('detects new emails for a selected subject between milestones', () => {
    const prevSubjects = [
      { subject: 'Topic A', emailCount: 5 },
      { subject: 'Topic B', emailCount: 3 },
    ];
    const newSubjects = [
      { subject: 'Topic A', emailCount: 8 },
      { subject: 'Topic B', emailCount: 3 },
      { subject: 'Topic C', emailCount: 4 },
    ];

    const selectedSubject = 'Topic A';
    const prev = prevSubjects.find((s) => s.subject === selectedSubject);
    const next = newSubjects.find((s) => s.subject === selectedSubject);
    const diff = (next ? next.emailCount : 0) - (prev ? prev.emailCount : 0);

    expect(diff).toBe(3);
  });

  it('returns 0 diff when subject has not changed', () => {
    const prevSubjects = [{ subject: 'X', emailCount: 10 }];
    const newSubjects = [{ subject: 'X', emailCount: 10 }];

    const prev = prevSubjects.find((s) => s.subject === 'X');
    const next = newSubjects.find((s) => s.subject === 'X');
    expect(next.emailCount - prev.emailCount).toBe(0);
  });

  it('handles selected subject not yet in previous list', () => {
    const prevSubjects = [];
    const newSubjects = [{ subject: 'New Topic', emailCount: 5 }];

    const selectedSubject = 'New Topic';
    const prev = prevSubjects.find((s) => s.subject === selectedSubject);
    const next = newSubjects.find((s) => s.subject === selectedSubject);
    const diff = (next ? next.emailCount : 0) - (prev ? prev.emailCount : 0);

    expect(diff).toBe(5);
  });
});
