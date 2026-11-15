import React from 'react';
import {ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {useTheme, useThemeMode} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import {SUPABASE_PROJECT_LABEL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL} from '../lib/supabase';
import {useSettingsStore, type VideoQuality} from '../store/settings';
import {useAuthStore} from '../store/auth';
import {useDevicesStore} from '../store/devices';
import Card from '../components/Card';
import SecondaryButton from '../components/SecondaryButton';
import SectionHeader from '../components/SectionHeader';
import Segmented from '../components/Segmented';
import AppIcon, {type AppIconName} from '../components/AppIcon';
import {AppBar, ScreenHeader} from '../components/Header';
import type {RootStackParamList} from '../navigation/types';

const THEME_OPTIONS: {value: 'system' | 'light' | 'dark'; label: string}[] = [
  {value: 'system', label: 'System'},
  {value: 'light', label: 'Light'},
  {value: 'dark', label: 'Dark'},
];

const QUALITY_OPTIONS: {value: VideoQuality; label: string}[] = [
  {value: 'adaptive', label: 'Auto'},
  {value: 'high', label: 'High'},
  {value: 'medium', label: 'Medium'},
  {value: 'low', label: 'Low'},
];

const QUALITY_HINT: Record<VideoQuality, string> = {
  adaptive: 'Adjusts resolution to your connection.',
  high: 'Up to 1080p at 30 fps. Best on Wi-Fi.',
  medium: '720p at 24 fps. A good balance.',
  low: '480p at 15 fps. For slow mobile networks.',
};

/** Leading icon + title/subtitle + trailing control, used inside cards. */
function Row({
  icon,
  title,
  subtitle,
  trailing,
  children,
  divider,
}: {
  icon: AppIconName;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
  divider?: boolean;
}) {
  const {palette} = useTheme();
  return (
    <View
      style={[
        styles.row,
        divider && {borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: palette.border},
      ]}>
      <View style={styles.rowHead}>
        <View style={[styles.rowIcon, {backgroundColor: palette.surfaceContainer}]}>
          <AppIcon name={icon} color={palette.textSecondary} size={20} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, {color: palette.textPrimary}]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.rowSubtitle, {color: palette.textSecondary}]}>{subtitle}</Text>
          ) : null}
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

export default function SettingsScreen() {
  const {palette} = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {preference, setPreference} = useThemeMode();
  const defaultQuality = useSettingsStore(s => s.defaultQuality);
  const haptics = useSettingsStore(s => s.haptics);
  const setDefaultQuality = useSettingsStore(s => s.setDefaultQuality);
  const setHaptics = useSettingsStore(s => s.setHaptics);
  const token = useAuthStore(s => s.token);
  const email = useAuthStore(s => s.email);
  const link = useDevicesStore(s => s.link);

  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<{ok: boolean; detail: string} | null>(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    const started = Date.now();
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: {apikey: SUPABASE_PUBLISHABLE_KEY},
      });
      const ms = Date.now() - started;
      setResult(
        response.ok
          ? {ok: true, detail: `Server reachable (${ms} ms)`}
          : {ok: false, detail: `Server answered HTTP ${response.status}`},
      );
    } catch {
      setResult({ok: false, detail: 'Can’t reach the server. Check your internet connection.'});
    } finally {
      setTesting(false);
    }
  };

  const linkLabel = !token
    ? 'Sign in to connect'
    : link === 'online'
      ? 'Connected'
      : 'Connecting…';

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <AppBar
        email={email}
        onAvatarPress={() => navigation.navigate('Tabs', {screen: 'Profile'})}
      />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="Settings" />

        <SectionHeader title="Server" />
        <Card padded={false}>
          <Row
            icon="server"
            title="Supabase"
            subtitle="Sign-in, your computers, pairing and connection setup. Screen and input stay peer-to-peer.">
            <View style={styles.linkPill}>
              <View
                style={[
                  styles.linkDot,
                  {
                    backgroundColor:
                      token && link === 'online' ? palette.success.base : palette.textDisabled,
                  },
                ]}
              />
              <Text style={[styles.linkText, {color: palette.textSecondary}]}>
                {linkLabel} · project {SUPABASE_PROJECT_LABEL}
              </Text>
            </View>
            {result ? (
              <View style={styles.resultRow}>
                <AppIcon
                  name={result.ok ? 'check' : 'warning'}
                  color={result.ok ? palette.success.base : palette.error.base}
                  size={18}
                />
                <Text
                  style={[
                    styles.resultText,
                    {color: result.ok ? palette.success.base : palette.error.base},
                  ]}>
                  {result.detail}
                </Text>
              </View>
            ) : null}
            <SecondaryButton
              label={testing ? 'Checking…' : 'Check connection'}
              icon="refresh"
              onPress={() => void runTest()}
              disabled={testing}
            />
          </Row>
        </Card>

        <SectionHeader title="Appearance" />
        <Card padded={false}>
          <Row icon="settings" title="Theme" subtitle="Follow the system or pick one.">
            <Segmented options={THEME_OPTIONS} value={preference} onChange={setPreference} />
          </Row>
        </Card>

        <SectionHeader title="Remote sessions" />
        <Card padded={false}>
          <Row icon="tune" title="Default quality" subtitle={QUALITY_HINT[defaultQuality]}>
            <Segmented options={QUALITY_OPTIONS} value={defaultQuality} onChange={setDefaultQuality} />
          </Row>
          <Row
            divider
            icon="touch"
            title="Haptic feedback"
            subtitle="A light tap on clicks and key presses."
            trailing={
              <Switch
                accessibilityLabel="Haptic feedback"
                value={haptics}
                onValueChange={setHaptics}
                trackColor={{false: palette.surfaceContainerHighest, true: palette.primary}}
                thumbColor={palette.mode === 'dark' ? palette.textPrimary : '#FFFFFF'}
                ios_backgroundColor={palette.surfaceContainerHighest}
              />
            }
          />
        </Card>

        <SectionHeader title="Help" />
        <Card padded={false}>
          <Row
            icon="info"
            title="Setup guide"
            subtitle="Install the host app and pair a computer."
            trailing={
              <SecondaryButton
                label="Open"
                variant="text"
                onPress={() => navigation.navigate('Setup')}
              />
            }
          />
          <Row
            divider
            icon="shield"
            title="Privacy"
            subtitle="Screen and input travel peer-to-peer over encrypted WebRTC. Supabase only stores your account, your computers' names and status, and screenshots you take."
          />
        </Card>
        <Text style={[styles.version, {color: palette.textTertiary}]}>
          Remote PC 1.2.0 · Supabase backend
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  body: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  flex: {flex: 1},
  row: {
    padding: spacing.md,
    gap: spacing.md,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: shape.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...typography.titleMedium,
  },
  rowSubtitle: {
    ...typography.bodySmall,
    fontSize: 13,
    lineHeight: 18,
  },
  linkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 56,
    marginTop: -spacing.sm,
  },
  linkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  linkText: {
    ...typography.labelMedium,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  resultText: {
    ...typography.bodyMedium,
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  version: {
    ...typography.bodySmall,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
