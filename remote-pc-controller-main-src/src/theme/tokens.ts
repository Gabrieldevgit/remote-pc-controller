import type {TextStyle, ViewStyle} from 'react-native';

// ---------------------------------------------------------------------------
// Design tokens for remote-pc-controller (ivory / charcoal / slate / copper).
// Single source of truth for color, shape, spacing, type and elevation.
// Components and screens must consume these tokens via useTheme() — never
// hardcode hex values outside of this file.
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark';
export type ThemePreference = 'light' | 'dark' | 'system';

/** A semantic color role with base and soft container variants (M3 style). */
export interface SemanticColors {
  /** Strong variant, used for icons, status dots and filled controls. */
  base: string;
  /** Content rendered on top of `base`. */
  onBase: string;
  /** Soft tinted container used for chips, banners and tonal buttons. */
  container: string;
  /** Content rendered on top of `container`. */
  onContainer: string;
}

export interface Palette {
  mode: ThemeMode;

  // Surfaces
  background: string;
  surface: string;
  surfaceVariant: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;

  // Text tiers
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;

  // Accent (single copper accent)
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  /** Pure brand copper for illustrations, dots and small highlights. */
  accent: string;

  // Semantic roles
  success: SemanticColors;
  error: SemanticColors;
  warning: SemanticColors;
  info: SemanticColors;

  // Lines
  border: string;
  borderStrong: string;
  outline: string;

  // Inverse / scrim
  inverseSurface: string;
  inverseOnSurface: string;
  scrim: string;
}

// ---------------------------------------------------------------------------
// Brand palette. Five colors, used everywhere through the semantic palettes
// below: warm ivory, charcoal, slate, a restrained copper accent and grey.
// No gradients, no glows — flat fills, clean 1px borders, subtle shadows.
// ---------------------------------------------------------------------------

export const brand = {
  ivory: '#F4F2ED',
  charcoal: '#17191C',
  slate: '#292E34',
  copper: '#C87545',
  grey: '#92969A',
} as const;

export const LIGHT: Palette = {
  mode: 'light',

  background: brand.ivory,
  surface: '#FBFAF7',
  surfaceVariant: '#E6E2DA',
  surfaceContainer: '#EEEBE4',
  surfaceContainerHigh: '#E7E3DB',
  surfaceContainerHighest: '#DFDAD1',

  textPrimary: brand.charcoal,
  textSecondary: '#4A4F56',
  textTertiary: '#6E7277',
  textDisabled: brand.grey,

  // Deepened copper keeps white labels at AA contrast on ivory surfaces;
  // the pure brand copper is used for illustrations and small accents.
  primary: '#AE5F33',
  onPrimary: '#FFFFFF',
  primaryContainer: '#F3E1D4',
  onPrimaryContainer: '#5A2A10',
  secondaryContainer: '#E6E2DA',
  onSecondaryContainer: brand.slate,
  accent: brand.copper,

  success: {
    base: '#2F7A4A',
    onBase: '#FFFFFF',
    container: '#DCEDDF',
    onContainer: '#123821',
  },
  error: {
    base: '#B3402E',
    onBase: '#FFFFFF',
    container: '#F6DDD7',
    onContainer: '#4D140A',
  },
  warning: {
    base: '#93650F',
    onBase: '#FFFFFF',
    container: '#F3E5C8',
    onContainer: '#3A2700',
  },
  info: {
    base: '#476581',
    onBase: '#FFFFFF',
    container: '#DFE6EC',
    onContainer: '#17293A',
  },

  border: '#E0DCD3',
  borderStrong: '#C9C4BA',
  outline: brand.grey,

  inverseSurface: brand.slate,
  inverseOnSurface: brand.ivory,
  scrim: '#000000',
};

export const DARK: Palette = {
  mode: 'dark',

  background: brand.charcoal,
  surface: '#1E2125',
  surfaceVariant: brand.slate,
  surfaceContainer: '#24282D',
  surfaceContainerHigh: brand.slate,
  surfaceContainerHighest: '#343A41',

  textPrimary: brand.ivory,
  textSecondary: '#C4C3BE',
  textTertiary: brand.grey,
  textDisabled: '#6A6E73',

  primary: brand.copper,
  onPrimary: brand.charcoal,
  primaryContainer: '#3A2A20',
  onPrimaryContainer: '#F2C6A8',
  secondaryContainer: brand.slate,
  onSecondaryContainer: brand.ivory,
  accent: brand.copper,

  success: {
    base: '#7CC594',
    onBase: '#0E2A18',
    container: '#1F3427',
    onContainer: '#BFE5CB',
  },
  error: {
    base: '#F0A496',
    onBase: '#3D0F06',
    container: '#43231D',
    onContainer: '#F8D3CB',
  },
  warning: {
    base: '#E2B65C',
    onBase: '#2E1F00',
    container: '#3B3020',
    onContainer: '#F3DDB0',
  },
  info: {
    base: '#9DB7CF',
    onBase: '#13263A',
    container: '#26313C',
    onContainer: '#D5E2EE',
  },

  border: '#2F343B',
  borderStrong: '#3D434B',
  outline: brand.grey,

  inverseSurface: brand.ivory,
  inverseOnSurface: brand.charcoal,
  scrim: '#000000',
};

// ---------------------------------------------------------------------------
// Color math helpers (state layers, overlays). Input must be #RRGGBB.
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHexByte(value: number): string {
  const clamped = Math.round(Math.min(255, Math.max(0, value)));
  return clamped.toString(16).padStart(2, '0');
}

/** Append an alpha channel to an #RRGGBB hex color. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  return `${hex}${toHexByte(a * 255)}`;
}

/**
 * Blend `fg` over `bg` where `ratio` (0..1) is the weight of `fg`.
 * Used to approximate M3 state layers without extra views.
 */
export function mix(fg: string, bg: string, ratio: number): string {
  const r = Math.min(1, Math.max(0, ratio));
  const [fr, fgc, fb] = hexToRgb(fg);
  const [br, bgc, bb] = hexToRgb(bg);
  return `#${toHexByte(fr * r + br * (1 - r))}${toHexByte(
    fgc * r + bgc * (1 - r),
  )}${toHexByte(fb * r + bb * (1 - r))}`;
}

/** M3 state-layer opacities. */
export const stateOpacity = {
  hover: 0.08,
  focus: 0.1,
  pressed: 0.12,
  dragged: 0.16,
  disabled: 0.38,
} as const;

// ---------------------------------------------------------------------------
// Elevation (M3 levels). Shadow colors are intentionally neutral here.
// ---------------------------------------------------------------------------

export type ElevationLevel = 'level0' | 'level1' | 'level2' | 'level3';

export const elevation: Record<ElevationLevel, ViewStyle> = {
  level0: {},
  level1: {
    shadowColor: '#17191C',
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  level2: {
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  level3: {
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.14,
    shadowRadius: 10,
    elevation: 6,
  },
};

// ---------------------------------------------------------------------------
// Shape scale
// ---------------------------------------------------------------------------

export const shape = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 28,
  full: 9999,
} as const;

// ---------------------------------------------------------------------------
// Spacing scale
// ---------------------------------------------------------------------------

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

// ---------------------------------------------------------------------------
// Icon size scale
// ---------------------------------------------------------------------------

export const iconSize = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const;

// ---------------------------------------------------------------------------
// Typography scale (M3 type roles)
// ---------------------------------------------------------------------------

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: TextStyle['fontWeight'];
  letterSpacing?: number;
}

export const typography = {
  displayLarge: {fontSize: 57, lineHeight: 64, fontWeight: '400'},
  displayMedium: {fontSize: 45, lineHeight: 52, fontWeight: '400'},
  displaySmall: {fontSize: 36, lineHeight: 44, fontWeight: '400'},
  headlineLarge: {fontSize: 34, lineHeight: 40, fontWeight: '600', letterSpacing: -0.5},
  headlineMedium: {fontSize: 28, lineHeight: 34, fontWeight: '600', letterSpacing: -0.3},
  headlineSmall: {fontSize: 24, lineHeight: 30, fontWeight: '600', letterSpacing: -0.2},
  titleLarge: {fontSize: 22, lineHeight: 28, fontWeight: '500', letterSpacing: -0.1},
  titleMedium: {fontSize: 16, lineHeight: 24, fontWeight: '500', letterSpacing: 0.15},
  titleSmall: {fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0.1},
  bodyLarge: {fontSize: 16, lineHeight: 24, fontWeight: '400', letterSpacing: 0.5},
  bodyMedium: {fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: 0.25},
  bodySmall: {fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0.4},
  labelLarge: {fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0.1},
  labelMedium: {fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.5},
  labelSmall: {fontSize: 11, lineHeight: 16, fontWeight: '500', letterSpacing: 0.5},
} satisfies Record<string, TypeStyle>;
