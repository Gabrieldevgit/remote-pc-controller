import React from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import AppIcon from './AppIcon';

export type ToastTone = 'success' | 'error' | 'neutral';

export interface ToastState {
  message: string;
  tone: ToastTone;
}

const TOAST_VISIBLE_MS = 2800;

/** Snackbar state helper: `notify(message, tone)` shows it for ~3 s. */
export function useToast() {
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = React.useCallback((message: string, tone: ToastTone = 'neutral') => {
    setToast({message, tone});
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setToast(null), TOAST_VISIBLE_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return {toast, notify};
}

/** Inverse-surface snackbar anchored to the bottom; fades in quietly. */
export default function Toast({toast, bottom = spacing.lg}: {toast: ToastState | null; bottom?: number}) {
  const {palette} = useTheme();
  const opacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.timing(opacity, {
      toValue: toast ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [toast, opacity]);

  if (!toast) {
    return null;
  }
  const iconColor =
    toast.tone === 'error'
      ? palette.error.base
      : toast.tone === 'success'
        ? palette.success.base
        : palette.inverseOnSurface;
  return (
    <View style={[styles.anchor, {paddingBottom: bottom}]} pointerEvents="none">
      <Animated.View
        accessibilityLiveRegion="polite"
        style={[styles.toast, {backgroundColor: palette.inverseSurface, opacity}]}>
        {toast.tone !== 'neutral' ? (
          <AppIcon
            name={toast.tone === 'error' ? 'warning' : 'check'}
            color={palette.mode === 'dark' ? iconColor : palette.inverseOnSurface}
            size={18}
          />
        ) : null}
        <Text style={[styles.text, {color: palette.inverseOnSurface}]} numberOfLines={2}>
          {toast.message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 520,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: shape.md,
  },
  text: {
    ...typography.bodyMedium,
    flexShrink: 1,
  },
});
