import React from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import {useAuthStore, describeAuthError} from '../store/auth';
import {SUPABASE_PROJECT_LABEL} from '../lib/supabase';
import {useDevicesStore} from '../store/devices';
import Card from '../components/Card';
import PrimaryButton from '../components/PrimaryButton';
import SecondaryButton from '../components/SecondaryButton';
import SectionHeader from '../components/SectionHeader';
import Segmented from '../components/Segmented';
import TextField from '../components/TextField';
import IconButton from '../components/IconButton';
import AppIcon from '../components/AppIcon';
import Toast, {useToast} from '../components/Toast';
import {AppBar, BrandMark, ScreenHeader} from '../components/Header';
import type {RootStackParamList} from '../navigation/types';

type Mode = 'signin' | 'register';

const MODE_OPTIONS: {value: Mode; label: string}[] = [
  {value: 'signin', label: 'Sign in'},
  {value: 'register', label: 'Create account'},
];

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function AuthForm({onOpenSettings}: {onOpenSettings: () => void}) {
  const {palette} = useTheme();
  const busy = useAuthStore(s => s.busy);
  const login = useAuthStore(s => s.login);
  const register = useAuthStore(s => s.register);
  const resendConfirmation = useAuthStore(s => s.resendConfirmation);
  const [pendingEmail, setPendingEmail] = React.useState<string | null>(null);
  const [resent, setResent] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('signin');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const passwordRef = React.useRef<TextInput>(null);

  const passwordTooShort = mode === 'register' && password.length > 0 && password.length < 8;
  const canSubmit = looksLikeEmail(email) && password.length >= (mode === 'register' ? 8 : 1);

  const submit = async () => {
    if (!canSubmit || busy) {
      return;
    }
    setError(null);
    try {
      if (mode === 'register') {
        const needsConfirmation = await register(email, password);
        if (needsConfirmation) {
          // Supabase emailed a confirmation link; sign in after confirming.
          setPendingEmail(email.trim());
          setResent(false);
          setMode('signin');
        }
        return;
      }
      await login(email, password);
    } catch (err) {
      setError(describeAuthError(err));
    }
  };

  return (
    <>
      <View style={styles.authHero}>
        <BrandMark size={48} />
        <Text style={[styles.authTitle, {color: palette.textPrimary}]}>
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </Text>
        <Text style={[styles.authSub, {color: palette.textSecondary}]}>
          Your account owns the computers you pair. Only you can see or control them.
        </Text>
      </View>

      <Card style={styles.authCard}>
        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={next => {
            setMode(next);
            setError(null);
          }}
        />
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <TextField
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
          secureTextEntry
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          textContentType={mode === 'register' ? 'newPassword' : 'password'}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          error={passwordTooShort ? 'Use at least 8 characters.' : null}
        />
        {pendingEmail ? (
          <View style={[styles.noticeBox, {backgroundColor: palette.primaryContainer}]}>
            <AppIcon name="check" color={palette.onPrimaryContainer} size={18} />
            <View style={styles.flex}>
              <Text style={[styles.errorText, {color: palette.onPrimaryContainer}]}>
                We sent a confirmation link to {pendingEmail}. Open it, then sign in here.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={resent}
                onPress={() => {
                  resendConfirmation(pendingEmail)
                    .then(() => setResent(true))
                    .catch(err => setError(describeAuthError(err)));
                }}>
                <Text style={[styles.noticeAction, {color: palette.onPrimaryContainer}]}>
                  {resent ? 'Email sent again' : 'Resend email'}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {error ? (
          <View style={[styles.errorBox, {backgroundColor: palette.error.container}]}>
            <AppIcon name="warning" color={palette.error.onContainer} size={18} />
            <Text style={[styles.errorText, {color: palette.error.onContainer}]}>{error}</Text>
          </View>
        ) : null}
        <PrimaryButton
          label={mode === 'signin' ? 'Sign in' : 'Create account'}
          loading={busy}
          disabled={!canSubmit}
          onPress={() => void submit()}
        />
      </Card>

      <Pressable
        accessibilityRole="button"
        onPress={onOpenSettings}
        style={({pressed}) => [styles.relayHint, {opacity: pressed ? 0.7 : 1}]}>
        <AppIcon name="shield" color={palette.textTertiary} size={16} />
        <Text style={[styles.relayHintText, {color: palette.textTertiary}]} numberOfLines={1}>
          Secured by Supabase · project {SUPABASE_PROJECT_LABEL}
        </Text>
      </Pressable>
    </>
  );
}

export default function ProfileScreen() {
  const {palette} = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const token = useAuthStore(s => s.token);
  const userId = useAuthStore(s => s.userId);
  const email = useAuthStore(s => s.email);
  const signOut = useAuthStore(s => s.signOut);
  const devices = useDevicesStore(s => s.devices);
  const link = useDevicesStore(s => s.link);
  const {toast, notify} = useToast();

  const openSettings = () => navigation.navigate('Tabs', {screen: 'Settings'});
  const online = devices.filter(d => d.online).length;

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <AppBar email={email} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {!token ? (
            <AuthForm onOpenSettings={openSettings} />
          ) : (
            <>
              <ScreenHeader title="Account" />
              <Card style={styles.identity}>
                <View style={[styles.avatar, {backgroundColor: palette.accent}]}>
                  <Text style={styles.avatarText}>
                    {(email ?? '?').charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.email, {color: palette.textPrimary}]} numberOfLines={1}>
                    {email}
                  </Text>
                  <Text style={[styles.meta, {color: palette.textSecondary}]}>
                    {link === 'online' ? 'Signed in · connected' : 'Signed in · connecting…'}
                  </Text>
                </View>
              </Card>

              <View style={styles.stats}>
                <Card style={styles.stat}>
                  <Text style={[styles.statValue, {color: palette.textPrimary}]}>{devices.length}</Text>
                  <Text style={[styles.statLabel, {color: palette.textSecondary}]}>
                    {devices.length === 1 ? 'Computer' : 'Computers'}
                  </Text>
                </Card>
                <Card style={styles.stat}>
                  <Text style={[styles.statValue, {color: palette.textPrimary}]}>{online}</Text>
                  <Text style={[styles.statLabel, {color: palette.textSecondary}]}>Online now</Text>
                </Card>
              </View>

              <SectionHeader title="Details" />
              <Card padded={false}>
                <View style={styles.detailRow}>
                  <View style={styles.flex}>
                    <Text style={[styles.detailLabel, {color: palette.textSecondary}]}>Server</Text>
                    <Text style={[styles.detailValue, {color: palette.textPrimary}]} numberOfLines={1}>
                      Supabase · {SUPABASE_PROJECT_LABEL}
                    </Text>
                  </View>
                  <IconButton icon="chevron-right" accessibilityLabel="Server settings" onPress={openSettings} />
                </View>
                <View style={[styles.detailRow, styles.divider, {borderTopColor: palette.border}]}>
                  <View style={styles.flex}>
                    <Text style={[styles.detailLabel, {color: palette.textSecondary}]}>Account ID</Text>
                    <Text style={[styles.detailValue, styles.mono, {color: palette.textPrimary}]} numberOfLines={1}>
                      {userId}
                    </Text>
                  </View>
                  <IconButton
                    icon="copy"
                    accessibilityLabel="Copy account ID"
                    onPress={() => {
                      if (userId) {
                        Clipboard.setString(userId);
                        notify('Account ID copied', 'success');
                      }
                    }}
                  />
                </View>
              </Card>

              <SecondaryButton
                label="Sign out"
                icon="logout"
                variant="danger"
                style={styles.signOut}
                onPress={() =>
                  Alert.alert('Sign out?', 'You will need your password to sign in again.', [
                    {text: 'Cancel', style: 'cancel'},
                    {text: 'Sign out', style: 'destructive', onPress: signOut},
                  ])
                }
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <Toast toast={toast} />
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
    maxWidth: 560,
    alignSelf: 'center',
  },
  authHero: {
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  authTitle: {
    ...typography.headlineMedium,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  authSub: {
    ...typography.bodyMedium,
    textAlign: 'center',
    maxWidth: 340,
  },
  authCard: {
    gap: spacing.md,
  },
  errorBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    borderRadius: shape.md,
    padding: spacing.sm + 4,
  },
  errorText: {
    ...typography.bodyMedium,
    flex: 1,
  },
  relayHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
  },
  relayHintText: {
    ...typography.bodySmall,
    flexShrink: 1,
  },
  noticeBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: shape.md,
    padding: spacing.sm + 4,
  },
  noticeAction: {
    ...typography.labelLarge,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  relayHintAction: {
    ...typography.labelMedium,
    fontWeight: '600',
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: shape.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    ...typography.headlineSmall,
    color: '#FFFFFF',
  },
  email: {
    ...typography.titleLarge,
  },
  meta: {
    ...typography.bodyMedium,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.sm + 4,
  },
  stat: {
    flex: 1,
    gap: 0,
  },
  statValue: {
    ...typography.headlineMedium,
  },
  statLabel: {
    ...typography.bodyMedium,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm + 4,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  detailLabel: {
    ...typography.bodySmall,
  },
  detailValue: {
    ...typography.bodyLarge,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 14,
  },
  signOut: {
    marginTop: spacing.md,
  },
});
