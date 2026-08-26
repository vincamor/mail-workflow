#!/usr/bin/env node
/**
 * Generates the bundled demo dataset:
 *   src/public/demo/gmail_emails.jsonl        (one email per line, no bodyHtml)
 *   src/public/demo/gmail_emails_html.jsonl   ({ id, bodyHtml } companion)
 *
 * The record shape mirrors EXACTLY what the real app writes to disk:
 * `formatGmailEmail()` in src/services/gmailService.js, minus the four fields
 * the front-end strips before writing (`bodyHtml`, `sizeEstimate`, `historyId`,
 * `labelIds` — see the download loop in src/public/js/emails.js).
 *
 * Everything here is ENTIRELY FICTIONAL. No line of it comes from a real
 * mailbox; every address lives under example.com / example.org, which RFC 2606
 * reserves for documentation. This project is privacy-first — a demo fixture
 * carrying real mail would be a credibility disaster.
 *
 * Output is deterministic: fixed base date, counter-derived ids, no Date.now().
 * Regenerating produces a byte-identical file unless the content below changes.
 *
 * Usage: node scripts/generate-demo-data.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'src', 'public', 'demo');
const MAIN_FILE = path.join(OUT_DIR, 'gmail_emails.jsonl');
const HTML_FILE = path.join(OUT_DIR, 'gmail_emails_html.jsonl');

// ─── People (all fictional, all under reserved documentation domains) ────────

const PEOPLE = {
  demo: { name: 'Demo User', email: 'demo@example.com', title: 'Engineering' },
  maya: { name: 'Maya Oberon', email: 'maya.oberon@example.com', title: 'Head of Platform' },
  theo: {
    name: 'Theo Reyes',
    email: 'theo.reyes@example.org',
    title: 'Staff Engineer - Ingestion',
  },
  ines: { name: 'Ines Calder', email: 'ines.calder@example.com', title: 'Data & Reporting' },
  rafael: { name: 'Rafael Kim', email: 'rafael.kim@example.org', title: 'Infrastructure' },
  nadia: { name: 'Nadia Brennt', email: 'nadia.brennt@example.com', title: 'Product Design' },
  owen: { name: 'Owen Salter', email: 'owen.salter@example.org', title: 'Engineering Manager' },
  priya: { name: 'Priya Vashti', email: 'priya.vashti@example.com', title: 'Product & Compliance' },
  news: { name: 'Orbital Weekly', email: 'newsletter@example.org' },
  billing: { name: 'Northwind Supply', email: 'no-reply@example.org' },
};

/** "Name <address>" — never contains a comma, so the analyzer can split on "," */
function addr(key) {
  const p = PEOPLE[key];
  if (!p) throw new Error(`Unknown person: ${key}`);
  return `${p.name} <${p.email}>`;
}

function addrList(keys) {
  return (keys || []).map(addr).join(', ');
}

// ─── Deterministic identifiers ──────────────────────────────────────────────

let seq = 0;

/** 16-hex-char id, same shape as a Gmail message id, derived from a counter. */
function nextId() {
  seq += 1;
  return (0x18f2a4c9b0d1e2f3n + BigInt(seq) * 0x9e3779b97f4a7c15n).toString(16).slice(-16);
}

// ─── Deterministic RFC 2822 dates ───────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 2822 Date header, always rendered in +0000 so output never depends on TZ. */
function rfc2822(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

/** Fixed anchor: Monday 3 March 2025, 08:00 UTC. */
const BASE_TS = Date.UTC(2025, 2, 3, 8, 0, 0);
const MINUTE = 60 * 1000;

// ─── HTML helpers ───────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphsToHtml(paragraphs) {
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

/**
 * Gmail-style quoted reply block. The app's quote toggle looks for
 * `.gmail_quote` / `<blockquote>`, so the demo exercises it for real.
 */
function quoteBlock(parent) {
  if (!parent) return '';
  const intro = `On ${parent.date}, ${escapeHtml(parent.from)} wrote:`;
  const quoted = parent.bodyParagraphs.map((p) => `<div>${escapeHtml(p)}</div>`).join('\n');
  return [
    '<div class="gmail_quote">',
    `  <div dir="ltr" class="gmail_attr">${intro}</div>`,
    '  <blockquote class="gmail_quote">',
    quoted,
    '  </blockquote>',
    '</div>',
  ].join('\n');
}

/** Plain-text signature, the usual "-- " delimiter included. */
function signatureText(key) {
  const p = PEOPLE[key];
  return `-- \n${p.name}\n${p.title || ''}\n${p.email}`.replace(/\n\n/g, '\n');
}

/** HTML counterpart of the signature. */
function signatureHtml(key) {
  const p = PEOPLE[key];
  return [
    '<div class="signature" style="margin-top:16px;color:#6b7885;font-size:13px">',
    '  <div>--</div>',
    `  <div><strong>${escapeHtml(p.name)}</strong></div>`,
    p.title ? `  <div>${escapeHtml(p.title)}</div>` : '',
    `  <div><a href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a></div>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

function snippetOf(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

// ─── Thread builder ─────────────────────────────────────────────────────────

const allEmails = [];

/**
 * @param {Object} spec
 * @param {string} spec.subject           base subject (replies get "Re: ")
 * @param {number} spec.startOffsetMin    minutes after BASE_TS for the root
 * @param {Array}  spec.messages          [{ from, to, cc, gapMin, parent, body[], hasAttachments, html }]
 *        `parent` is the 0-based index of the message being replied to (root has none).
 */
function buildThread(spec) {
  const built = [];
  const threadIdHolder = {};
  let ts = BASE_TS + spec.startOffsetMin * MINUTE;

  spec.messages.forEach((m, i) => {
    ts += (m.gapMin || 0) * MINUTE;
    const id = nextId();
    if (i === 0) threadIdHolder.id = id;

    const parent = typeof m.parent === 'number' ? built[m.parent] : null;
    if (typeof m.parent === 'number' && !parent) {
      throw new Error(
        `Thread "${spec.subject}": message ${i} references unknown parent ${m.parent}`
      );
    }

    const messageId = `<${id}.${String(i).padStart(2, '0')}.${threadIdHolder.id}@mail.example.com>`;
    // References = the full ancestor chain, exactly like a real MUA builds it.
    const references = parent ? `${parent.references} ${parent.messageId}`.trim() : '';

    // Real mail carries a signature; the demo renders bodies in a sandboxed
    // iframe, so keeping one makes the preview look like an actual message.
    const bodyParagraphs = [...m.body, signatureText(m.from)];
    const bodyText = bodyParagraphs.join('\n\n');
    const email = {
      id,
      threadId: threadIdHolder.id,
      snippet: snippetOf(bodyText),
      subject: i === 0 ? spec.subject : `Re: ${spec.subject}`,
      from: addr(m.from),
      to: addrList(m.to),
      cc: addrList(m.cc),
      date: rfc2822(ts),
      messageId,
      inReplyTo: parent ? parent.messageId : '',
      references,
      internalDate: String(ts),
      hasAttachments: m.hasAttachments === true,
      bodyText,
    };

    // Kept aside for the quote block of the children; not part of the record.
    email.bodyParagraphs = bodyParagraphs;

    const ownHtml = m.html ? m.html : paragraphsToHtml(m.body);
    email.bodyHtml = [
      '<div dir="ltr">',
      ownHtml,
      signatureHtml(m.from),
      parent ? quoteBlock(parent) : '',
      '</div>',
    ]
      .filter(Boolean)
      .join('\n');

    built.push(email);
    allEmails.push(email);
  });

  return built;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FLAGSHIP THREAD — 5 participants, 15 messages, two diverging branches.
//
// The tree topology produced by createTemporalGroupTree() comes from the
// participant SET of each message (from + to + cc): a message joins the most
// recent message sharing its exact set, otherwise it hangs off its In-Reply-To.
// Three sets are used on purpose:
//   A = everyone (trunk)
//   B = Demo + Maya      (private side-thread, branches off message 2)
//   C = Theo + Rafael + Demo (infra sub-thread, branches off message 7)
// ═══════════════════════════════════════════════════════════════════════════

const ALL5 = ['demo', 'maya', 'theo', 'ines', 'rafael'];
const others = (self) => ALL5.filter((k) => k !== self);

buildThread({
  subject: 'Q3 platform migration - kickoff and open questions',
  startOffsetMin: 0,
  messages: [
    {
      from: 'maya',
      to: others('maya'),
      gapMin: 0,
      body: [
        'Hi everyone,',
        'We are green-lit for the Q3 platform migration. The goal is to move the ingestion pipeline and the reporting service off the legacy cluster before the end of September, with no customer-visible downtime.',
        'I have blocked two hours on Thursday for a kickoff. Before then, I would like each of you to write down the three things that worry you most about your own area. We will start from those instead of from a happy-path plan.',
        'Rough shape of the plan as I see it today: dual-write for four weeks, shadow reads for two, then a cutover per tenant starting with the smallest accounts.',
      ],
    },
    {
      from: 'theo',
      to: others('theo'),
      gapMin: 47,
      parent: 0,
      body: [
        'Thanks Maya. My three worries, in order:',
        '1. The ingestion pipeline still writes directly to the legacy schema in two places (the backfill job and the manual replay tool). Dual-write does not cover those, so a cutover would silently drop rows.',
        '2. We have no reliable way to compare shadow reads. The reporting service rounds differently on the new cluster, so a naive diff reports thousands of false positives.',
        '3. Nobody owns the rollback path. If a tenant cutover goes wrong at 3am, I do not know who is allowed to flip it back.',
        'None of these are blockers, but all three need an owner before we start dual-writing.',
      ],
    },
    {
      from: 'ines',
      to: others('ines'),
      gapMin: 92,
      parent: 1,
      hasAttachments: true,
      body: [
        'Adding the tenant inventory I promised (attached). 412 tenants, of which term 38 are on the old billing plan and will need a manual data fix before they can move.',
        "On Theo's point 2: I can write the comparison harness. The rounding difference is real but it is deterministic, so a tolerance-based diff should get us to a usable signal in a day or two.",
        'What I cannot do alone is the billing-plan migration. That needs someone who understands the historical pricing rules, and honestly that is only Rafael.',
      ],
    },
    {
      from: 'demo',
      to: ['maya'],
      gapMin: 25,
      parent: 1,
      body: [
        'Maya, quick side question before I answer on the thread.',
        "Are we actually committed to the end-of-September date, or is that the date we would like? I ask because Theo's point about the rollback owner is the kind of thing that takes three weeks of arguing, not three days, and I would rather we build the schedule around that than pretend it is free.",
        'If the date is firm I will plan for it, I just do not want to discover in August that it was always aspirational.',
      ],
    },
    {
      from: 'maya',
      to: ['demo'],
      gapMin: 18,
      parent: 3,
      body: [
        'Fair question, and thank you for asking it here rather than on the thread.',
        'The date is firm for the ingestion pipeline because the legacy cluster contract ends on 30 September and finance already declined to renew for a month. The reporting service is softer - we could run it on the old cluster through October at a painful but survivable cost.',
        "So: hard deadline for Theo's half, negotiable for Ines's half. I would rather that stayed between us until I have the cost number in writing.",
      ],
    },
    {
      from: 'demo',
      to: ['maya'],
      gapMin: 12,
      parent: 4,
      body: [
        'Understood. That changes my read of the whole plan - the ingestion side is the one with no slack, so it should get the rollback owner and the on-call rota, not the reporting side.',
        'I will push in that direction on the main thread without quoting the contract detail.',
      ],
    },
    {
      from: 'rafael',
      to: others('rafael'),
      gapMin: 63,
      parent: 2,
      body: [
        'Picking up the billing-plan question. Yes, the historical pricing rules are mostly in my head and partly in a spreadsheet that predates me, which is exactly the problem.',
        'I can migrate the 38 legacy-plan tenants, but I want to write the rules down as code first rather than doing it by hand. That is about a week of work and it pays for itself the next time anyone touches billing.',
        'Separately: whoever owns the rollback path needs infra permissions we currently give to two people. Worth fixing before the migration rather than during it.',
      ],
    },
    {
      from: 'theo',
      to: ['demo', 'rafael'],
      gapMin: 31,
      parent: 6,
      body: [
        "Rafael, Demo - pulling the infra permissions piece off the main thread so we do not derail Maya's kickoff.",
        'Today the cutover toggle is guarded by the platform-admin role, which is exactly two humans, both in the same timezone. For a per-tenant cutover running over six weeks that is not viable.',
        'Proposal: a narrow role that can only flip the tenant routing flag, granted to the migration on-call rota for the duration and revoked automatically at the end. Thoughts?',
      ],
    },
    {
      from: 'rafael',
      to: ['theo', 'demo'],
      gapMin: 40,
      parent: 7,
      body: [
        'Strongly in favour, with one change: make the revocation a scheduled job from day one rather than a calendar reminder. Temporary permissions that depend on someone remembering are permanent permissions.',
        'I can have the role definition ready by Wednesday if Theo writes the routing-flag guard.',
      ],
    },
    {
      from: 'demo',
      to: ['theo', 'rafael'],
      gapMin: 55,
      parent: 8,
      hasAttachments: true,
      body: [
        'Both good. I have sketched the rota and the escalation path in the attached document - one primary and one secondary per week, primary holds the narrow role, secondary holds nothing until they are paged.',
        'One open question I could not resolve: during a cutover window, does the on-call primary need approval to roll back, or do they just do it and write it up afterwards? I have assumed the second, because the first is how you get a two-hour outage while people look for a manager.',
      ],
    },
    {
      from: 'ines',
      to: others('ines'),
      gapMin: 88,
      parent: 6,
      body: [
        "Comparison harness is up. First run over yesterday's traffic: 1.2 million rows compared, 340 mismatches, all of them in the same two report types and all within the rounding tolerance once I widened it to one cent.",
        'That means shadow reads are usable now rather than in three weeks. I would like to start the two-week shadow window on Monday instead of waiting for the dual-write work to finish, since they are independent.',
        'Maya, that would pull the whole schedule forward by about ten days if it holds.',
      ],
    },
    {
      from: 'maya',
      to: ['demo'],
      gapMin: 22,
      parent: 5,
      body: [
        'Cost number came back: running reporting on the legacy cluster through October is 41k. Finance will sign it but they want it framed as contingency, not as plan.',
        'So your read was right. I am going to put the rollback owner and the rota on the ingestion side and let reporting float.',
      ],
    },
    {
      from: 'demo',
      to: others('demo'),
      gapMin: 34,
      parent: 10,
      body: [
        'Summarising where we are, so Thursday can be about decisions rather than status.',
        'Agreed: Ines starts the shadow window Monday. Rafael codifies the pricing rules before migrating the 38 legacy-plan tenants. Theo and Rafael ship the narrow cutover role with automatic revocation.',
        'Still open: who owns rollback for the ingestion pipeline, and whether the on-call primary can roll back without approval. I have argued for yes - we should settle it Thursday and write it down.',
        "Not yet discussed at all: what we tell customers, and when. Ines's inventory says 38 tenants need a manual fix, and those people will notice.",
      ],
    },
    {
      from: 'theo',
      to: others('theo'),
      gapMin: 71,
      parent: 12,
      body: [
        'Good summary. On rollback ownership I will take it for the ingestion pipeline, on the condition that the narrow role lands first - I am not accepting an ownership title without the permissions that make it real.',
        'On customer communication: the 38 tenants are all on the old billing plan, so they already have a named account contact. That is a much easier conversation than a blanket notice.',
      ],
    },
    {
      from: 'maya',
      to: others('maya'),
      gapMin: 46,
      parent: 13,
      body: [
        'Perfect. Theo owns ingestion rollback, contingent on the role landing - that is a fair condition and I will make sure it is not the thing that slips.',
        'Thursday agenda, then: approval-free rollback yes or no, customer comms plan for the 38 named accounts, and a date for the first tenant cutover. Everything else is now a status update and can stay on this thread.',
        'Thank you all - this is the most useful pre-kickoff thread I have had in a while.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Design review — 4 participants, 10 messages, one side branch.
// ═══════════════════════════════════════════════════════════════════════════

const DESIGN4 = ['demo', 'nadia', 'owen', 'priya'];
const dOthers = (self) => DESIGN4.filter((k) => k !== self);

buildThread({
  subject: 'Design review: onboarding flow v3',
  startOffsetMin: 60 * 26,
  messages: [
    {
      from: 'nadia',
      to: dOthers('nadia'),
      gapMin: 0,
      body: [
        'v3 of the onboarding flow is ready for review. The big change from v2 is that we no longer ask for the company size and the industry on the first screen - both moved to an optional step after the first successful action.',
        'The prototype has the three entry points wired: invited by a teammate, self-serve signup, and returning from a dead trial. Please walk all three, they diverge more than you would expect.',
      ],
    },
    {
      from: 'owen',
      to: dOthers('owen'),
      gapMin: 130,
      parent: 0,
      body: [
        'Walked all three. The invited-by-teammate path is a clear improvement - four screens down to two, and the workspace context is visible the whole way through.',
        'The self-serve path still asks for a password before it shows any value. Every time we test that we lose people at exactly that screen, and v3 has not changed it.',
      ],
    },
    {
      from: 'priya',
      to: dOthers('priya'),
      gapMin: 95,
      parent: 1,
      body: [
        'Agreeing with Owen on the password screen, and adding a data point: in the last cohort, 31 percent of self-serve signups abandoned on it. The invited path abandoned at 6 percent.',
        'I do not think the fix is to move the password later. I think the fix is to not have one - magic link first, password only if they ask for it.',
      ],
    },
    {
      from: 'demo',
      to: dOthers('demo'),
      gapMin: 41,
      parent: 2,
      body: [
        'Magic link first is the right call and it is also a two-week change, not a two-day one. Session handling, the email deliverability work, and the account recovery story all move.',
        'Can we split it? Ship v3 as designed now, since it is a real improvement on the invited path, and treat passwordless as its own project with its own timeline rather than smuggling it into a design review.',
      ],
    },
    {
      from: 'nadia',
      to: ['demo'],
      gapMin: 28,
      parent: 3,
      body: [
        'Thank you for saying that. I have been trying to make the same point for a week without sounding like I am protecting my own design.',
        'If we hold v3 for passwordless it ships in June, and the invited path - which is the one sales actually demos - stays bad for three more months for no reason.',
      ],
    },
    {
      from: 'demo',
      to: ['nadia'],
      gapMin: 15,
      parent: 4,
      body: [
        'It did not read as defensive to me, for what it is worth. Owen and Priya are right about the problem and you are right about the sequencing - those are not in conflict.',
        'I will put the split proposal on the thread explicitly so it is a decision rather than an implication.',
      ],
    },
    {
      from: 'priya',
      to: dOthers('priya'),
      gapMin: 66,
      parent: 3,
      body: [
        'Fine with splitting, with one request: if v3 ships as designed, we instrument the password screen properly this time. Right now we know the abandon rate but not whether they leave, come back later, or sign up with a different address.',
        'That data is what will make the passwordless project a five-minute decision instead of another review cycle.',
      ],
    },
    {
      from: 'owen',
      to: dOthers('owen'),
      gapMin: 52,
      parent: 6,
      hasAttachments: true,
      body: [
        'No objection. Attaching the annotated screens with the eleven smaller issues I found - none of them block, most are spacing and copy.',
        'The one I would like fixed before ship is the error state on the workspace-name field. It currently says "invalid" for a name that is merely taken, which sends people down the wrong path.',
      ],
    },
    {
      from: 'nadia',
      to: dOthers('nadia'),
      gapMin: 120,
      parent: 7,
      body: [
        'All eleven are in. The workspace-name error now distinguishes taken from invalid and offers two suggestions when it is taken.',
        'Rebuilt prototype is at the same link. If nobody objects by Friday I will call v3 approved and hand it to engineering.',
      ],
    },
    {
      from: 'demo',
      to: dOthers('demo'),
      gapMin: 180,
      parent: 8,
      body: [
        'No objection. v3 approved from my side.',
        'Priya, can you open the instrumentation ticket so it does not get remembered as "we agreed to do that" and then not done? I have been on the wrong end of that sentence too many times.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Budget approval — 3 participants, 8 messages.
// ═══════════════════════════════════════════════════════════════════════════

buildThread({
  subject: 'Budget approval for the Helios contract',
  startOffsetMin: 60 * 52,
  messages: [
    {
      from: 'ines',
      to: ['demo', 'maya'],
      gapMin: 0,
      body: [
        'The Helios renewal lands on 30 April and the quote came in 22 percent above last year. I need a decision by the 15th to keep the current rate locked.',
        "Attached the quote and last year's usage. Short version: we are paying for a tier we outgrew in November, so part of the increase is real and part of it is us not having renegotiated when we should have.",
      ],
      hasAttachments: true,
    },
    {
      from: 'demo',
      to: ['ines', 'maya'],
      gapMin: 74,
      parent: 0,
      body: [
        'Reading the usage numbers, we are at 71 percent of the next tier down for nine of the last twelve months. The three months where we exceeded it are all in the same quarter and they line up with the batch reprocessing we ran once.',
        'So the honest answer is that we should be on the smaller tier plus burst pricing, not the bigger tier flat. That is a different conversation with Helios than "please reduce the increase".',
      ],
    },
    {
      from: 'maya',
      to: ['demo', 'ines'],
      gapMin: 110,
      parent: 1,
      body: [
        'Agreed on the shape. Ines, do we have any leverage? A 22 percent increase suggests they think we cannot move.',
        'If there is a credible alternative we should mention it early rather than at the end, when it reads as a bluff.',
      ],
    },
    {
      from: 'ines',
      to: ['demo', 'maya'],
      gapMin: 87,
      parent: 2,
      body: [
        'Some. Two competitors would take the workload, and one of them has been asking for a call for six months. Migration cost is the problem - realistically a quarter of engineering time, which is more than the difference in price.',
        'So we have leverage on paper and less in practice. I would rather negotiate honestly on tier structure than threaten a move we would not make.',
      ],
    },
    {
      from: 'demo',
      to: ['ines', 'maya'],
      gapMin: 45,
      parent: 3,
      body: [
        'That is the right instinct. Bluffing with a migration we will not do costs us the next three negotiations too.',
        'Proposed ask: smaller tier, burst pricing for reprocessing windows, twelve-month term instead of twenty-four. If they hold at the bigger tier, we take a six-month extension at the current rate and revisit with real burst data.',
      ],
    },
    {
      from: 'maya',
      to: ['demo', 'ines'],
      gapMin: 130,
      parent: 4,
      body: [
        'Approved on that basis. Ines, you have authority up to the current annual figure plus 8 percent without coming back to me.',
        'Anything above that, or any change to the term length, comes back to this thread.',
      ],
    },
    {
      from: 'ines',
      to: ['demo', 'maya'],
      gapMin: 60 * 22,
      parent: 5,
      body: [
        "Call done. They will do the smaller tier with burst pricing, twelve-month term, at 4 percent above last year's total.",
        'They pushed for twenty-four months at 2 percent and I declined, on the grounds that we do not know our own burst profile yet. Landing inside the authority you gave me.',
      ],
    },
    {
      from: 'demo',
      to: ['ines', 'maya'],
      gapMin: 40,
      parent: 6,
      body: [
        'That is a good outcome, and declining the twenty-four-month discount was the right call.',
        'One follow-up: can we get the burst usage on a monthly report rather than discovering it at renewal? The whole reason this was a scramble is that nobody looked at the tier fit for eighteen months.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Short 2-participant thread — deliberate contrast with the flagship.
// ═══════════════════════════════════════════════════════════════════════════

buildThread({
  subject: 'Lunch on Thursday?',
  startOffsetMin: 60 * 70,
  messages: [
    {
      from: 'owen',
      to: ['demo'],
      gapMin: 0,
      body: [
        'Are you around on Thursday? There is a new place near the office that does a proper lunch in under forty minutes, which feels like a minor miracle.',
        'I also want to pick your brain about the reporting rewrite, but mostly it is about the lunch.',
      ],
    },
    {
      from: 'demo',
      to: ['owen'],
      gapMin: 35,
      parent: 0,
      body: [
        'Thursday works if we go at 12:30 - I have the migration kickoff until noon and it will overrun, they always do.',
        'Happy to talk about the reporting rewrite. Fair warning: my opinion is that it should be a rewrite of about a third of it and a deletion of the rest.',
      ],
    },
    {
      from: 'owen',
      to: ['demo'],
      gapMin: 21,
      parent: 1,
      body: [
        '12:30 is fine. And that is more or less my view too, so this may be a short and agreeable conversation.',
        'Booked for two.',
      ],
    },
    {
      from: 'demo',
      to: ['owen'],
      gapMin: 60 * 20,
      parent: 2,
      body: [
        'Good lunch, and the forty-minute claim held up.',
        'Writing down what we agreed before it evaporates: keep the scheduler and the export layer, rewrite the aggregation, delete the three legacy report types nobody has opened in a year. I will check that last claim before saying it out loud in a meeting.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Vendor questionnaire — 3 participants, 6 messages, rich HTML in the mix.
// ═══════════════════════════════════════════════════════════════════════════

buildThread({
  subject: 'Vendor questionnaire - security section',
  startOffsetMin: 60 * 96,
  messages: [
    {
      from: 'priya',
      to: ['demo', 'rafael'],
      gapMin: 0,
      body: [
        'The Halden Group security questionnaire came back with four items flagged. They are blocking the contract until we answer them, and their deadline is next Friday.',
        'The four items are data residency, encryption at rest, subprocessor list, and incident notification window. I can answer the first three from the existing policy. The fourth I cannot, because our policy says "without undue delay" and they want a number of hours.',
      ],
    },
    {
      from: 'rafael',
      to: ['demo', 'priya'],
      gapMin: 96,
      parent: 0,
      html: [
        '<p>Here is where we actually stand on the four items, rather than what the policy document claims:</p>',
        '<table style="border-collapse:collapse;font-family:inherit;font-size:14px" cellpadding="6">',
        '  <thead><tr style="background:#f4f6f8;text-align:left">',
        '    <th style="border:1px solid #d9dee3">Item</th>',
        '    <th style="border:1px solid #d9dee3">Reality</th>',
        '    <th style="border:1px solid #d9dee3">Answerable today?</th>',
        '  </tr></thead>',
        '  <tbody>',
        '    <tr><td style="border:1px solid #d9dee3">Data residency</td><td style="border:1px solid #d9dee3">EU only, single region</td><td style="border:1px solid #d9dee3">Yes</td></tr>',
        '    <tr><td style="border:1px solid #d9dee3">Encryption at rest</td><td style="border:1px solid #d9dee3">AES-256, managed keys</td><td style="border:1px solid #d9dee3">Yes</td></tr>',
        '    <tr><td style="border:1px solid #d9dee3">Subprocessors</td><td style="border:1px solid #d9dee3">Nine, list is four months stale</td><td style="border:1px solid #d9dee3">After a refresh</td></tr>',
        '    <tr><td style="border:1px solid #d9dee3">Incident window</td><td style="border:1px solid #d9dee3">No committed number</td><td style="border:1px solid #d9dee3"><strong>No</strong></td></tr>',
        '  </tbody>',
        '</table>',
        '<p>The subprocessor list is the easy one - it is stale, not wrong, and I can refresh it in an afternoon.</p>',
        '<p>The incident window is a genuine commitment and should not be invented on a questionnaire deadline.</p>',
      ].join('\n'),
      body: [
        'Here is where we actually stand on the four items, rather than what the policy document claims:',
        'Data residency: EU only, single region - answerable today. Encryption at rest: AES-256 with managed keys - answerable today. Subprocessors: nine of them, and the published list is four months stale. Incident notification: no committed number anywhere.',
        'The subprocessor list is the easy one - it is stale, not wrong, and I can refresh it in an afternoon.',
        'The incident window is a genuine commitment and should not be invented on a questionnaire deadline.',
      ],
    },
    {
      from: 'demo',
      to: ['priya', 'rafael'],
      gapMin: 58,
      parent: 1,
      body: [
        'Agreed that we should not invent the number. But "we have no commitment" is also an answer that loses the contract, so we need to pick one and be able to keep it.',
        'What would we actually be able to do today? If a serious incident started at 2am on a Sunday, how long before a named customer contact hears from a human?',
      ],
    },
    {
      from: 'rafael',
      to: ['demo', 'priya'],
      gapMin: 44,
      parent: 2,
      body: [
        'Honestly: detection is fast, maybe fifteen minutes. Deciding it is customer-affecting takes an hour or two because that judgement sits with one person who may be asleep. Drafting and sending the notice is another hour once someone has decided.',
        'So four hours is a promise we could keep with the current setup on a good night. Twenty-four hours is a promise we could keep on any night. I would commit to twenty-four and aim for four.',
      ],
    },
    {
      from: 'priya',
      to: ['demo', 'rafael'],
      gapMin: 70,
      parent: 3,
      hasAttachments: true,
      body: [
        'Twenty-four hours matches what their other vendors commit to - I checked the two we know about. I will write it as twenty-four with a stated target of four.',
        'Draft answers for all four items attached. Rafael, the subprocessor table is the one I need you to check line by line, since I built it from the stale list plus guesses.',
      ],
    },
    {
      from: 'demo',
      to: ['priya', 'rafael'],
      gapMin: 150,
      parent: 4,
      body: [
        'Read the draft, it is good. One edit: in the incident section you wrote "we will notify affected customers within 24 hours of confirmation". Drop "of confirmation" - it makes the clock start whenever we decide it starts, and a careful reader will notice.',
        'Twenty-four hours from detection is a real commitment. Twenty-four hours from confirmation is not one.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Sprint retro — 4 participants, 9 messages.
// ═══════════════════════════════════════════════════════════════════════════

const RETRO4 = ['demo', 'theo', 'nadia', 'owen'];
const rOthers = (self) => RETRO4.filter((k) => k !== self);

buildThread({
  subject: 'Sprint 14 retro notes',
  startOffsetMin: 60 * 120,
  messages: [
    {
      from: 'theo',
      to: rOthers('theo'),
      gapMin: 0,
      body: [
        'Retro notes from this morning, for the two of you who could not make it.',
        'Went well: the deploy pipeline change cut our average deploy from 22 minutes to 6, and nobody rolled back all sprint. Went badly: we carried four tickets over, all four for the same reason - they were blocked on a review that took more than three days.',
      ],
    },
    {
      from: 'nadia',
      to: rOthers('nadia'),
      gapMin: 55,
      parent: 0,
      body: [
        'The review delay is the thing I would like us to actually fix rather than note again. This is the third retro in a row where it comes up.',
        'My read is that it is not laziness, it is that reviews land on whoever is named in the file history, and that is the same two people every time.',
      ],
    },
    {
      from: 'owen',
      to: rOthers('owen'),
      gapMin: 63,
      parent: 1,
      body: [
        'That matches the numbers. I pulled the last sixty pull requests: 44 of them went to the same two reviewers, and those are exactly the two with the longest median response time. Not a coincidence - they are slow because they are overloaded.',
        'Suggestion: round-robin assignment with an explicit opt-out, rather than history-based.',
      ],
    },
    {
      from: 'demo',
      to: rOthers('demo'),
      gapMin: 47,
      parent: 2,
      body: [
        'Round-robin will spread the load and slow down the reviews that need real context. The migration code genuinely should go to Theo, and routing it to someone else to be fair costs us more than it saves.',
        'Alternative: round-robin by default, with a small list of paths that are pinned to an owner. Most changes get a fast review from whoever is next; the ten percent that need context still go to the right person.',
      ],
    },
    {
      from: 'theo',
      to: rOthers('theo'),
      gapMin: 38,
      parent: 3,
      body: [
        'I would take that deal. My honest problem is not the volume, it is the interruption - a review that arrives mid-afternoon costs me the rest of the afternoon.',
        'If the pinned paths are narrow and the rest goes round-robin, I can batch mine into two windows a day and everyone gets a faster answer than they do now.',
      ],
    },
    {
      from: 'nadia',
      to: rOthers('nadia'),
      gapMin: 90,
      parent: 4,
      body: [
        'Batching is the actual insight here and I think it is bigger than the assignment change.',
        'If reviewers batch, then "three days" becomes "two windows", and the carried-over tickets mostly disappear. Can we try both for one sprint and measure?',
      ],
    },
    {
      from: 'owen',
      to: rOthers('owen'),
      gapMin: 110,
      parent: 5,
      body: [
        'Set up the round-robin with four pinned paths - migration, billing, auth, and the deploy pipeline. Everything else rotates.',
        'I will pull the same sixty-PR report at the end of Sprint 15 so we compare like with like rather than by feel.',
      ],
    },
    {
      from: 'demo',
      to: rOthers('demo'),
      gapMin: 60 * 18,
      parent: 6,
      body: [
        'One week in: median time to first review is down from 3.1 days to 0.9. Two people have used the opt-out, both for the right reason.',
        'The one thing that is worse: a few reviews are now shallower. That is the trade we chose, but we should watch whether it shows up as bugs in a month.',
      ],
    },
    {
      from: 'theo',
      to: rOthers('theo'),
      gapMin: 60 * 6,
      parent: 7,
      body: [
        'Confirming the batching half works for me. Two windows, no interruptions, and I have not felt behind once this week.',
        'Agreed on watching for shallow reviews. I would rather catch that in the numbers than in an incident.',
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Newsletter — single sender, no replies. Feeds the AI clean-up feature.
//    Rich HTML with an unsubscribe footer so the newsletter heuristic fires.
// ═══════════════════════════════════════════════════════════════════════════

function newsletterHtml(headline, items) {
  return [
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0">',
    '<tr><td align="center">',
    '<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e6ea;border-radius:8px">',
    '  <tr><td style="padding:24px 28px 8px">',
    '    <div style="font-size:12px;letter-spacing:.08em;color:#8a94a0;text-transform:uppercase">Orbital Weekly</div>',
    `    <h1 style="font-size:22px;margin:8px 0 0;color:#1b2733">${escapeHtml(headline)}</h1>`,
    '  </td></tr>',
    '  <tr><td style="padding:8px 28px 24px">',
    items
      .map(
        (it) =>
          `    <h2 style="font-size:16px;margin:20px 0 6px;color:#1b2733">${escapeHtml(it.title)}</h2>\n` +
          `    <p style="font-size:14px;line-height:1.6;margin:0;color:#3c4855">${escapeHtml(it.text)}</p>`
      )
      .join('\n'),
    '  </td></tr>',
    '  <tr><td style="padding:16px 28px 24px;border-top:1px solid #e2e6ea;font-size:12px;color:#8a94a0">',
    '    You are receiving this because you signed up for Orbital Weekly.',
    '    <a href="https://example.org/unsubscribe">Unsubscribe</a> &middot;',
    '    <a href="https://example.org/preferences">Email preferences</a> &middot;',
    '    <a href="https://example.org/archive">View in browser</a>',
    '  </td></tr>',
    '</table>',
    '</td></tr></table>',
  ].join('\n');
}

const NEWSLETTER_ISSUES = [
  {
    headline: 'Issue 41 - The cost of a fast build',
    items: [
      {
        title: 'Build times are a team-size problem',
        text: 'A ninety-second build feels free to the person who wrote the change and expensive to the team of thirty waiting behind it. This week we look at three teams that measured the queue instead of the build.',
      },
      {
        title: 'Caching is not free either',
        text: 'Every cache you add is a new way to be wrong. Two engineers describe the week they spent chasing a bug that was a stale artifact the whole time.',
      },
      {
        title: 'Reader question: when to stop optimising',
        text: 'Our answer, unsatisfying as ever: when the next hour of work saves less than the hour costs, measured over a quarter rather than a sprint.',
      },
    ],
  },
  {
    headline: 'Issue 42 - Migrations that finished',
    items: [
      {
        title: 'Six migrations, five survivors',
        text: 'We asked six teams that completed a platform migration what they would do differently. Five said the same thing: decide the rollback owner before writing any code.',
      },
      {
        title: 'The dual-write trap',
        text: 'Dual-writing is easy to start and hard to stop. The teams that finished had a written definition of done for the old path, not just the new one.',
      },
      {
        title: 'Shadow reads deserve a tolerance',
        text: 'Exact comparison sounds rigorous and produces noise. Every successful shadow-read setup we found had a tolerance and a documented reason for it.',
      },
    ],
  },
  {
    headline: 'Issue 43 - Reviews, batching, and interruption',
    items: [
      {
        title: 'Why your fastest reviewer is your slowest',
        text: 'Reviewer assignment by file history concentrates work on the people who already know the code, which is exactly the group with no spare hours.',
      },
      {
        title: 'Two windows a day',
        text: 'Batched reviews consistently beat continuous ones in the data we collected, but only where the team agreed on the windows in advance.',
      },
      {
        title: 'The shallow-review risk is real',
        text: 'Speed gains are easy to measure and quality losses are not. If you batch, pick a signal for depth before you start.',
      },
    ],
  },
  {
    headline: 'Issue 44 - Saying no to a twenty-four-month discount',
    items: [
      {
        title: 'Long contracts price your uncertainty',
        text: 'A two-year discount is cheap only if you know your usage profile. Several readers wrote in about paying for a tier they outgrew in month four.',
      },
      {
        title: 'Burst pricing, honestly assessed',
        text: 'Burst pricing works when your bursts are rare and real. If you burst every month, that is not a burst, that is your baseline.',
      },
      {
        title: 'Negotiating without a bluff',
        text: 'A migration threat you would not carry out costs you the next three negotiations. Two procurement leads explain what they say instead.',
      },
    ],
  },
  {
    headline: 'Issue 45 - Permissions that expire',
    items: [
      {
        title: 'Temporary access is permanent access',
        text: 'Unless revocation is a scheduled job rather than a calendar reminder. This is the single most repeated piece of advice we have published.',
      },
      {
        title: 'Narrow roles beat broad ones',
        text: 'A role that can flip exactly one flag is easier to grant widely and safer to forget about than a role that can do everything.',
      },
      {
        title: 'What we got wrong last week',
        text: 'Our build-queue maths in issue 41 assumed serial builds. Three readers corrected us, and they were right.',
      },
    ],
  },
];

{
  const subject = 'Orbital Weekly newsletter';
  const threadRootId = null;
  NEWSLETTER_ISSUES.forEach((issue, i) => {
    const ts = BASE_TS + (60 * 30 + i * 60 * 24 * 7) * MINUTE;
    const id = nextId();
    const bodyParagraphs = [
      issue.headline,
      ...issue.items.map((it) => `${it.title} - ${it.text}`),
      'You are receiving this because you signed up for Orbital Weekly. Unsubscribe or manage your email preferences at example.org.',
    ];
    const bodyText = bodyParagraphs.join('\n\n');
    const email = {
      id,
      threadId: id,
      snippet: snippetOf(bodyText),
      subject,
      from: addr('news'),
      to: addrList(['demo']),
      cc: '',
      date: rfc2822(ts),
      messageId: `<${id}.issue${41 + i}@newsletter.example.org>`,
      inReplyTo: '',
      references: '',
      internalDate: String(ts),
      hasAttachments: false,
      bodyText,
    };
    email.bodyParagraphs = bodyParagraphs;
    email.bodyHtml = newsletterHtml(issue.headline, issue.items);
    allEmails.push(email);
  });
  void threadRootId;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Transactional — automated receipts, another clean-up target.
// ═══════════════════════════════════════════════════════════════════════════

const RECEIPTS = [
  { ref: 'NW-40518', amount: '124.00', period: 'March 2025' },
  { ref: 'NW-41260', amount: '124.00', period: 'April 2025' },
  { ref: 'NW-42033', amount: '148.80', period: 'May 2025' },
];

RECEIPTS.forEach((r, i) => {
  const ts = BASE_TS + (60 * 12 + i * 60 * 24 * 30) * MINUTE;
  const id = nextId();
  const bodyParagraphs = [
    `Receipt ${r.ref}`,
    `Thank you for your payment. This is an automated message; please do not reply to this address.`,
    `Amount charged: EUR ${r.amount}. Billing period: ${r.period}. Payment method: card ending 4417.`,
    'Your invoice is available in the billing portal for the next 24 months. If you believe this charge is incorrect, contact support through the portal rather than by replying here.',
  ];
  const bodyText = bodyParagraphs.join('\n\n');
  const email = {
    id,
    threadId: id,
    snippet: snippetOf(bodyText),
    subject: 'Your Northwind Supply receipt',
    from: addr('billing'),
    to: addrList(['demo']),
    cc: '',
    date: rfc2822(ts),
    messageId: `<${id}.${r.ref}@billing.example.org>`,
    inReplyTo: '',
    references: '',
    internalDate: String(ts),
    hasAttachments: i === 2,
    bodyText,
  };
  email.bodyParagraphs = bodyParagraphs;
  email.bodyHtml = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#22303c">',
    `  <h2 style="font-size:18px;margin:0 0 12px">Receipt ${escapeHtml(r.ref)}</h2>`,
    '  <p style="margin:0 0 12px">Thank you for your payment. This is an automated message; please do not reply to this address.</p>',
    '  <table cellpadding="6" style="border-collapse:collapse;font-size:14px">',
    `    <tr><td style="border:1px solid #dfe4e8">Amount</td><td style="border:1px solid #dfe4e8">EUR ${escapeHtml(r.amount)}</td></tr>`,
    `    <tr><td style="border:1px solid #dfe4e8">Period</td><td style="border:1px solid #dfe4e8">${escapeHtml(r.period)}</td></tr>`,
    '    <tr><td style="border:1px solid #dfe4e8">Method</td><td style="border:1px solid #dfe4e8">Card ending 4417</td></tr>',
    '  </table>',
    '  <p style="margin:12px 0 0;font-size:12px;color:#7a8792">Your invoice is available in the billing portal for the next 24 months.</p>',
    '</div>',
  ].join('\n');
  allEmails.push(email);
});

// ─── Emit ───────────────────────────────────────────────────────────────────

// Chronological order, like a freshly downloaded mailbox reads back.
allEmails.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));

const mainLines = [];
const htmlLines = [];

for (const email of allEmails) {
  const { bodyHtml, bodyParagraphs, ...record } = email;
  void bodyParagraphs;
  if (bodyHtml) {
    htmlLines.push(JSON.stringify({ id: record.id, bodyHtml }));
  }
  mainLines.push(JSON.stringify(record));
}

// ─── Sanity checks — a broken fixture makes the whole demo pointless ────────

const seenIds = new Set();
const seenMessageIds = new Set();
for (const e of allEmails) {
  if (seenIds.has(e.id)) throw new Error(`Duplicate id: ${e.id}`);
  if (seenMessageIds.has(e.messageId)) throw new Error(`Duplicate messageId: ${e.messageId}`);
  seenIds.add(e.id);
  seenMessageIds.add(e.messageId);
}
for (const e of allEmails) {
  if (e.inReplyTo && !seenMessageIds.has(e.inReplyTo)) {
    throw new Error(`Dangling inReplyTo on ${e.id}: ${e.inReplyTo}`);
  }
  for (const ref of e.references.split(/\s+/).filter(Boolean)) {
    if (!seenMessageIds.has(ref)) throw new Error(`Dangling reference on ${e.id}: ${ref}`);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(MAIN_FILE, mainLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(HTML_FILE, htmlLines.join('\n') + '\n', 'utf8');

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1);
console.log(`Wrote ${mainLines.length} emails`);
console.log(`  ${MAIN_FILE}  ${kb(MAIN_FILE)} KB`);
console.log(`  ${HTML_FILE}  ${kb(HTML_FILE)} KB`);
console.log(`  attachments: ${allEmails.filter((e) => e.hasAttachments).length}`);
