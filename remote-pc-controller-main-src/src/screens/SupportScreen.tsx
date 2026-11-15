import React from 'react';
import {KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import {redeemSupportCode} from '../lib/backend';
import {usePhoneHostStore} from '../lib/phoneHost';
import {useAuthStore} from '../store/auth';
import Card from '../components/Card';
import PrimaryButton from '../components/PrimaryButton';
import SectionHeader from '../components/SectionHeader';
import Segmented from '../components/Segmented';
import TextField from '../components/TextField';
import AppIcon from '../components/AppIcon';
import {AppBar, ScreenHeader} from '../components/Header';
import {Illustration} from '../components/Illustration';
import type {RootStackParamList} from '../navigation/types';

type Mode = 'control' | 'view';

const MODE_OPTIONS: {value: Mode; label: string}[] = [
  {value: 'control', label: 'Control'},
  {value: 'view', label: 'View only'},
];

/** "123456789012" → "1234 5678 9012" */
function groupCode(digits: string) {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/**
 * Remote Support: help someone on their PC with the one-time code shown by
 * their Remote PC Host ("Share this screen"). The person at the PC must
 * click Allow before anything is shared.
 */
export default function SupportScreen() {
  const {palette} = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const phoneAvailable = usePhoneHostStore(s => s.available);
  const token = useAuthStore(s => s.token);
  const email = useAuthStore(s => s.email);
  const [digits, setDigits] = React.useState('');
  const [mode, setMode] = React.useState<Mode>('control');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const connect = async () => {
    if (digits.length !== 12 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const {sessionId, hostName} = await redeemSupportCode(digits, mode);
      setDigits('');
      navigation.navigate('RemoteSession', {supportSessionId: sessionId, deviceName: hostName, mode});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <AppBar email={email} onAvatarPress={() => navigation.navigate('Tabs', {screen: 'Profile'})} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <ScreenHeader title="Remote support" subtitle="Help someone on their computer with a one-time code." />

          <Card padded={false} style={styles.card}>
            <Illustration kind="connect" />
            <View style={styles.cardBody}>
              <Text style={[styles.cardTitle, {color: palette.textPrimary}]}>
                Connect to another computer
              </Text>
              <Text style={[styles.cardText, {color: palette.textSecondary}]}>
                Enter the access code from the other person’s Remote PC Host. They will be asked to
                allow you in, and can stop sharing at any time.
              </Text>
              <TextField
                label="Access code"
                value={groupCode(digits)}
                onChangeText={text => {
                  setDigits(text.replace(/\D/g, '').slice(0, 12));
                  setError(null);
                }}
                placeholder="0000 0000 0000"
                keyboardType="number-pad"
                maxLength={14}
                monospace
                editable={Boolean(token)}
                error={error}
                returnKeyType="go"
                onSubmitEditing={() => void connect()}
              />
              <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} />
              <Text style={[styles.hint, {color: palette.textTertiary}]}>
                {mode === 'control'
                  ? 'You’ll see their screen and use their mouse and keyboard.'
                  : 'You’ll only see their screen — nothing you do reaches their computer.'}
              </Text>
              <PrimaryButton
                label={token ? 'Connect' : 'Sign in to help'}
                icon="connect"
                loading={busy}
                disabled={token ? digits.length !== 12 : false}
                onPress={() =>
                  token ? void connect() : navigation.navigate('Tabs', {screen: 'Profile'})
                }
              />
            </View>
          </Card>

          <SectionHeader title="Getting help yourself?" />
          <Card style={styles.helpCard}>
            <View style={[styles.helpIcon, {backgroundColor: palette.surfaceContainer}]}>
              <AppIcon name="computer" color={palette.textSecondary} size={22} />
            </View>
            <View style={styles.flex}>
              <Text style={[styles.helpTitle, {color: palette.textPrimary}]}>Share a PC’s screen</Text>
              <Text style={[styles.cardText, {color: palette.textSecondary}]}>
                On the computer that needs help, open Remote PC Host → Remote Support → Generate code,
                and read the 12 digits to your helper. No account is needed on that computer.
              </Text>
            </View>
          </Card>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate('PhoneHost')}
            style={({pressed}) => pressed && {opacity: 0.85}}>
            <Card style={styles.helpCard}>
              <View style={[styles.helpIcon, {backgroundColor: palette.primaryContainer}]}>
                <AppIcon name="devices" color={palette.onPrimaryContainer} size={22} />
              </View>
              <View style={styles.flex}>
                <Text style={[styles.helpTitle, {color: palette.textPrimary}]}>Control this phone from your PC</Text>
                <Text style={[styles.cardText, {color: palette.textSecondary}]}>
                  {phoneAvailable
                    ? 'Available to your PCs. Open Remote PC Host on your PC → Your phones.'
                    : 'See and use this phone from Remote PC Host on your computer — tap to set up.'}
                </Text>
              </View>
              <AppIcon name="chevron-right" color={palette.textSecondary} size={20} />
            </Card>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  flex: {flex: 1},
  body: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.sm + 4,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  card: {overflow: 'hidden'},
  cardBody: {padding: spacing.lg, gap: spacing.md},
  cardTitle: {...typography.headlineSmall},
  cardText: {...typography.bodyMedium},
  hint: {...typography.bodySmall},
  helpCard: {flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start'},
  helpIcon: {
    width: 44,
    height: 44,
    borderRadius: shape.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpTitle: {...typography.titleMedium},
});
