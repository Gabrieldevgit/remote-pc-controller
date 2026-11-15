import React from 'react';
import {Modal, StyleSheet, Text, View} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import PrimaryButton from './PrimaryButton';
import SecondaryButton from './SecondaryButton';
import AppIcon from './AppIcon';
import {acceptRequest, declineRequest, usePhoneHostStore} from '../lib/phoneHost';

/**
 * Shown anywhere in the app when one of the user's PCs asks to control this
 * phone. Allow → Android's own screen-sharing prompt follows.
 */
export default function PhoneRequestPrompt() {
  const {palette} = useTheme();
  const request = usePhoneHostStore(s => s.request);
  const accessibility = usePhoneHostStore(s => s.accessibility);
  return (
    <Modal visible={request != null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => void declineRequest()}>
      <View style={[styles.scrim, {backgroundColor: 'rgba(0,0,0,0.55)'}]}>
        <View style={[styles.dialog, {backgroundColor: palette.surface, borderColor: palette.border}]}>
          <View style={[styles.icon, {backgroundColor: palette.primaryContainer}]}>
            <AppIcon name="computer" color={palette.onPrimaryContainer} size={26} />
          </View>
          <Text style={[styles.title, {color: palette.textPrimary}]}>
            {request?.pcName ?? 'Your PC'} wants to control this phone
          </Text>
          <Text style={[styles.body, {color: palette.textSecondary}]}>
            Your PC will see this screen{accessibility ? ' and be able to tap, type and use Back, Home and Recents' : ' (view only — control is off in accessibility settings)'}.
            Android asks next to start screen sharing. You can stop at any time from the notification.
          </Text>
          <View style={styles.actions}>
            <SecondaryButton label="Decline" onPress={() => void declineRequest()} />
            <PrimaryButton label="Allow" onPress={() => void acceptRequest()} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.md},
  dialog: {width: '100%', maxWidth: 420, borderRadius: shape.xl ?? 24, borderWidth: 1, padding: spacing.lg, gap: spacing.md},
  icon: {width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center'},
  title: {...typography.titleLarge},
  body: {...typography.bodyMedium},
  actions: {flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm},
});
