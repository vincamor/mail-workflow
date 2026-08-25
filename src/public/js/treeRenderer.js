/**
 * Tree Renderer — SVG natif (remplace D3.js)
 * Refonte 2026-04-26 (taste-skill 5/5/6) :
 *  - Composition 3 lignes : sujet / avatar+sender / date+badges
 *  - Tailles variables (root / standard / court)
 *  - Aurora gradient reservee aux mails self-sent (anti-slop)
 *  - Hover branch highlight (ascendants → racine)
 *  - Custom tooltip + staggered entry
 *  - Empty/skeleton states
 */

// ========================================
// CONSTANTES
// ========================================

const SVG_NS = 'http://www.w3.org/2000/svg';

// Layout
const NODE_SPACING_X = 420;
const NODE_SPACING_Y = 130;
const CONTAINER_MARGIN = { top: 40, right: 100, bottom: 40, left: 100 };
const DATA_GROUP_OFFSET = 140;

const ZOOM_SCALE_EXTENT = [0.1, 3];
const CONTAINER_PADDING = 80;
// Plafond du zoom auto : ne JAMAIS agrandir un petit arbre au-delà de sa taille
// naturelle. Sans ça, un fil de quelques mails est zoomé jusqu'à ×3 pour remplir
// la vue → nœuds énormes, flèches qui débordent en haut.
const MAX_FIT_SCALE = 1;

const TIMELINE_LINE_OFFSET = -15;
const TIMELINE_LABEL_OFFSET = -80;
const TIMELINE_LABEL_Y_OFFSET = 55;

// Courbes liens
const LINK_END_OFFSET = -12;
const CURVE_CONTROL_FACTOR_1 = 0.5;
const CURVE_CONTROL_FACTOR_2 = 0.3;

// Bouton expand
const EXPAND_BUTTON_SIZE = 32;
const EXPAND_BUTTON_MARGIN_RIGHT = 14;
const EXPAND_BUTTON_RADIUS = 16;

// Stagger
const STAGGER_MAX_INDEX = 60;
const STAGGER_STEP_MS = 25;

// ========================================
// ETAT INTERNE
// ========================================

let currentContainerId = null;
let positionedNodes = [];
let viewState = { x: 0, y: 0, scale: 1 };
let resizeObserver = null;
let nodeClickHandler = null;
let parentIndex = new Map(); // targetId → sourceId (child → parent)
let tooltipEl = null;

// Index dateString → premier noeud de cette date (construit une fois par rendu
// dans buildTimeline). Evite positionedNodes.find() a chaque frame de pan/zoom.
let timelineNodeByDate = new Map();

// Stockage des donnees d'arbre par containerId. Remplace window['treeData_*']
// (fuite memoire : une cle unique par selection de sujet, jamais liberee).
// On garde une reference module-level et on purge l'ancienne avant chaque
// nouvelle visualisation — un seul arbre est affiche a la fois.
const treeDataStore = new Map();

// ========================================
// HELPERS SVG
// ========================================

function createEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
}

// ========================================
// DATA HELPERS
// ========================================

function extractEmailAddress(from) {
  if (!from) return '';
  const m = String(from).match(/<(.+?)>/);
  return (m ? m[1] : String(from)).trim();
}

function extractDisplayName(from) {
  if (!from) return 'Inconnu';
  const s = String(from);
  const m = s.match(/^\s*(.+?)\s*<.+?>\s*$/);
  if (m && m[1]) {
    return m[1].replace(/^["']|["']$/g, '').trim();
  }
  const at = s.indexOf('@');
  if (at > 0) return s.slice(0, at);
  return s.trim();
}

function truncateText(text, max) {
  if (!text) return '';
  const clean = String(text).replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
  return clean.length <= max ? clean : clean.substring(0, max) + '…';
}

function getCurrentUserEmail() {
  try {
    const v = new URLSearchParams(window.location.search).get('email') || '';
    return v.trim().toLowerCase();
  } catch {
    return '';
  }
}

function isSelfSent(node, userEmail) {
  if (!userEmail) return false;
  return extractEmailAddress(node.from).toLowerCase() === userEmail;
}

// Palette d'avatars curatée : harmonieuse avec l'identité aubergine/pêche
// (plus de marron/vert aléatoires issus d'un hue plein spectre). Chaque
// expéditeur garde une couleur stable, choisie par hash dans cette palette.
const AVATAR_PALETTE = [
  'hsl(18, 68%, 56%)',    // pêche / corail
  'hsl(342, 58%, 58%)',   // rose
  'hsl(286, 52%, 60%)',   // orchidée
  'hsl(252, 46%, 62%)',   // lavande / violet
  'hsl(210, 55%, 58%)',   // bleu périclès
  'hsl(168, 40%, 50%)',   // teal doux
  'hsl(36, 58%, 54%)',    // ambre chaud (pas marron)
  'hsl(320, 48%, 60%)',   // magenta doux
];

// Hash → couleur d'avatar deterministe, dans la palette on-thème
function colorFromEmail(email) {
  const s = email || 'unknown';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

// Date relative francaise
function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.round(diffMs / 60000);
  const diffH = Math.round(diffMs / 3600000);
  const diffD = Math.floor(diffMs / 86400000);

  if (diffMs < 0) return d.toLocaleDateString('fr-FR');
  if (diffMin < 1) return 'a l\'instant';
  if (diffMin < 60) return `il y a ${diffMin}min`;
  if (diffH < 24) return `il y a ${diffH}h`;
  if (diffD === 0) return 'aujourd\'hui';
  if (diffD === 1) return 'hier';
  if (diffD < 7) return `il y a ${diffD}j`;
  if (diffD < 30) return `il y a ${Math.floor(diffD / 7)}sem`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
}

function formatFullDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ========================================
// SIZING — variable par nœud
// ========================================

function isRootNode(d) {
  if (d && d.isRoot === true) return true;
  if (parentIndex && d && d.messageId) return !parentIndex.has(d.messageId);
  return false;
}

function nodeWidthFor(d) {
  if (isRootNode(d)) return 360;
  const subj = d && d.subject ? String(d.subject) : '';
  if (!subj || subj.length < 30) return 300;
  return 320;
}

function nodeHeightFor() {
  // Hauteur uniforme : alignement parfait des centres verticaux sur la lane,
  // les fleches partent toutes au meme Y. Le root est distingue par la largeur
  // (nodeWidthFor) + un bord plus epais (.node.root dans le CSS).
  return 100;
}

// ========================================
// POSITIONNEMENT
// ========================================

function calculateYLevels(nodes, links) {
  if (!nodes || nodes.length === 0) return;

  // === ETAPE 1 — Le tronc = plus longue chaine chronologique depuis la racine ===
  // Au lieu de grouper par participants (qui peut fragmenter le tronc visible),
  // on identifie la chaine parent→enfant la plus longue depuis nodes[0].
  // Tous les noeuds sur cette chaine sont en lane 0 → tronc parfaitement horizontal.
  const childrenMap = new Map();
  if (Array.isArray(links)) {
    for (const l of links) {
      if (!l || !l.sourceId || !l.targetId) continue;
      if (!childrenMap.has(l.sourceId)) childrenMap.set(l.sourceId, []);
      childrenMap.get(l.sourceId).push(l.targetId);
    }
  }

  const memo = new Map();
  function longestPath(id) {
    if (!id) return [];
    if (memo.has(id)) return memo.get(id);
    const children = childrenMap.get(id) || [];
    let best = [];
    for (const childId of children) {
      const p = longestPath(childId);
      if (p.length > best.length) best = p;
    }
    const path = [id, ...best];
    memo.set(id, path);
    return path;
  }

  const root = nodes[0];
  const trunkSet = new Set(root && root.messageId ? longestPath(root.messageId) : []);

  // === ETAPE 2 — Lane 0 pour tout le tronc ===
  nodes.forEach(n => {
    if (trunkSet.has(n.messageId)) n.yLevel = 0;
  });

  // === ETAPE 3 — Branches : grouper par participants, alterner ±1, ±2 ===
  const nonTrunk = nodes.filter(n => !trunkSet.has(n.messageId));
  if (nonTrunk.length === 0) return;

  const groups = new Map();
  nonTrunk.forEach(node => {
    const key = [...(node.participantsGroup || [])].sort().join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });

  const sortedGroups = Array.from(groups.values()).sort((a, b) => b.length - a.length);
  sortedGroups.forEach((groupNodes, i) => {
    const offset = Math.floor(i / 2) + 1;
    const yLevel = i % 2 === 0 ? offset : -offset;
    groupNodes.forEach(n => { n.yLevel = yLevel; });
  });
}

function calculateNodePositions(nodes, links) {
  calculateYLevels(nodes, links);
  return nodes.map((node, index) => ({
    ...node,
    x: index * NODE_SPACING_X,
    y: (node.yLevel || 0) * NODE_SPACING_Y,
  }));
}

// ========================================
// PARENT INDEX
// ========================================

function buildParentIndex(links) {
  const map = new Map();
  if (Array.isArray(links)) {
    for (const l of links) {
      if (l && l.targetId && l.sourceId) {
        map.set(l.targetId, l.sourceId);
      }
    }
  }
  return map;
}

function collectAncestors(messageId) {
  const set = new Set();
  if (!messageId) return set;
  let cur = messageId;
  let safety = 200;
  while (cur && !set.has(cur) && safety-- > 0) {
    set.add(cur);
    cur = parentIndex.get(cur);
  }
  return set;
}

// ========================================
// SVG — DEFS, LINKS
// ========================================

function buildSVGDefs(svg) {
  const defs = createEl('defs');

  // Arrow marker
  const arrowGradient = createEl('linearGradient', { id: 'arrow-gradient', gradientUnits: 'userSpaceOnUse' });
  arrowGradient.append(
    createEl('stop', { offset: '0%', class: 'arrow-gradient-start' }),
    createEl('stop', { offset: '100%', class: 'arrow-gradient-end' })
  );
  const marker = createEl('marker', {
    id: 'arrow', viewBox: '0 -5 10 10', refX: '0', refY: '0',
    markerWidth: '6', markerHeight: '6', orient: 'auto',
  });
  marker.appendChild(createEl('path', { d: 'M0,-5L10,0L0,5' }));

  // Aurora stroke gradient (peach → orchidee) — reserve aux mails self-sent
  const auroraGrad = createEl('linearGradient', {
    id: 'aurora-stroke-gradient',
    x1: '0%', y1: '0%', x2: '100%', y2: '100%',
  });
  const auroraStop1 = createEl('stop', { offset: '0%' });
  auroraStop1.style.stopColor = 'var(--primary)';
  const auroraStop2 = createEl('stop', { offset: '100%' });
  auroraStop2.style.stopColor = 'var(--secondary)';
  auroraGrad.append(auroraStop1, auroraStop2);

  defs.append(arrowGradient, marker, auroraGrad);
  svg.appendChild(defs);
}

function linkAnchor(node, side) {
  const w = nodeWidthFor(node);
  const h = nodeHeightFor(node);
  const cy = node.y + h / 2;
  if (side === 'right') return { x: node.x + w, y: cy };
  return { x: node.x + LINK_END_OFFSET, y: cy };
}

// Orthogonal routing : pour chaque lien, on detecte les noeuds intermediaires
// (ceux dont la bbox croise le segment AB en X). Si aucun → courbe Bezier classique.
// Si presents → vrai path orthogonal (90° angles, lignes droites, coins arrondis) :
//
//   ●━━╮                                 ╭━━●
//      ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
//
// 5 segments + 4 coins arrondis :
//   1. horizontal short (sortie source)
//   2. vertical (monte/descend au routeY)
//   3. horizontal au routeY (longue traversee)
//   4. vertical (descend/monte vers cible)
//   5. horizontal short (entree cible)
const ROUTE_CLEARANCE = 24;
const ROUTE_SIDE_PAD = 28;     // distance horizontale source/cible avant le coude
const ROUTE_CORNER_R = 10;     // rayon des coins arrondis

function findIntermediates(source, target, a, b) {
  if (!Array.isArray(positionedNodes)) return [];
  const xLow = Math.min(a.x, b.x);
  const xHigh = Math.max(a.x, b.x);
  // Range Y reel de la trajectoire : on n'eleve la courbe que si un noeud croise
  // realement la zone source→cible (un noeud lane -1 ne bloque pas un lien lane 0
  // → lane 0 par exemple, donc inutile de monter au-dessus).
  const linkYMin = Math.min(a.y, b.y);
  const linkYMax = Math.max(a.y, b.y);
  const out = [];
  for (const n of positionedNodes) {
    if (n.messageId === source.messageId || n.messageId === target.messageId) continue;
    const nLeft = n.x;
    const nRight = n.x + nodeWidthFor(n);
    if (nRight < xLow + 8 || nLeft > xHigh - 8) continue;
    const nTop = n.y;
    const nBottom = n.y + nodeHeightFor(n);
    // Le noeud doit aussi croiser la trajectoire en Y pour etre un vrai obstacle
    if (nBottom < linkYMin - 4 || nTop > linkYMax + 4) continue;
    out.push(n);
  }
  return out;
}

function createFluidCurve(source, target) {
  const a = linkAnchor(source, 'right');
  const b = linkAnchor(target, 'left');
  const deltaX = Math.abs(b.x - a.x);

  const intermediates = findIntermediates(source, target, a, b);

  // Pas d'obstacle : Bezier classique lisse (= comportement de la 1ere version)
  if (intermediates.length === 0) {
    const cp1X = a.x + deltaX * CURVE_CONTROL_FACTOR_1;
    const cp2X = b.x - deltaX * CURVE_CONTROL_FACTOR_2;
    return `M${a.x},${a.y} C${cp1X},${a.y} ${cp2X},${b.y} ${b.x},${b.y}`;
  }

  // Avec obstacle : on contourne par le haut OU par le bas selon ou sont les endpoints
  const interTop = Math.min(...intermediates.map(n => n.y));
  const interBottom = Math.max(...intermediates.map(n => n.y + nodeHeightFor(n)));
  const interCenter = (interTop + interBottom) / 2;
  const endpointAvgY = (a.y + b.y) / 2;
  const routeAbove = endpointAvgY < interCenter;
  // Optimisation : si la cible est DEJA au-dela de la zone obstaclee (par exemple
  // cible lane -1 + obstacles lane 0 → cible plus haute que les obstacles), on
  // route DIRECTEMENT au niveau cible. Pas besoin de detour UP-HORIZONTAL-UP_again.
  let routeY;
  if (routeAbove) {
    const safeAboveAll = interTop - ROUTE_CLEARANCE;
    // routeY le plus proche de target tout en restant au-dessus des obstacles
    routeY = Math.min(safeAboveAll, b.y);
  } else {
    const safeBelowAll = interBottom + ROUTE_CLEARANCE;
    routeY = Math.max(safeBelowAll, b.y);
  }

  const x1 = a.x + ROUTE_SIDE_PAD;
  const x2 = b.x - ROUTE_SIDE_PAD;
  // Fallback Bezier si pas assez de place pour 2 turns
  if (x2 <= x1 + 2 * ROUTE_CORNER_R) {
    const cp1X = a.x + deltaX * CURVE_CONTROL_FACTOR_1;
    const cp2X = b.x - deltaX * CURVE_CONTROL_FACTOR_2;
    return `M${a.x},${a.y} C${cp1X},${routeY} ${cp2X},${routeY} ${b.x},${b.y}`;
  }

  const r = ROUTE_CORNER_R;
  // Cas degeneres : routeY au niveau d'un endpoint → pas de verticale necessaire de ce cote
  const flatStart = Math.abs(routeY - a.y) < r;
  const flatEnd = Math.abs(routeY - b.y) < r;
  const dy1 = Math.sign(routeY - a.y) || 1;
  const dy2 = Math.sign(b.y - routeY) || 1;

  const segments = [`M ${a.x},${a.y}`];

  if (flatStart) {
    // Source deja au routeY : ligne droite jusqu'au debut de la traversee
    segments.push(`L ${x1},${routeY}`);
  } else {
    segments.push(`L ${x1 - r},${a.y}`);
    segments.push(`Q ${x1},${a.y} ${x1},${a.y + dy1 * r}`);
    segments.push(`L ${x1},${routeY - dy1 * r}`);
    segments.push(`Q ${x1},${routeY} ${x1 + r},${routeY}`);
  }

  // Horizontale traversee
  if (flatEnd) {
    segments.push(`L ${b.x},${b.y}`);
  } else {
    segments.push(`L ${x2 - r},${routeY}`);
    segments.push(`Q ${x2},${routeY} ${x2},${routeY + dy2 * r}`);
    segments.push(`L ${x2},${b.y - dy2 * r}`);
    segments.push(`Q ${x2},${b.y} ${x2 + r},${b.y}`);
    segments.push(`L ${b.x},${b.y}`);
  }

  return segments.join(' ');
}

function buildLinks(parent, links, nodes) {
  links.forEach((link, idx) => {
    const src = nodes.find(n => n.messageId === link.sourceId);
    const tgt = nodes.find(n => n.messageId === link.targetId);
    if (!src || !tgt) return;
    const path = createEl('path', {
      class: 'link entering',
      d: createFluidCurve(src, tgt),
      style: `marker-end: url(#arrow); animation-delay: ${Math.min(idx, STAGGER_MAX_INDEX) * STAGGER_STEP_MS}ms;`,
      'data-source-id': link.sourceId,
      'data-target-id': link.targetId,
    });
    parent.appendChild(path);
  });
}

// ========================================
// NODE COMPONENTS
// ========================================

function buildAvatar(g, d, h) {
  const email = extractEmailAddress(d.from);
  const name = extractDisplayName(d.from);
  const initial = (name || email || '?').trim().charAt(0).toUpperCase() || '?';

  const avatarG = createEl('g', { class: 'node-avatar' });
  const cx = 14 + 11; // padding gauche 14 + radius 11
  const cy = h / 2 + 2;

  const circle = createEl('circle', {
    class: 'node-avatar-circle',
    cx: cx, cy: cy, r: 11,
  });
  circle.style.fill = colorFromEmail(email || name);
  avatarG.appendChild(circle);

  const letter = createEl('text', {
    class: 'node-avatar-letter',
    x: cx, y: cy,
  });
  letter.textContent = initial;
  avatarG.appendChild(letter);

  g.appendChild(avatarG);
  return { avatarRightX: cx + 11 + 8 };
}

function attachmentIconPath() {
  // Paperclip simplifie — viewBox 0 0 16 16, stroke icon
  return 'M11 5l-5 5a2 2 0 1 0 2.83 2.83L13 8a3.5 3.5 0 1 0-4.95-4.95L3 8.05';
}

function sentIconPath() {
  // Paper plane — viewBox 0 0 16 16, stroke icon
  return 'M14.5 1.5l-13 5.5 5 2 2 5z M14.5 1.5l-7.5 7.5';
}

function buildBadge(kind, x, y) {
  const g = createEl('g', { class: `node-badge-group node-badge-${kind}` });
  if (kind === 'self') g.classList.add('badge-self');

  const path = createEl('path', {
    class: 'badge-icon',
    transform: `translate(${x}, ${y - 12}) scale(0.85)`,
    d: kind === 'attachment' ? attachmentIconPath() : sentIconPath(),
  });
  g.appendChild(path);
  return g;
}

function buildExpandButton(g, d, w, h) {
  const btn = createEl('g', { style: 'cursor:pointer', 'pointer-events': 'all', class: 'expand-button-group' });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (nodeClickHandler) nodeClickHandler(d);
  });
  btn.addEventListener('pointerdown', e => e.stopPropagation());

  const x = w - EXPAND_BUTTON_MARGIN_RIGHT - EXPAND_BUTTON_SIZE;
  const y = (h - EXPAND_BUTTON_SIZE) / 2;

  btn.appendChild(createEl('rect', {
    class: 'expand-button',
    width: EXPAND_BUTTON_SIZE, height: EXPAND_BUTTON_SIZE,
    x: x, y: y,
    rx: EXPAND_BUTTON_RADIUS, ry: EXPAND_BUTTON_RADIUS,
  }));

  const txt = createEl('text', {
    class: 'expand-text',
    x: x + EXPAND_BUTTON_SIZE / 2,
    y: y + EXPAND_BUTTON_SIZE / 2,
  });
  txt.textContent = '+';
  btn.appendChild(txt);

  g.appendChild(btn);
}

function buildNodes(parent, nodes, userEmail) {
  nodes.forEach((d, index) => {
    const w = nodeWidthFor(d);
    const h = nodeHeightFor(d);
    const isRoot = isRootNode(d);
    const selfSent = isSelfSent(d, userEmail);

    const g = createEl('g', {
      class: 'node entering' + (isRoot ? ' root' : '') + (selfSent ? ' self-sent' : ''),
      transform: `translate(${d.x},${d.y})`,
      'data-message-id': d.messageId || '',
    });
    g.style.setProperty('--node-index', Math.min(index, STAGGER_MAX_INDEX));
    g.style.animationDelay = `${Math.min(index, STAGGER_MAX_INDEX) * STAGGER_STEP_MS}ms`;

    g.addEventListener('mouseenter', () => g.classList.add('hover'));
    g.addEventListener('mouseleave', () => g.classList.remove('hover'));

    g.addEventListener('pointerdown', () => g.classList.add('pressing'));
    g.addEventListener('pointerup', () => g.classList.remove('pressing'));
    g.addEventListener('pointerleave', () => g.classList.remove('pressing'));
    g.addEventListener('pointercancel', () => g.classList.remove('pressing'));

    g.appendChild(createEl('rect', {
      width: w, height: h, rx: '12', ry: '12',
    }));

    // === Ligne 1 — Sujet ===
    const subj = (d.subject && String(d.subject).trim())
      ? d.subject
      : (d.bodyText ? String(d.bodyText).split('\n')[0] : '(sans sujet)');
    const subjectText = createEl('text', {
      class: 'node-text-primary',
      x: 14,
      y: 24,
    });
    subjectText.textContent = truncateText(subj, 38);
    g.appendChild(subjectText);

    // === Ligne 2 — Avatar + nom du sender ===
    const { avatarRightX } = buildAvatar(g, d, h);
    const senderName = extractDisplayName(d.from);
    const senderText = createEl('text', {
      class: 'node-text-secondary',
      x: avatarRightX,
      y: h / 2 + 5,
    });
    senderText.textContent = truncateText(senderName, 22);
    g.appendChild(senderText);

    // === Ligne 3 — Date relative + badges ===
    const metaY = h - 14;
    const dateText = createEl('text', {
      class: 'node-text-meta',
      x: 14,
      y: metaY,
    });
    dateText.textContent = formatRelativeDate(d.date);
    g.appendChild(dateText);

    // Badges
    let badgeX = 110;
    if (d.hasAttachments === true) {
      g.appendChild(buildBadge('attachment', badgeX, metaY));
      badgeX += 18;
    }
    if (selfSent) {
      g.appendChild(buildBadge('self', badgeX, metaY));
      badgeX += 18;
    }

    buildExpandButton(g, d, w, h);

    parent.appendChild(g);
  });
}

// ========================================
// TIMELINE
// ========================================

function buildTimeline(linesGroup, nodes, height) {
  // Construire l'index dateString → premier noeud (lu en O(1) par updateTimelines).
  // On preserve la semantique du .find() precedent : premiere occurrence par date.
  timelineNodeByDate = new Map();
  const uniqueDates = [];
  for (const d of nodes) {
    const key = new Date(d.date).toDateString();
    if (!timelineNodeByDate.has(key)) {
      timelineNodeByDate.set(key, d);
      uniqueDates.push(key);
    }
  }

  uniqueDates.forEach(dateStr => {
    const line = createEl('line', {
      class: 'timeline', x1: '0', y1: '0', x2: '0', y2: height,
      'data-date': dateStr,
    });
    linesGroup.appendChild(line);

    const label = createEl('text', {
      class: 'timeline-label', x: '0', y: height - TIMELINE_LABEL_Y_OFFSET,
      'data-date': dateStr,
    });
    const date = new Date(dateStr);
    label.textContent = date.toLocaleDateString('fr-FR', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    linesGroup.appendChild(label);
  });
}

// ========================================
// ZOOM / PAN
// ========================================

function applyTransform(dataGroup) {
  dataGroup.setAttribute('transform',
    `translate(${viewState.x},${viewState.y}) scale(${viewState.scale})`);
}

function updateTimelines(svg) {
  const lines = svg.querySelectorAll('.timeline');
  const labels = svg.querySelectorAll('.timeline-label');

  lines.forEach(line => {
    const x = calcTimelineX(line.getAttribute('data-date'));
    setAttrs(line, { x1: x, x2: x });
  });
  labels.forEach(label => {
    label.setAttribute('x', calcLabelX(label.getAttribute('data-date')));
  });
}

function calcTimelineX(dateStr) {
  const node = timelineNodeByDate.get(dateStr);
  if (!node || typeof node.x !== 'number') return 0;
  return node.x * viewState.scale + viewState.x + TIMELINE_LINE_OFFSET * viewState.scale;
}

function calcLabelX(dateStr) {
  const node = timelineNodeByDate.get(dateStr);
  if (!node || typeof node.x !== 'number') return 0;
  const realX = node.x + CONTAINER_MARGIN.left;
  return realX * viewState.scale + viewState.x + TIMELINE_LABEL_OFFSET * viewState.scale;
}

function setupZoomPan(svg, dataGroup) {
  // Wheel zoom
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const direction = e.deltaY < 0 ? 1 : -1;
    const factor = 1 + direction * 0.1;
    const newScale = Math.min(
      ZOOM_SCALE_EXTENT[1],
      Math.max(ZOOM_SCALE_EXTENT[0], viewState.scale * factor)
    );

    const ratio = newScale / viewState.scale;
    viewState.x = mx - (mx - viewState.x) * ratio;
    viewState.y = my - (my - viewState.y) * ratio;
    viewState.scale = newScale;

    applyTransform(dataGroup);
    updateTimelines(svg);
  }, { passive: false });

  let dragging = false;
  let didDrag = false;
  let startX, startY, origX, origY;
  const DRAG_THRESHOLD = 3;

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest('[pointer-events="all"]')
      || target.classList.contains('expand-button')
      || target.classList.contains('expand-text')) return;

    dragging = true;
    didDrag = false;
    startX = e.clientX;
    startY = e.clientY;
    origX = viewState.x;
    origY = viewState.y;
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!didDrag && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    didDrag = true;
    svg.style.cursor = 'grabbing';
    viewState.x = origX + dx;
    viewState.y = origY + dy;
    applyTransform(dataGroup);
    updateTimelines(svg);
  });

  svg.addEventListener('pointerup', () => {
    dragging = false;
    didDrag = false;
    svg.style.cursor = '';
  });
}

// ========================================
// BRANCH HIGHLIGHT (hover ascendants)
// ========================================

function setupBranchHighlight(svg) {
  const nodeEls = svg.querySelectorAll('.node');
  const linkEls = svg.querySelectorAll('.link');

  function clearHighlight() {
    nodeEls.forEach(n => n.classList.remove('dimmed-out', 'highlighted'));
    linkEls.forEach(l => l.classList.remove('dimmed-out', 'highlight'));
  }

  nodeEls.forEach(nodeEl => {
    nodeEl.addEventListener('mouseenter', () => {
      const id = nodeEl.getAttribute('data-message-id');
      if (!id) return;
      const ancestors = collectAncestors(id);
      if (ancestors.size === 0) return;

      nodeEls.forEach(n => {
        const nid = n.getAttribute('data-message-id');
        if (ancestors.has(nid)) {
          n.classList.remove('dimmed-out');
          n.classList.add('highlighted');
        } else {
          n.classList.add('dimmed-out');
          n.classList.remove('highlighted');
        }
      });

      linkEls.forEach(l => {
        const sid = l.getAttribute('data-source-id');
        const tid = l.getAttribute('data-target-id');
        if (ancestors.has(sid) && ancestors.has(tid)) {
          l.classList.remove('dimmed-out');
          l.classList.add('highlight');
        } else {
          l.classList.add('dimmed-out');
          l.classList.remove('highlight');
        }
      });
    });

    nodeEl.addEventListener('mouseleave', clearHighlight);
  });
}

// ========================================
// CUSTOM TOOLTIP
// ========================================

function ensureTooltip() {
  if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'tree-tooltip';
  tooltipEl.innerHTML = `
    <div class="tree-tooltip-subject"></div>
    <div class="tree-tooltip-meta"></div>
    <div class="tree-tooltip-body"></div>
  `;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function positionTooltip(e) {
  if (!tooltipEl) return;
  const PAD = 14;
  const tw = tooltipEl.offsetWidth || 280;
  const th = tooltipEl.offsetHeight || 80;
  let x = e.clientX + PAD;
  let y = e.clientY + PAD;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - PAD;
  if (y + th > window.innerHeight - 8) y = e.clientY - th - PAD;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
}

function setupTooltips(svg, nodes) {
  ensureTooltip();
  const byId = new Map();
  nodes.forEach(n => byId.set(n.messageId, n));

  const nodeEls = svg.querySelectorAll('.node');
  nodeEls.forEach(el => {
    const id = el.getAttribute('data-message-id');
    const d = byId.get(id);
    if (!d) return;

    el.addEventListener('mouseenter', e => {
      const tt = ensureTooltip();
      tt.querySelector('.tree-tooltip-subject').textContent = d.subject || '(sans sujet)';
      tt.querySelector('.tree-tooltip-meta').textContent = `${d.from || 'Inconnu'} • ${formatFullDate(d.date)}`;
      tt.querySelector('.tree-tooltip-body').textContent = (d.bodyText || '').slice(0, 280);
      tt.classList.add('visible');
      positionTooltip(e);
    });
    el.addEventListener('mousemove', positionTooltip);
    el.addEventListener('mouseleave', () => {
      if (tooltipEl) tooltipEl.classList.remove('visible');
    });
  });
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.remove('visible');
}

// ========================================
// AUTO-FIT
// ========================================

function calculateFitTransform(dataGroup, container) {
  const bbox = dataGroup.getBBox();
  const cw = Math.max(container.clientWidth || 0, 100);
  const ch = Math.max(container.clientHeight || 0, 100);

  const bw = (bbox.width > 0) ? bbox.width : 100;
  const bh = (bbox.height > 0) ? bbox.height : 100;

  const scaleX = (cw - CONTAINER_PADDING) / bw;
  const scaleY = (ch - CONTAINER_PADDING) / bh;
  const scale = Math.min(scaleX, scaleY, MAX_FIT_SCALE);

  const centerX = cw / 2 - (bbox.x + bw / 2) * scale;
  const centerY = ch / 2 - (bbox.y + bh / 2) * scale;

  return { x: centerX, y: centerY, scale };
}

function autoFit(containerIdArg) {
  const id = containerIdArg || currentContainerId;
  if (!id) return;

  const container = document.getElementById(id);
  if (!container) return;

  const svg = container.querySelector('svg');
  if (!svg) return;

  const dataGroup = svg.querySelector('.data-content');
  if (!dataGroup) return;

  const w = Math.max(container.clientWidth || 0, 100);
  const h = Math.max(container.clientHeight || 0, 100);
  setAttrs(svg, { width: w, height: h });

  svg.querySelectorAll('.timeline').forEach(l => l.setAttribute('y2', h));

  const fit = calculateFitTransform(dataGroup, container);
  viewState.x = fit.x;
  viewState.y = fit.y;
  viewState.scale = fit.scale;

  applyTransform(dataGroup);
  updateTimelines(svg);
}

// ========================================
// EMPTY / SKELETON STATES
// ========================================

function renderEmptyStateHTML() {
  return `
    <div class="tree-empty-state">
      <svg class="tree-empty-state-icon" viewBox="0 0 64 64" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M32 6v52"></path>
        <path d="M32 18c-6-6-14-6-20-2"></path>
        <path d="M32 18c6-6 14-6 20-2"></path>
        <path d="M32 32c-7-4-15-4-22 0"></path>
        <path d="M32 32c7-4 15-4 22 0"></path>
        <circle cx="10" cy="22" r="2.5"></circle>
        <circle cx="54" cy="22" r="2.5"></circle>
        <circle cx="8" cy="36" r="2.5"></circle>
        <circle cx="56" cy="36" r="2.5"></circle>
        <circle cx="32" cy="6" r="2.5"></circle>
      </svg>
      <h3 class="tree-empty-state-title">Pas encore de fil de reponses</h3>
      <p class="tree-empty-state-body">
        Cette conversation n'a qu'un mail. L'arbre apparaitra des qu'il y aura une reponse.
      </p>
    </div>
  `;
}

function renderSkeletonHTML() {
  return `
    <div class="tree-loading-skeleton" aria-busy="true" aria-live="polite">
      <div class="tree-loading-skeleton-row" style="margin-left: 0;">
        <div class="tree-skeleton-node"></div>
      </div>
      <div class="tree-loading-skeleton-row" style="margin-left: 360px; margin-top: -30px;">
        <div class="tree-skeleton-node"></div>
      </div>
      <div class="tree-loading-skeleton-row" style="margin-left: 200px;">
        <div class="tree-skeleton-node"></div>
      </div>
      <div class="tree-loading-skeleton-row" style="margin-left: 540px; margin-top: -20px;">
        <div class="tree-skeleton-node"></div>
      </div>
    </div>
  `;
}

// ========================================
// RENDU PRINCIPAL
// ========================================

function renderTree(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const treeData = treeDataStore.get(containerId);
  if (!treeData || !treeData.nodes || treeData.nodes.length === 0) return;

  // Cas 1 nœud unique → empty state (pas d'arbre a afficher)
  if (treeData.nodes.length === 1) {
    container.innerHTML = renderEmptyStateHTML();
    return;
  }

  hideTooltip();
  container.innerHTML = '';
  currentContainerId = containerId;

  parentIndex = buildParentIndex(treeData.links);

  const userEmail = getCurrentUserEmail();

  const width = Math.max(container.clientWidth || 0, 100);
  const height = Math.max(container.clientHeight || 0, 100);

  positionedNodes = calculateNodePositions(treeData.nodes, treeData.links);

  const svgId = `tree-svg-${containerId.replace(/[^a-zA-Z0-9-_]/g, '-')}`;
  const svg = createEl('svg', { id: svgId, width: width, height: height });
  svg.style.display = 'block';
  container.appendChild(svg);

  buildSVGDefs(svg);

  const linesGroup = createEl('g', { class: 'timeline-lines' });
  svg.appendChild(linesGroup);

  const dataGroup = createEl('g', { class: 'data-content' });
  dataGroup.setAttribute('transform',
    `translate(${CONTAINER_MARGIN.left + DATA_GROUP_OFFSET},${CONTAINER_MARGIN.top})`);
  svg.appendChild(dataGroup);

  buildLinks(dataGroup, treeData.links, positionedNodes);
  buildNodes(dataGroup, positionedNodes, userEmail);
  buildTimeline(linesGroup, positionedNodes, height);

  setupZoomPan(svg, dataGroup);
  setupBranchHighlight(svg);
  setupTooltips(svg, positionedNodes);

  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(() => autoFit(containerId));
  resizeObserver.observe(container);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      autoFit(containerId);
    });
  });
}

// ========================================
// INTERFACE COMPATIBLE
// ========================================

function createCompleteVisualization(tree, options = {}) {
  if (!tree || !tree.nodes || tree.nodes.length === 0 || tree.nodes.length === 1) {
    return `
      <div class="d3-tree-container" style="width: 100%; height: 100%; display: flex; flex-direction: column;">
        <div class="tree-d3-container" style="flex: 1; width: 100%; height: 100%; background: var(--bg-secondary); overflow: hidden; position: relative;">
          ${renderEmptyStateHTML()}
        </div>
      </div>
    `;
  }

  const containerId = 'tree-container-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

  const html = `
    <div class="d3-tree-container" style="width: 100%; height: 100%; display: flex; flex-direction: column;">
      <div id="${containerId}" class="tree-d3-container" style="flex: 1; width: 100%; height: 100%; background: var(--bg-secondary); overflow: hidden; position: relative;">
        ${renderSkeletonHTML()}
      </div>
    </div>
  `;

  // Purge des donnees d'arbre precedentes : un seul arbre est affiche a la fois,
  // les anciens conteneurs ont ete retires du DOM. Evite la fuite memoire.
  treeDataStore.clear();
  treeDataStore.set(containerId, tree);

  // Compteur d'abandon : si le conteneur reste a 0×0 (onglet cache, parent
  // display:none, etc.), on ne boucle pas indefiniment sur requestAnimationFrame.
  let renderAttempts = 0;
  const MAX_RENDER_ATTEMPTS = 60;
  function tryRender() {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      renderTree(containerId);
      return;
    }
    if (++renderAttempts >= MAX_RENDER_ATTEMPTS) {
      console.warn(`⚠️ Rendu de l'arbre abandonné : conteneur ${containerId} toujours 0×0 après ${MAX_RENDER_ATTEMPTS} frames`);
      return;
    }
    requestAnimationFrame(tryRender);
  }
  setTimeout(tryRender, 200);

  return html;
}

function toggleTimelines(containerIdArg) {
  const id = containerIdArg || currentContainerId;
  if (!id) return;
  const container = document.getElementById(id);
  if (!container) return;
  const svg = container.querySelector('svg');
  if (!svg) return;

  const lines = svg.querySelectorAll('.timeline');
  const labels = svg.querySelectorAll('.timeline-label');

  const firstLine = lines[0];
  const isVisible = firstLine && firstLine.style.opacity !== '0' && firstLine.style.opacity !== '';

  lines.forEach(l => l.style.opacity = isVisible ? '0' : '0.6');
  labels.forEach(l => l.style.opacity = isVisible ? '0' : '1');
}

function getCurrentContainerId() {
  return currentContainerId;
}

// ========================================
// CALLBACK REGISTRATION
// ========================================

function setNodeClickHandler(fn) {
  nodeClickHandler = fn;
}

// ========================================
// EXPORT
// ========================================

export { renderTree, autoFit, toggleTimelines, getCurrentContainerId, setNodeClickHandler };

export default {
  createCompleteVisualization,
};
