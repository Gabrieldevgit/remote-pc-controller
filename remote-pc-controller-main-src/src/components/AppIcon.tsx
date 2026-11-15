import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

export type AppIconName =
  | 'add'
  | 'arrow-back'
  | 'bell'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'check'
  | 'clipboard'
  | 'close'
  | 'computer'
  | 'connect'
  | 'copy'
  | 'delete'
  | 'devices'
  | 'edit'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'image'
  | 'info'
  | 'keyboard'
  | 'lock'
  | 'logout'
  | 'mouse'
  | 'person'
  | 'power'
  | 'refresh'
  | 'remove'
  | 'rotate'
  | 'save'
  | 'server'
  | 'settings'
  | 'share'
  | 'shield'
  | 'stats'
  | 'touch'
  | 'tune'
  | 'volume-down'
  | 'volume-mute'
  | 'volume-up'
  | 'warning';

interface AppIconProps {
  name: AppIconName;
  size?: number;
  color: string;
}

/** A small, original line-icon set so every action stays recognisable without image assets. */
export default function AppIcon({name, size = 20, color}: AppIconProps) {
  const c = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const icon = (() => {
    switch (name) {
      case 'add': return <Path {...c} d="M12 5v14M5 12h14" />;
      case 'arrow-back': return <Path {...c} d="m11 5-7 7 7 7M4 12h16" />;
      case 'bell': return <><Path {...c} d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" /><Path {...c} d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>;
      case 'chevron-down': return <Path {...c} d="m6 9 6 6 6-6" />;
      case 'chevron-right': return <Path {...c} d="m9 6 6 6-6 6" />;
      case 'chevron-up': return <Path {...c} d="m6 15 6-6 6 6" />;
      case 'check': return <Path {...c} d="m5 12 4.2 4.2L19 6.5" />;
      case 'clipboard': return <><Rect {...c} x="5" y="4.5" width="14" height="16" rx="2" /><Path {...c} d="M9 4.5V3.5h6v1M9 10h6M9 14h4" /></>;
      case 'close': return <Path {...c} d="M6 6l12 12M18 6 6 18" />;
      case 'computer': return <><Rect {...c} x="3.5" y="4.5" width="17" height="12" rx="1.8" /><Path {...c} d="M8.5 20h7M12 16.5V20" /></>;
      case 'connect': return <><Circle {...c} cx="7" cy="12" r="3" /><Circle {...c} cx="17" cy="12" r="3" /><Path {...c} d="M10 12h4" /></>;
      case 'copy': return <><Rect {...c} x="8.5" y="8.5" width="11" height="11" rx="2" /><Path {...c} d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>;
      case 'delete': return <Path {...c} d="M4 7h16M9 7V4.5h6V7M7 7l.8 13h8.4L17 7M10 10.5v5M14 10.5v5" />;
      case 'devices': return <><Rect {...c} x="4" y="3.5" width="16" height="11.5" rx="1.8" /><Path {...c} d="M9 20.5h6M12 15v5.5" /></>;
      case 'edit': return <><Path {...c} d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10v4Z" /><Path {...c} d="m13.5 6.5 4 4" /></>;
      case 'fullscreen': return <Path {...c} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />;
      case 'fullscreen-exit': return <Path {...c} d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />;
      case 'image': return <><Rect {...c} x="3.5" y="5" width="17" height="14" rx="2" /><Circle {...c} cx="9" cy="10" r="1.6" /><Path {...c} d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" /></>;
      case 'info': return <><Circle {...c} cx="12" cy="12" r="8.5" /><Path {...c} d="M12 11v5.5M12 7.8h.01" /></>;
      case 'keyboard': return <><Rect {...c} x="2.5" y="6" width="19" height="12" rx="2" /><Path {...c} d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M8 14.5h8" /></>;
      case 'lock': return <><Rect {...c} x="5" y="10" width="14" height="10" rx="2" /><Path {...c} d="M8 10V7a4 4 0 0 1 8 0v3" /></>;
      case 'logout': return <><Path {...c} d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" /><Path {...c} d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" /></>;
      case 'mouse': return <><Rect {...c} x="6.5" y="3.5" width="11" height="17" rx="5.5" /><Path {...c} d="M12 3.5v6M6.5 9.5h11" /></>;
      case 'person': return <><Circle {...c} cx="12" cy="8" r="3.5" /><Path {...c} d="M5 20c.8-3.4 3.2-5.2 7-5.2s6.2 1.8 7 5.2" /></>;
      case 'power': return <Path {...c} d="M12 3v8M7.1 5.9A8 8 0 1 0 17 6" />;
      case 'refresh': return <Path {...c} d="M19 8.5V4l-2 2A8 8 0 1 0 20 12M5 15.5V20l2-2" />;
      case 'remove': return <Path {...c} d="M5 12h14" />;
      case 'rotate': return <><Rect {...c} x="7" y="3.5" width="10" height="17" rx="2" /><Path {...c} d="M3 9.5A9 9 0 0 1 5.5 5M21 14.5a9 9 0 0 1-2.5 4.5" /></>;
      case 'save': return <Path {...c} d="M5 4h12l2 2v14H5zM8 4v6h7V4M8 20v-6h8v6" />;
      case 'server': return <><Rect {...c} x="4" y="4" width="16" height="7" rx="1.8" /><Rect {...c} x="4" y="13" width="16" height="7" rx="1.8" /><Path {...c} d="M7.5 7.5h.01M7.5 16.5h.01" /></>;
      case 'settings': return <><Circle {...c} cx="12" cy="12" r="3" /><Path {...c} d="m19.2 13.5 1.1 1.2-2 3.4-1.6-.6a7 7 0 0 1-2 .9L14.5 20h-4l-.3-1.6a7 7 0 0 1-2-.9l-1.6.6-2-3.4 1.1-1.2a7 7 0 0 1 0-3L4.6 9.3l2-3.4 1.6.6a7 7 0 0 1 2-.9L10.5 4h4l.3 1.6a7 7 0 0 1 2 .9l1.6-.6 2 3.4-1.1 1.2a7 7 0 0 1 0 3Z" /></>;
      case 'share': return <><Circle {...c} cx="18" cy="5" r="2.5" /><Circle {...c} cx="6" cy="12" r="2.5" /><Circle {...c} cx="18" cy="19" r="2.5" /><Path {...c} d="m8.2 10.8 7.5-4.4M8.2 13.2l7.5 4.4" /></>;
      case 'shield': return <Path {...c} d="M12 3.5 19 6v5.2c0 4.4-2.8 7.5-7 9.3-4.2-1.8-7-4.9-7-9.3V6l7-2.5ZM9.2 12l1.8 1.8 3.8-3.8" />;
      case 'stats': return <Path {...c} d="M4 20V10M10 20V4M16 20v-7M21 20H3" />;
      case 'touch': return <><Path {...c} d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11l3.6.6a2 2 0 0 1 1.7 2.2l-.6 4.5a2 2 0 0 1-2 1.7H10a2 2 0 0 1-1.6-.8L5.8 15.6a1.4 1.4 0 0 1 2-2L9 14.8" /></>;
      case 'tune': return <><Path {...c} d="M4 7h7M15 7h5M4 17h3M11 17h9" /><Circle {...c} cx="13" cy="7" r="2" /><Circle {...c} cx="9" cy="17" r="2" /></>;
      case 'volume-down': return <><Path {...c} d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><Path {...c} d="M16 12h4" /></>;
      case 'volume-mute': return <><Path {...c} d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><Path {...c} d="m16 10 4 4M20 10l-4 4" /></>;
      case 'volume-up': return <><Path {...c} d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><Path {...c} d="M16 12h4M18 10v4" /></>;
      case 'warning': return <><Path {...c} d="M12 4 21 20H3L12 4Z" /><Path {...c} d="M12 9v4.5M12 17h.01" /></>;
    }
  })();

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {icon}
    </Svg>
  );
}

export function buttonIconForLabel(label: string): AppIconName | undefined {
  const normalized = label.toLowerCase();
  if (normalized.includes('add')) return 'add';
  if (normalized.includes('connect') || normalized.includes('remote')) return 'connect';
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete';
  if (normalized.includes('save')) return 'save';
  if (normalized.includes('test') || normalized.includes('refresh') || normalized.includes('retry')) return 'refresh';
  if (normalized.includes('share')) return 'share';
  if (normalized.includes('lock')) return 'lock';
  if (normalized.includes('sign out')) return 'logout';
  if (normalized.includes('shutdown') || normalized.includes('restart') || normalized.includes('hibernate')) return 'power';
  if (normalized.includes('security')) return 'shield';
  return undefined;
}
