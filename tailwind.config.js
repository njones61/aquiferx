import colors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';

/**
 * Light and dark themes for the Tailwind classes.
 *
 * The dialogs and wizards were written against Tailwind's light palette, with
 * a thousand-odd `bg-white`, `text-slate-600`, `bg-blue-50` and the like. Rather
 * than rewrite each one, the colors they name point at CSS variables, which
 * hold Tailwind's own values on :root and a dark counterpart under
 * :root[data-theme="dark"] (see utils/theme.ts). A class means the same role in
 * both themes: `bg-white` is a card, `text-slate-700` is body text,
 * `bg-blue-50 border-blue-200 text-blue-700` is a blue notice.
 *
 * Slate runs end to end in reverse in dark, so light text on a pale ground
 * becomes pale text on a dark one. The accent hues change only in the shades
 * that play a background or text role: a pale tint behind a notice becomes a
 * dark tint, and the deep shade used for its text becomes a light one. The
 * middle shades a button is filled with (500 to 700 as backgrounds) stay put,
 * since white text has to sit on them in both themes.
 */

const ACCENTS = ['blue', 'red', 'amber', 'emerald', 'indigo', 'sky', 'green', 'cyan', 'teal', 'purple', 'orange', 'yellow', 'rose', 'violet'];

// The card color in dark, which the tints are mixed toward.
const DARK_CARD = '#111827';

// Slate in dark: --bg, --surface2, --border and the text ramp of the panel
// tokens in index.css, so a dialog and the panel beside it agree.
const DARK_SLATE = {
  50: '#0a0e17', 100: '#1e293b', 200: '#334155', 300: '#475569', 400: '#7c8ba1',
  500: '#94a3b8', 600: '#b6c2d3', 700: '#dde5ee', 800: '#f1f5f9', 900: '#f8fafc', 950: '#ffffff',
};

const hexToRgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const channels = hex => hexToRgb(hex).join(' ');
const mix = (hex, toward, t) => {
  const a = hexToRgb(hex), b = hexToRgb(toward);
  return a.map((v, i) => Math.round(v * t + b[i] * (1 - t))).join(' ');
};

// Which shades follow the theme, per utility, and what each becomes in dark.
const DARK_SHADES = {
  bg: { 50: c => mix(c[500], DARK_CARD, 0.12), 100: c => mix(c[500], DARK_CARD, 0.2), 200: c => mix(c[500], DARK_CARD, 0.3), 300: c => mix(c[500], DARK_CARD, 0.45) },
  border: { 100: c => mix(c[500], DARK_CARD, 0.25), 200: c => mix(c[500], DARK_CARD, 0.35), 300: c => mix(c[500], DARK_CARD, 0.5) },
  text: { 600: c => channels(c[400]), 700: c => channels(c[300]), 800: c => channels(c[200]), 900: c => channels(c[100]) },
};

const v = name => `rgb(var(--${name}) / <alpha-value>)`;

const lightVars = {}, darkVars = {};
const slate = {};
for (const [shade, hex] of Object.entries(DARK_SLATE)) {
  slate[shade] = v(`slate-${shade}`);
  lightVars[`--slate-${shade}`] = channels(colors.slate[shade]);
  darkVars[`--slate-${shade}`] = channels(hex);
}
lightVars['--card'] = channels('#ffffff');
darkVars['--card'] = channels(DARK_CARD);

const perUtility = { bg: {}, border: {}, text: {} };
for (const [util, shades] of Object.entries(DARK_SHADES)) {
  for (const hue of ACCENTS) {
    perUtility[util][hue] = {};
    for (const [shade, dark] of Object.entries(shades)) {
      const name = `${util}-${hue}-${shade}`;
      perUtility[util][hue][shade] = v(name);
      lightVars[`--${name}`] = channels(colors[hue][shade]);
      darkVars[`--${name}`] = dark(colors[hue]);
    }
  }
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './*.tsx',
    './{components,contexts,hooks,utils}/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: { slate },
      backgroundColor: { ...perUtility.bg, white: v('card') },
      // A bare `border` gets gray-200 from Tailwind's preflight, which stays pale in dark.
      borderColor: { DEFAULT: v('slate-200'), ...perUtility.border },
      textColor: perUtility.text,
    },
  },
  plugins: [
    plugin(({ addBase }) => addBase({
      ':root': lightVars,
      ':root[data-theme="dark"]': darkVars,
    })),
  ],
};
