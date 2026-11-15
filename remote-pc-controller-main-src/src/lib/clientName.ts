/**
 * A short, human name for this phone ("Google Pixel 7 · Android 16"),
 * stored with every session so the PC owner can see which device connected
 * (Remote PC Host → Connection history, and the Remote Support consent
 * dialog). No identifiers — only what Settings → About phone shows.
 */
import {Platform} from 'react-native';

function title(word: string) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

export function clientName(): string {
  const c = (Platform.constants ?? {}) as Record<string, unknown>;
  if (Platform.OS === 'android') {
    const brand = title(String(c.Brand ?? c.Manufacturer ?? '').trim());
    let model = String(c.Model ?? '').trim();
    if (brand && model.toLowerCase().startsWith(brand.toLowerCase())) {
      model = model.slice(brand.length).trim();
    }
    const device = [brand, model].filter(Boolean).join(' ') || 'Android phone';
    const release = String(c.Release ?? '').trim();
    return (release ? `${device} · Android ${release}` : device).slice(0, 80);
  }
  if (Platform.OS === 'ios') {
    const idiom = String(c.interfaceIdiom ?? '') === 'pad' ? 'iPad' : 'iPhone';
    return `${idiom} · iOS ${String(Platform.Version)}`.slice(0, 80);
  }
  return String(Platform.OS).slice(0, 80);
}
