// Text colors for the overlay from the wallpaper behind it. backdrop samples what its wallpaper shows under each
// overlay (after its dim) and gives the average and the main colors with their shares; the Electron shell passes
// them on. Light or dark text is chosen by WCAG contrast against every color that covers a real part of the area,
// so a bright patch counts even when the average is dark; the shadow, in the opposite color, grows as contrast
// falls, since it is what keeps the text readable over a busy picture.

export interface OverlayColors {
  // #rrggbb
  background: string;
  main: Array<{ color: string; share: number }>;
}

export interface TextTheme {
  // "r, g, b", for rgba() in CSS
  text: string;
  shadow: string;
  shadowAlpha: number;
  // Opacity of lines still to come and of lines already sung
  upcomingAlpha: number;
  pastAlpha: number;
  // The worst contrast of the text against what is behind it (1 to 21)
  contrast: number;
}

export const LIGHT = '#f4f6fb';
export const DARK = '#12151c';
// Colors under this share of the area are specks; they do not decide the text color
export const SIGNIFICANT_SHARE = 0.1;
// WCAG's minimum for body text
export const GOOD_CONTRAST = 4.5;

export function parseHex(text: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

// WCAG 2 relative luminance, 0 (black) to 1 (white)
export function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Colors from untrusted JSON, or null when they are not backdrop's shape
export function validColors(value: unknown): OverlayColors | null {
  if (!value || typeof value !== 'object') return null;
  const { background, main } = value as Record<string, unknown>;
  if (typeof background !== 'string' || !parseHex(background) || !Array.isArray(main)) return null;
  const entries = main.filter((entry): entry is { color: string; share: number } =>
    !!entry && typeof entry.color === 'string' && !!parseHex(entry.color) && typeof entry.share === 'number' && entry.share >= 0);
  return { background, main: entries };
}

const triplet = (rgb: [number, number, number]) => rgb.join(', ');
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function textTheme(colors: OverlayColors): TextTheme {
  const behind = [colors.background, ...colors.main.filter(entry => entry.share >= SIGNIFICANT_SHARE).map(entry => entry.color)]
    .map(parseHex).filter((rgb): rgb is [number, number, number] => rgb !== null);
  const light = parseHex(LIGHT)!, dark = parseHex(DARK)!;
  const worst = (text: [number, number, number]) => Math.min(...behind.map(color => contrastRatio(text, color)));
  const lightContrast = worst(light), darkContrast = worst(dark);
  // Ties go to light text, the renderer's own look
  const useLight = lightContrast >= darkContrast;
  const contrast = useLight ? lightContrast : darkContrast;
  // 0 when contrast is good, 1 when it is as bad as it gets
  const weakness = clamp((GOOD_CONTRAST - contrast) / (GOOD_CONTRAST - 1), 0, 1);
  return {
    text: triplet(useLight ? light : dark),
    shadow: triplet(useLight ? dark : light),
    shadowAlpha: Math.round((0.45 + 0.4 * weakness) * 100) / 100,
    upcomingAlpha: Math.round((0.5 + 0.2 * weakness) * 100) / 100,
    pastAlpha: Math.round((0.32 + 0.18 * weakness) * 100) / 100,
    contrast: Math.round(contrast * 100) / 100
  };
}

// The CSS variables the overlay's style reads
export function themeVariables(theme: TextTheme): Record<string, string> {
  return {
    '--overlay-text': theme.text,
    '--overlay-shadow': theme.shadow,
    '--overlay-shadow-alpha': String(theme.shadowAlpha),
    '--overlay-upcoming-alpha': String(theme.upcomingAlpha),
    '--overlay-past-alpha': String(theme.pastAlpha)
  };
}
