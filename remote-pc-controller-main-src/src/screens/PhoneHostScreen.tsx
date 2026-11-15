import React from 'react';
import {ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import {ScreenHeader} from '../components/Header';
import Card from '../components/Card';
import PrimaryButton from '../components/PrimaryButton';
import SecondaryButton from '../components/SecondaryButton';
import SectionHeader from '../components/SectionHeader';
import AppIcon, {type AppIconName} from '../components/AppIcon';
import {useAuthStore} from '../store/auth';
import {
  disableAvailability,
  enableAvailability,
  openAccessibilitySettings,
  openAppDetails,
  phoneHostSupported,
  recentPhoneSessions,
  refreshAccessibility,
  stopSharing,
  usePhoneHostStore,
  type PhoneSessionRow,
} from '../lib/phoneHost';
import type {RootStackParamList} from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'PhoneHost'>;

function Step({
  icon,
  title,
  text,
  done,
  children,
}: {
  icon: AppIconName;
  title: string;
  text: string;
  done?: boolean;
  children?: React.ReactNode;
}) {
  const {palette} = useTheme();
  return (
    <View style={styles.step}>
      <View style={[styles.stepIcon, {backgroundColor: done ? palette.primaryContainer : palette.surfaceContainer}]}>
        <AppIcon name={done ? 'check' : icon} color={done ? palette.onPrimaryContainer : palette.textSecondary} size={20} />
      </View>
      <View style={styles.flex}>
        <Text style={[styles.stepTitle, {color: palette.textPrimary}]}>{title}</Text>
        <Text style={[styles.body, {color: palette.textSecondary}]}>{text}</Text>
        {children}
      </View>
    </View>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], {day: 'numeric', month: 'short'})} ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
}

function duration(start: string, end: string | null) {
  if (!end) {
    return '';
  }
  const min = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  return min < 1 ? ' · under a minute' : ` · ${min} min`;
}

const REASON: Record<string, string> = {
  declined: 'declined',
  busy: 'phone busy',
  timeout: 'not answered',
  capture_denied: 'sharing not allowed',
  pc_closed: 'ended on the PC',
  phone_stopped: 'stopped on the phone',
};

export default function PhoneHostScreen({navigation}: Props) {
  const {palette} = useTheme();
  const userId = useAuthStore(s => s.userId);
  const available = usePhoneHostStore(s => s.available);
  const busy = usePhoneHostStore(s => s.busy);
  const accessibility = usePhoneHostStore(s => s.accessibility);
  const phase = usePhoneHostStore(s => s.phase);
  const pcName = usePhoneHostStore(s => s.pcName);
  const audioOn = usePhoneHostStore(s => s.audioOn);
  const error = usePhoneHostStore(s => s.error);
  const [history, setHistory] = React.useState<PhoneSessionRow[]>([]);

  React.useEffect(() => {
    void refreshAccessibility();
    void recentPhoneSessions().then(setHistory);
  }, [available, phase]);

  const toggle = (on: boolean) => {
    if (!userId) {
      return;
    }
    void (on ? enableAvailability(userId) : disableAvailability()).catch(() => {});
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader
          title="Control this phone"
          subtitle="From Remote PC Host on your PC"
          onBack={() => navigation.goBack()}
        />
        {!phoneHostSupported ? (
          <Card>
            <Text style={[styles.body, {color: palette.textSecondary}]}>
              Only Android phones can be controlled from a PC.
            </Text>
          </Card>
        ) : null}

        {phase !== 'idle' ? (
          <Card style={[styles.live, {borderColor: palette.primary}]}>
            <Text style={[styles.liveTitle, {color: palette.textPrimary}]}>
              {phase === 'connected' ? `${pcName ?? 'Your PC'} is controlling this phone` : `Connecting to ${pcName ?? 'your PC'}…`}
            </Text>
            <Text style={[styles.body, {color: palette.textSecondary}]}>
              {accessibility ? 'Taps, typing and Back/Home/Recents come from the PC.' : 'View only — turn on the accessibility service below to allow control.'}
              {audioOn ? ' Phone sound is shared.' : ''}
            </Text>
            <PrimaryButton label="Stop sharing" onPress={stopSharing} />
          </Card>
        ) : null}

        <Card padded={false}>
          <View style={styles.toggleRow}>
            <View style={styles.flex}>
              <Text style={[styles.stepTitle, {color: palette.textPrimary}]}>Available to my PCs</Text>
              <Text style={[styles.body, {color: palette.textSecondary}]}>
                {available
                  ? 'Your PCs signed in to this account can ask to connect. You allow each session here.'
                  : 'Off — no PC can ask to connect.'}
              </Text>
            </View>
            <Switch
              value={available}
              disabled={busy || !userId || !phoneHostSupported}
              onValueChange={toggle}
              trackColor={{true: palette.primary, false: palette.borderStrong}}
              thumbColor={palette.surface}
            />
          </View>
          {error ? <Text style={[styles.error, {color: palette.error.base}]}>{error}</Text> : null}
        </Card>

        <SectionHeader title="Set up" />
        <Card>
          <Step
            icon="person"
            title="1. Same account on the PC"
            text="In Remote PC Host → Account & history, sign in with this account. This phone then appears under “Your phones”."
            done={Boolean(userId)}
          />
          <Step
            icon="touch"
            title="2. Allow control"
            text="Turn on Remote PC in Settings → Accessibility (Downloaded apps). Without it the PC can only watch."
            done={accessibility}>
            {!accessibility ? (
              <View style={styles.stepActions}>
                <SecondaryButton label="Open accessibility settings" onPress={openAccessibilitySettings} />
                <Text style={[styles.small, {color: palette.textTertiary}]}>
                  Greyed out on Android 13+? Open App info → ⋮ → “Allow restricted settings”, then try again.
                </Text>
                <SecondaryButton label="Open App info" variant="text" onPress={openAppDetails} />
              </View>
            ) : null}
          </Step>
          <Step
            icon="shield"
            title="3. Accept each session"
            text="When your PC connects, tap Allow, then accept Android’s “Start recording or casting?” prompt. A notification shows while the phone is shared."
          />
        </Card>

        <SectionHeader title="Recent sessions" />
        <Card padded={false}>
          {history.length === 0 ? (
            <Text style={[styles.empty, {color: palette.textSecondary}]}>No sessions yet.</Text>
          ) : (
            history.map((row, i) => (
              <View
                key={row.id}
                style={[styles.historyRow, i > 0 && {borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: palette.border}]}>
                <AppIcon name="computer" color={palette.textSecondary} size={20} />
                <View style={styles.flex}>
                  <Text style={[styles.stepTitle, {color: palette.textPrimary}]}>{row.client_name ?? 'Your PC'}</Text>
                  <Text style={[styles.small, {color: palette.textSecondary}]}>
                    {when(row.created_at)}
                    {row.state === 'ended' && row.end_reason && REASON[row.end_reason] ? ` · ${REASON[row.end_reason]}` : duration(row.created_at, row.ended_at)}
                    {row.state === 'rejected' ? ' · declined' : ''}
                    {row.state === 'accepted' ? ' · connected now' : ''}
                  </Text>
                </View>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  flex: {flex: 1},
  content: {padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md},
  body: {...typography.bodyMedium},
  small: {...typography.bodySmall},
  error: {...typography.bodySmall, paddingHorizontal: spacing.md, paddingBottom: spacing.md},
  live: {gap: spacing.sm, borderWidth: 1.5},
  liveTitle: {...typography.titleMedium},
  toggleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md},
  step: {flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm},
  stepIcon: {width: 40, height: 40, borderRadius: shape.md, alignItems: 'center', justifyContent: 'center'},
  stepTitle: {...typography.titleSmall},
  stepActions: {gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start'},
  empty: {...typography.bodyMedium, padding: spacing.md},
  historyRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md},
});
