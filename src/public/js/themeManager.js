/**
 * Theme Manager — Switches between 5 visual themes
 * Applies CSS tokens via data-theme on :root
 */

const THEMES = {
  'aubergine-peach': {
    name: 'Aubergine & Peach',
    bgBase: '#0D0514',
    bgPrimary: '#14081F',
    bgSecondary: '#1E0F2E',
    bgTertiary: '#2A1740',
    bgElevated: '#341F4D',
    bgCanvas: '#0A0412',
    primary: '#F2A07B',
    primaryHover: '#F5B899',
    primaryDeep: '#E8874F',
    secondary: '#B44AE6',
    secondaryHover: '#C66EF0',
    textPrimary: '#EDE7F3',
    textSecondary: '#A89BB5',
    textTertiary: '#8B7E9A',
    textMuted: '#5A4E68',
    textInverse: '#14081F',
    borderLight: 'rgba(168,155,181,0.15)',
    borderMedium: 'rgba(168,155,181,0.25)',
    borderSection: 'rgba(180,74,230,0.12)',
    success: '#6DD4A0',
    successDark: '#4CAF7D',
    error: '#E85A6F',
    warning: '#FBBF24',
    info: '#7CB9F2',
    auroraStart: '#F2A07B',
    auroraMid: '#D97BAE',
    auroraEnd: '#B44AE6',
    shadowTint: '13,5,20',
    // preview colors
    previewBg: '#1E0F2E',
    previewAccent: '#F2A07B',
    previewSecondary: '#B44AE6',
    previewText: '#EDE7F3',
  },
  synthwave: {
    name: 'Synthwave Terminal',
    bgBase: '#07070C',
    bgPrimary: '#0A0A0F',
    bgSecondary: '#141420',
    bgTertiary: '#1A1A2E',
    bgElevated: '#22223A',
    bgCanvas: '#050508',
    primary: '#FFB020',
    primaryHover: '#FFC04D',
    primaryDeep: '#E89E00',
    secondary: '#FF6B9D',
    secondaryHover: '#FF8DB5',
    textPrimary: '#E8E0D4',
    textSecondary: '#A8A090',
    textTertiary: '#8A8078',
    textMuted: '#504840',
    textInverse: '#0A0A0F',
    borderLight: 'rgba(168,160,144,0.15)',
    borderMedium: 'rgba(168,160,144,0.25)',
    borderSection: 'rgba(255,176,32,0.12)',
    success: '#6DD4A0',
    successDark: '#4CAF7D',
    error: '#FF6B6B',
    warning: '#FFB020',
    info: '#6BC5F2',
    auroraStart: '#FFB020',
    auroraMid: '#FF8C5A',
    auroraEnd: '#FF6B9D',
    shadowTint: '7,7,12',
    previewBg: '#141420',
    previewAccent: '#FFB020',
    previewSecondary: '#FF6B9D',
    previewText: '#E8E0D4',
  },
  terracotta: {
    name: 'Terracotta Noir',
    bgBase: '#0E0A08',
    bgPrimary: '#140F0C',
    bgSecondary: '#1C1614',
    bgTertiary: '#261E19',
    bgElevated: '#302621',
    bgCanvas: '#0A0806',
    primary: '#C4653A',
    primaryHover: '#D4784E',
    primaryDeep: '#A85530',
    secondary: '#D4A055',
    secondaryHover: '#E0B46A',
    textPrimary: '#F0E6D8',
    textSecondary: '#B5A898',
    textTertiary: '#8E8176',
    textMuted: '#5A5048',
    textInverse: '#140F0C',
    borderLight: 'rgba(181,168,152,0.15)',
    borderMedium: 'rgba(181,168,152,0.25)',
    borderSection: 'rgba(196,101,58,0.15)',
    success: '#7A9E6D',
    successDark: '#5E8A50',
    error: '#C44A2C',
    warning: '#D4A055',
    info: '#6BA5C4',
    auroraStart: '#C4653A',
    auroraMid: '#CC8248',
    auroraEnd: '#D4A055',
    shadowTint: '14,10,8',
    previewBg: '#1C1614',
    previewAccent: '#C4653A',
    previewSecondary: '#D4A055',
    previewText: '#F0E6D8',
  },
  sapphire: {
    name: 'Deep Sapphire',
    bgBase: '#060A12',
    bgPrimary: '#080C16',
    bgSecondary: '#0E1525',
    bgTertiary: '#141D32',
    bgElevated: '#1A2540',
    bgCanvas: '#040812',
    primary: '#2563EB',
    primaryHover: '#3B82F6',
    primaryDeep: '#1D4ED8',
    secondary: '#F59E0B',
    secondaryHover: '#FBBF24',
    textPrimary: '#E2E8F0',
    textSecondary: '#94A3B8',
    textTertiary: '#7B8AA0',
    textMuted: '#475569',
    textInverse: '#080C16',
    borderLight: 'rgba(148,163,184,0.15)',
    borderMedium: 'rgba(148,163,184,0.25)',
    borderSection: 'rgba(37,99,235,0.15)',
    success: '#34D399',
    successDark: '#10B981',
    error: '#EF4444',
    warning: '#F59E0B',
    info: '#60A5FA',
    auroraStart: '#2563EB',
    auroraMid: '#7C3AED',
    auroraEnd: '#F59E0B',
    shadowTint: '6,10,18',
    previewBg: '#0E1525',
    previewAccent: '#2563EB',
    previewSecondary: '#F59E0B',
    previewText: '#E2E8F0',
  },
  moonlit: {
    name: 'Moonlit Warm',
    bgBase: '#EDE5D8',
    bgPrimary: '#F5F0E8',
    bgSecondary: '#FAF6EF',
    bgTertiary: '#E8DFD1',
    bgElevated: '#FFFFFF',
    bgCanvas: '#E8E0D4',
    primary: '#A8402F',
    primaryHover: '#C05840',
    primaryDeep: '#8A3324',
    secondary: '#A0522D',
    secondaryHover: '#8B4726',
    textPrimary: '#2D2622',
    textSecondary: '#6B5E54',
    textTertiary: '#726558',
    textMuted: '#786B5E',
    textInverse: '#F5F0E8',
    borderLight: 'rgba(45,38,34,0.1)',
    borderMedium: 'rgba(45,38,34,0.18)',
    borderSection: 'rgba(160,82,45,0.15)',
    success: '#3F7A46',
    successDark: '#2F6236',
    error: '#B5403F',
    warning: '#8C5F1F',
    info: '#4A7EB5',
    auroraStart: '#C66A5B',
    auroraMid: '#A0522D',
    auroraEnd: '#8A3324',
    shadowTint: '45,38,34',
    previewBg: '#FAF6EF',
    previewAccent: '#A8402F',
    previewSecondary: '#A0522D',
    previewText: '#2D2622',
  },
};

const STORAGE_KEY = 'mailproject-theme';
let currentThemeId = null;

function applyTheme(themeId) {
  const t = THEMES[themeId];
  if (!t) return;

  currentThemeId = themeId;
  localStorage.setItem(STORAGE_KEY, themeId);

  const r = document.documentElement.style;

  // Backgrounds
  r.setProperty('--bg-base', t.bgBase);
  r.setProperty('--bg-primary', t.bgPrimary);
  r.setProperty('--bg-secondary', t.bgSecondary);
  r.setProperty('--bg-tertiary', t.bgTertiary);
  r.setProperty('--bg-elevated', t.bgElevated);
  r.setProperty('--bg-canvas', t.bgCanvas);
  r.setProperty('--bg-overlay', `rgba(${t.shadowTint}, 0.80)`);
  r.setProperty('--scrim', `rgba(${t.shadowTint}, 0.90)`);

  // Hover/active tints — must follow the theme's own primary, not a hardcoded peach
  // (otherwise every theme shows a peach hover glow, jarring on Moonlit's cream bg).
  r.setProperty('--bg-hover', hexToRgba(t.primary, 0.06));
  r.setProperty('--bg-active', hexToRgba(t.primary, 0.1));

  // Primary
  r.setProperty('--primary', t.primary);
  r.setProperty('--primary-hover', t.primaryHover);
  r.setProperty('--primary-deep', t.primaryDeep);
  r.setProperty('--primary-light', hexToRgba(t.primary, 0.12));
  r.setProperty('--primary-subtle', hexToRgba(t.primary, 0.06));
  r.setProperty('--primary-muted', hexToRgba(t.primary, 0.08));
  r.setProperty('--primary-ring', hexToRgba(t.primary, 0.3));

  // Secondary
  r.setProperty('--secondary', t.secondary);
  r.setProperty('--secondary-hover', t.secondaryHover);
  r.setProperty('--secondary-light', hexToRgba(t.secondary, 0.12));

  // Accent aliases
  r.setProperty('--accent', t.secondary);
  r.setProperty('--accent-hover', t.secondaryHover);
  r.setProperty('--accent-light', hexToRgba(t.secondary, 0.12));

  // Text
  r.setProperty('--text-primary', t.textPrimary);
  r.setProperty('--text-secondary', t.textSecondary);
  r.setProperty('--text-tertiary', t.textTertiary);
  r.setProperty('--text-muted', t.textMuted);
  r.setProperty('--text-inverse', t.textInverse);

  // Borders
  r.setProperty('--border-light', t.borderLight);
  r.setProperty('--border-medium', t.borderMedium);
  r.setProperty('--border-section', t.borderSection);

  // Semantic
  r.setProperty('--success', t.success);
  r.setProperty('--success-dark', t.successDark);
  r.setProperty('--success-light', hexToRgba(t.success, 0.12));
  r.setProperty('--error', t.error);
  r.setProperty('--error-light', hexToRgba(t.error, 0.12));
  r.setProperty('--warning', t.warning);
  r.setProperty('--warning-light', hexToRgba(t.warning, 0.12));
  r.setProperty('--info', t.info);
  r.setProperty('--info-light', hexToRgba(t.info, 0.12));

  // Aurora gradients
  r.setProperty('--aurora-start', t.auroraStart);
  r.setProperty('--aurora-mid', t.auroraMid);
  r.setProperty('--aurora-end', t.auroraEnd);
  r.setProperty(
    '--aurora-gradient',
    `linear-gradient(135deg, ${t.auroraStart} 0%, ${t.auroraMid} 50%, ${t.auroraEnd} 100%)`
  );
  r.setProperty(
    '--aurora-gradient-h',
    `linear-gradient(90deg, ${t.auroraStart} 0%, ${t.auroraMid} 50%, ${t.auroraEnd} 100%)`
  );
  r.setProperty(
    '--aurora-glow',
    `0 0 20px ${hexToRgba(t.primary, 0.12)}, 0 0 60px ${hexToRgba(t.secondary, 0.06)}`
  );

  // Glass
  r.setProperty('--glass-bg', `rgba(${hexToRgbValues(t.bgPrimary)}, 0.75)`);
  r.setProperty('--glass-bg-hover', `rgba(${hexToRgbValues(t.bgPrimary)}, 0.88)`);
  r.setProperty('--glass-border', hexToRgba(t.secondary, 0.08));
  r.setProperty('--glass-border-hover', hexToRgba(t.primary, 0.15));

  // Shadows
  r.setProperty('--shadow-primary', `0 4px 14px ${hexToRgba(t.primary, 0.15)}`);
  r.setProperty(
    '--shadow-primary-lg',
    `0 8px 30px ${hexToRgba(t.primary, 0.12)}, 0 0 60px ${hexToRgba(t.secondary, 0.05)}`
  );
  r.setProperty('--shadow-glow', `0 0 15px ${hexToRgba(t.primary, 0.12)}`);
  r.setProperty('--shadow-glow-secondary', `0 0 15px ${hexToRgba(t.secondary, 0.12)}`);
  const st = t.shadowTint;
  r.setProperty('--shadow-xs', `0 1px 2px rgba(${st}, 0.3)`);
  r.setProperty('--shadow-sm', `0 1px 3px rgba(${st}, 0.4), 0 1px 2px rgba(${st}, 0.3)`);
  r.setProperty('--shadow-md', `0 4px 6px -1px rgba(${st}, 0.45), 0 2px 4px -1px rgba(${st}, 0.3)`);
  r.setProperty(
    '--shadow-lg',
    `0 10px 15px -3px rgba(${st}, 0.5), 0 4px 6px -2px rgba(${st}, 0.3)`
  );
  r.setProperty(
    '--shadow-xl',
    `0 20px 25px -5px rgba(${st}, 0.5), 0 10px 10px -5px rgba(${st}, 0.25)`
  );
  r.setProperty('--shadow-2xl', `0 25px 50px -12px rgba(${st}, 0.6)`);
  r.setProperty('--shadow-inner', `inset 0 2px 4px rgba(${st}, 0.25)`);
  r.setProperty('--shadow-color', `rgba(${st}, 0.5)`);

  // Glow breathe keyframe color — override via inline style
  r.setProperty('--glow-color', hexToRgba(t.primary, 0.1));
  r.setProperty('--glow-color-strong', hexToRgba(t.primary, 0.18));

  // Color scheme for scrollbars/browser chrome
  r.setProperty('color-scheme', themeId === 'moonlit' ? 'light' : 'dark');

  // Update theme picker active state
  document.querySelectorAll('.theme-option').forEach((el) => {
    el.classList.toggle('active', el.dataset.theme === themeId);
  });
}

function hexToRgba(hex, alpha) {
  const v = hexToRgbValues(hex);
  return `rgba(${v}, ${alpha})`;
}

function hexToRgbValues(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function buildThemePicker() {
  const container = document.getElementById('themePickerList');
  if (!container) return;

  Object.entries(THEMES).forEach(([id, t]) => {
    const option = document.createElement('button');
    option.className = 'theme-option';
    option.dataset.theme = id;
    if (id === currentThemeId) option.classList.add('active');

    option.style.cssText = `
      background: ${t.previewBg};
      border: 2px solid transparent;
      color: ${t.previewText};
    `;

    option.innerHTML = `
      <div class="theme-option-colors">
        <span class="theme-swatch" style="background:${t.previewAccent}"></span>
        <span class="theme-swatch" style="background:${t.previewSecondary}"></span>
        <span class="theme-swatch" style="background:${t.previewBg}; border: 1px solid ${t.previewText}30"></span>
      </div>
      <span class="theme-option-name" style="color:${t.previewText}">${t.name}</span>
    `;

    option.addEventListener('click', () => applyTheme(id));
    container.appendChild(option);
  });
}

function restoreTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && THEMES[saved]) {
    applyTheme(saved);
  } else {
    currentThemeId = 'aubergine-peach';
  }
}

export { THEMES, applyTheme, buildThemePicker, restoreTheme };
