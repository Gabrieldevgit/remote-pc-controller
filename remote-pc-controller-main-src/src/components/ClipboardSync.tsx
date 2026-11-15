import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

import {useTheme} from '../theme/ThemeProvider';
import {DARK, LIGHT, shape, spacing, typography} from '../theme/tokens';
import AppIcon from './AppIcon';
import type {InputMessage} from '../lib/inputProtocol';

export interface ClipboardSyncHandle {
  /** Ask the remote machine for its clipboard contents. */
  pullRemote: () => void;
}

interface ClipboardSyncProps {
  /** Sends an input message over the session data channel. */
  send: (message: InputMessage) => void;
  /** True once the data channel is open and messages can flow. */
  connected: boolean;
  /** Latest text pulled from the remote clipboard (null clears the toast). */
  remoteText: string | null;
  /** Called when the toast is dismissed without copying. */
  onDismissRemote: () => void;
}

/**
 * Clipboard bridge for a remote session.
 *
 * - On connect it reads the phone clipboard and pushes it to the remote PC.
 * - `pullRemote()` (toolbar long-press) requests the remote clipboard and
 *   shows a toast offering to copy it onto the phone.
 */
const ClipboardSync = React.forwardRef<ClipboardSyncHandle, ClipboardSyncProps>(
  function ClipboardSync(
    {send, connected, remoteText, onDismissRemote},
    ref,
  ) {
    const {palette} = useTheme();
    const pushedRef = React.useRef(false);

    // Push the phone clipboard to the remote machine once per session.
    React.useEffect(() => {
      if (!connected || pushedRef.current) {
        return;
      }
      pushedRef.current = true;
      Clipboard.getString()
        .then(text => {
          if (text) {
            send({t: 'clipboard.set', text});
          }
        })
        .catch(() => {
          // Clipboard access can be denied; not fatal.
        });
    }, [connected, send]);

    React.useImperativeHandle(ref, () => ({
      pullRemote: () => {
        send({t: 'clipboard.get'});
      },
    }));

    // Inverse surfaces flip the mode, so borrow the other palette's accent.
    const action = palette.mode === 'dark' ? LIGHT.primary : DARK.primary;

    const copyToLocal = (text: string) => {
      Clipboard.setString(text);
      onDismissRemote();
    };

    if (!remoteText) {
      return null;
    }

    return (
      <View style={styles.toastAnchor} pointerEvents="box-none">
        <View
          style={[
            styles.toast,
            {backgroundColor: palette.inverseSurface},
          ]}>
          <AppIcon name="clipboard" color={palette.inverseOnSurface} size={18} />
          <View style={styles.textCol}>
            <Text style={[styles.caption, {color: palette.inverseOnSurface}]}>
              Copied on your computer
            </Text>
          <Text
            style={[styles.toastText, {color: palette.inverseOnSurface}]}
            numberOfLines={2}>
            {remoteText}
          </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy remote clipboard to phone"
            onPress={() => copyToLocal(remoteText)}
            hitSlop={8}>
            <Text style={[styles.toastAction, {color: action}]}>
              Copy here
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss clipboard toast"
            onPress={onDismissRemote}
            hitSlop={8}>
            <AppIcon name="close" color={palette.inverseOnSurface} size={18} />
          </Pressable>
        </View>
      </View>
    );
  },
);

export default ClipboardSync;

const styles = StyleSheet.create({
  toastAnchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 72,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  textCol: {
    flexShrink: 1,
    gap: 2,
  },
  caption: {
    ...typography.labelSmall,
    opacity: 0.7,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 520,
    gap: spacing.sm + 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: shape.md,
  },
  toastText: {
    ...typography.bodySmall,
    flexShrink: 1,
  },
  toastAction: {
    ...typography.labelLarge,
  },
});
