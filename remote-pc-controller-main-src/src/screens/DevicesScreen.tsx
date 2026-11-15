import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';

import {useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography, withAlpha} from '../theme/tokens';
import {
  BackendError,
  createPairingCode,
  deleteDevice,
  deleteScreenshot,
  renameDevice,
  runDeviceCommand,
  screenshotUrl,
  type DeviceInfo,
} from '../lib/backend';
import {useDevicesStore} from '../store/devices';
import {useAuthStore} from '../store/auth';
import Card from '../components/Card';
import PrimaryButton from '../components/PrimaryButton';
import SecondaryButton from '../components/SecondaryButton';
import SectionHeader from '../components/SectionHeader';
import IconButton from '../components/IconButton';
import TextField from '../components/TextField';
import Toast, {useToast, type ToastTone} from '../components/Toast';
import AppIcon, {type AppIconName} from '../components/AppIcon';
import {AppBar} from '../components/Header';
import {DeviceBadge, Illustration} from '../components/Illustration';
import type {RootStackParamList} from '../navigation/types';

// ---------------------------------------------------------------------------
// Quick actions
//
// Queued as rows in public.device_commands; the PC picks them up through
// Realtime and writes the result back, so no stream needs to be running.
// ---------------------------------------------------------------------------

type PCCommand =
  | 'lock'
  | 'beep'
  | 'screenshot'
  | 'volume_down'
  | 'volume_up'
  | 'mute'
  | 'restart'
  | 'hibernate'
  | 'shutdown';

interface CommandSpec {
  type: PCCommand;
  label: string;
  icon: AppIconName;
  /** Destructive actions ask first and use the error tone. */
  confirm?: string;
}

const COMMANDS: CommandSpec[] = [
  {type: 'lock', label: 'Lock', icon: 'lock'},
  {type: 'beep', label: 'Find me', icon: 'bell'},
  {type: 'screenshot', label: 'Screenshot', icon: 'image'},
  {type: 'volume_down', label: 'Vol –', icon: 'volume-down'},
  {type: 'volume_up', label: 'Vol +', icon: 'volume-up'},
  {type: 'mute', label: 'Mute', icon: 'volume-mute'},
  {type: 'restart', label: 'Restart', icon: 'refresh', confirm: 'restart'},
  {type: 'hibernate', label: 'Hibernate', icon: 'power', confirm: 'hibernate'},
  {type: 'shutdown', label: 'Shut down', icon: 'power', confirm: 'shut down'},
];

function formatLastSeen(lastSeen: number, now: number): string {
  if (!lastSeen) {
    return 'not connected yet';
  }
  const minutes = Math.floor((now - lastSeen) / 60000);
  if (minutes < 1) {
    return 'seen just now';
  }
  if (minutes < 60) {
    return `seen ${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `seen ${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `seen ${days} d ago`;
}

/** Re-render once a minute so relative "last seen" labels stay honest. */
function useMinuteClock() {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ---------------------------------------------------------------------------
// Device card
// ---------------------------------------------------------------------------

function QuickActionTile({
  spec,
  disabled,
  onPress,
}: {
  spec: CommandSpec;
  disabled: boolean;
  onPress: () => void;
}) {
  const {palette} = useTheme();
  const tint = spec.type === 'shutdown' ? palette.error.base : palette.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spec.label}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.tile,
        {
          backgroundColor: pressed
            ? mix(palette.textPrimary, palette.surfaceContainer, stateOpacity.pressed)
            : palette.surfaceContainer,
          opacity: disabled ? stateOpacity.disabled : 1,
        },
      ]}>
      <AppIcon name={spec.icon} color={tint} size={20} />
      <Text style={[styles.tileLabel, {color: tint}]} numberOfLines={1}>
        {spec.label}
      </Text>
    </Pressable>
  );
}

function DeviceCard({
  device,
  now,
  onConnect,
  onRename,
  onDelete,
  onCommand,
}: {
  device: DeviceInfo;
  now: number;
  onConnect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCommand: (spec: CommandSpec) => void;
}) {
  const {palette} = useTheme();
  const [actionsOpen, setActionsOpen] = React.useState(false);

  return (
    <Card padded={false} style={styles.deviceCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${device.name}, ${device.online ? 'online' : 'offline'}. Connect`}
        onPress={onConnect}
        style={({pressed}) => [
          styles.deviceRow,
          pressed && {backgroundColor: mix(palette.textPrimary, palette.surface, stateOpacity.hover)},
        ]}>
        <DeviceBadge online={device.online} size={56} />
        <View style={styles.deviceText}>
          <Text style={[styles.deviceName, {color: palette.textPrimary}]} numberOfLines={1}>
            {device.name}
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {backgroundColor: device.online ? palette.success.base : palette.textDisabled},
              ]}
            />
            <Text style={[styles.statusText, {color: palette.textSecondary}]} numberOfLines={1}>
              {device.online ? 'Online' : `Offline · ${formatLastSeen(device.lastSeen, now)}`}
            </Text>
          </View>
        </View>
        <IconButton icon="edit" accessibilityLabel={`Rename ${device.name}`} onPress={onRename} />
        <IconButton icon="delete" accessibilityLabel={`Remove ${device.name}`} onPress={onDelete} />
      </Pressable>

      <View style={[styles.deviceFooter, {borderTopColor: palette.border}]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{expanded: actionsOpen}}
          onPress={() => setActionsOpen(open => !open)}
          hitSlop={8}
          style={styles.actionsToggle}>
          <Text style={[styles.actionsToggleText, {color: palette.textSecondary}]}>
            Quick actions
          </Text>
          <AppIcon
            name={actionsOpen ? 'chevron-up' : 'chevron-down'}
            color={palette.textSecondary}
            size={18}
          />
        </Pressable>
        <PrimaryButton
          label="Connect"
          onPress={onConnect}
          disabled={!device.online}
          style={styles.connectButton}
        />
      </View>

      {actionsOpen ? (
        <View style={styles.tiles}>
          {COMMANDS.map(spec => (
            <QuickActionTile
              key={spec.type}
              spec={spec}
              disabled={!device.online}
              onPress={() => onCommand(spec)}
            />
          ))}
          {!device.online ? (
            <Text style={[styles.offlineHint, {color: palette.textTertiary}]}>
              Quick actions need the computer to be online.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet shell
// ---------------------------------------------------------------------------

function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const {palette} = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, {backgroundColor: withAlpha(palette.scrim, 0.45)}]}
          onPress={onClose}
        />
        <SafeAreaView
          edges={['bottom']}
          style={[styles.sheet, {backgroundColor: palette.surface, borderColor: palette.border}]}>
          <View style={[styles.handle, {backgroundColor: palette.borderStrong}]} />
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pairing sheet ("Add a computer")
// ---------------------------------------------------------------------------

function PairingSheet({
  visible,
  onClose,
  onPaired,
}: {
  visible: boolean;
  onClose: () => void;
  onPaired: (name: string) => void;
}) {
  const {palette} = useTheme();
  const devices = useDevicesStore(s => s.devices);
  const [code, setCode] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [ttlMs, setTtlMs] = React.useState(300000);
  const [now, setNow] = React.useState(Date.now());
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const knownIds = React.useRef<Set<string>>(new Set());

  const requestCode = React.useCallback(() => {
    setBusy(true);
    setError(null);
    setCopied(false);
    createPairingCode()
      .then(({code: next, expiresAt: until}) => {
        setCode(next);
        setExpiresAt(until);
        setTtlMs(Math.max(1000, until - Date.now()));
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Could not get an access code.');
      })
      .finally(() => setBusy(false));
  }, []);

  React.useEffect(() => {
    if (!visible) {
      setCode(null);
      setExpiresAt(null);
      setError(null);
      return;
    }
    knownIds.current = new Set(useDevicesStore.getState().devices.map(d => d.id));
    requestCode();
  }, [visible, requestCode]);

  // A device we have not seen before means the code was claimed.
  React.useEffect(() => {
    if (!visible) {
      return;
    }
    const fresh = devices.find(d => !knownIds.current.has(d.id));
    if (fresh) {
      knownIds.current.add(fresh.id);
      onPaired(fresh.name);
    }
  }, [devices, visible, onPaired]);

  React.useEffect(() => {
    if (expiresAt == null) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const remaining = expiresAt == null ? 0 : Math.max(0, Math.round((expiresAt - now) / 1000));
  const expired = expiresAt != null && remaining === 0;
  const progress = expiresAt == null ? 0 : Math.min(1, (remaining * 1000) / ttlMs);
  const digits = (code ?? '').padEnd(6, ' ').split('');

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text style={[styles.sheetTitle, {color: palette.textPrimary}]}>Add a computer</Text>
      <Text style={[styles.sheetBody, {color: palette.textSecondary}]}>
        On the computer, open Remote PC Host and enter this one-time access code.
        Only your account will be able to control it.
      </Text>

      {busy && code == null ? (
        <ActivityIndicator color={palette.primary} style={styles.sheetSpinner} />
      ) : error ? (
        <View style={[styles.errorBox, {backgroundColor: palette.error.container}]}>
          <AppIcon name="warning" color={palette.error.onContainer} size={18} />
          <Text style={[styles.errorText, {color: palette.error.onContainer}]}>{error}</Text>
        </View>
      ) : (
        <View style={styles.codeBlock}>
          <View
            accessible
            accessibilityLabel={`Access code ${(code ?? '').split('').join(' ')}`}
            style={styles.codeRow}>
            {digits.map((digit, index) => (
              <React.Fragment key={index}>
                {index === 3 ? <View style={styles.codeGap} /> : null}
                <View
                  style={[
                    styles.codeCell,
                    {
                      borderColor: expired ? palette.border : palette.borderStrong,
                      backgroundColor: palette.background,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.codeDigit,
                      {color: expired ? palette.textDisabled : palette.textPrimary},
                    ]}>
                    {digit}
                  </Text>
                </View>
              </React.Fragment>
            ))}
          </View>
          <View style={[styles.progressTrack, {backgroundColor: palette.surfaceContainerHigh}]}>
            <View
              style={[
                styles.progressFill,
                {backgroundColor: palette.accent, width: `${progress * 100}%`},
              ]}
            />
          </View>
          <Text style={[styles.expiry, {color: expired ? palette.error.base : palette.textTertiary}]}>
            {expired
              ? 'This code has expired.'
              : `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} · works once`}
          </Text>
        </View>
      )}

      <View style={styles.sheetActions}>
        <SecondaryButton
          label={copied ? 'Copied' : 'Copy code'}
          icon={copied ? 'check' : 'copy'}
          disabled={!code || expired}
          onPress={() => {
            if (code) {
              Clipboard.setString(code);
              setCopied(true);
            }
          }}
          style={styles.flex}
        />
        <SecondaryButton
          label="New code"
          icon="refresh"
          disabled={busy}
          onPress={requestCode}
          style={styles.flex}
        />
      </View>
      <SecondaryButton label="Done" variant="text" onPress={onClose} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Rename sheet
// ---------------------------------------------------------------------------

function RenameSheet({device, onClose}: {device: DeviceInfo | null; onClose: () => void}) {
  const {palette} = useTheme();
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (device) {
      setName(device.name);
      setError(null);
    }
  }, [device]);

  const save = async () => {
    if (!device) {
      return;
    }
    setBusy(true);
    try {
      await renameDevice(device.id, name.trim());
      useDevicesStore.getState().applyRename(device.id, name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the computer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={device != null} onClose={onClose}>
      <Text style={[styles.sheetTitle, {color: palette.textPrimary}]}>Rename computer</Text>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        maxLength={64}
        autoFocus
        error={error}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      <View style={styles.sheetActions}>
        <SecondaryButton label="Cancel" onPress={onClose} style={styles.flex} />
        <PrimaryButton
          label="Save"
          onPress={() => void save()}
          loading={busy}
          disabled={!name.trim() || name.trim() === device?.name}
          style={styles.flex}
        />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Screenshot viewer (image comes from the private Storage bucket)
// ---------------------------------------------------------------------------

interface ScreenshotState {
  deviceName: string;
  url: string;
  path: string;
}

function ScreenshotViewer({
  shot,
  onClose,
  onDelete,
}: {
  shot: ScreenshotState | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const {palette} = useTheme();
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => setLoading(true), [shot?.url]);
  return (
    <Modal
      visible={shot != null}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onClose}>
      <SafeAreaView style={[styles.viewer, {backgroundColor: '#000000'}]}>
        <View style={styles.viewerBar}>
          <IconButton icon="close" color="#F4F2ED" accessibilityLabel="Close screenshot" onPress={onClose} />
          <Text style={styles.viewerTitle} numberOfLines={1}>
            {shot?.deviceName}
          </Text>
          <IconButton icon="delete" color="#F4F2ED" accessibilityLabel="Delete screenshot" onPress={onDelete} />
        </View>
        <View style={styles.viewerBody}>
          {shot ? (
            <Image
              source={{uri: shot.url}}
              style={styles.viewerImage}
              resizeMode="contain"
              onLoadEnd={() => setLoading(false)}
            />
          ) : null}
          {loading ? <ActivityIndicator color={palette.accent} style={StyleSheet.absoluteFill} /> : null}
        </View>
        <Text style={styles.viewerHint}>Saved privately to your account · link valid 10 minutes</Text>
      </SafeAreaView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Signed-out welcome
// ---------------------------------------------------------------------------

function Welcome({onSignIn, onGuide}: {onSignIn: () => void; onGuide: () => void}) {
  const {palette} = useTheme();
  return (
    <>
      <Text style={[styles.hero, {color: palette.textPrimary}]}>
        Your PC, from anywhere.
      </Text>
      <Text style={[styles.heroSub, {color: palette.textSecondary}]}>
        See your screen, use the mouse and keyboard, and run quick actions —
        securely, straight from your phone.
      </Text>
      <Card padded={false} style={styles.featureCard}>
        <Illustration kind="welcome" />
        <View style={styles.featureBody}>
          <Text style={[styles.featureTitle, {color: palette.textPrimary}]}>
            Access my computer
          </Text>
          <Text style={[styles.featureText, {color: palette.textSecondary}]}>
            Sign in to see the computers you have set up.
          </Text>
          <View style={styles.featureActions}>
            <SecondaryButton label="How it works" variant="text" onPress={onGuide} />
            <PrimaryButton label="Sign in" onPress={onSignIn} />
          </View>
        </View>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type DevicesNav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicesScreen() {
  const {palette} = useTheme();
  const navigation = useNavigation<DevicesNav>();
  const devices = useDevicesStore(s => s.devices);
  const loaded = useDevicesStore(s => s.loaded);
  const loading = useDevicesStore(s => s.loading);
  const error = useDevicesStore(s => s.error);
  const link = useDevicesStore(s => s.link);
  const refresh = useDevicesStore(s => s.refresh);
  const token = useAuthStore(s => s.token);
  const email = useAuthStore(s => s.email);
  const now = useMinuteClock();
  const [pairingOpen, setPairingOpen] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<DeviceInfo | null>(null);
  const [shot, setShot] = React.useState<ScreenshotState | null>(null);
  const {toast, notify} = useToast();

  const openAccount = React.useCallback(
    () => navigation.navigate('Tabs', {screen: 'Profile'}),
    [navigation],
  );

  const sendCommand = React.useCallback(
    (device: DeviceInfo, spec: CommandSpec) => {
      const run = () => {
        if (spec.type === 'screenshot') {
          notify(`Taking a screenshot of ${device.name}…`, 'neutral');
        }
        return runDeviceCommand(
          device.id,
          spec.type,
          spec.type === 'screenshot' ? {maxWidth: 1600} : {},
        )
          .then(async result => {
            if (spec.type === 'screenshot' && typeof result.storagePath === 'string') {
              const url = await screenshotUrl(result.storagePath);
              setShot({deviceName: device.name, url, path: result.storagePath});
            } else {
              notify(`${spec.label} sent to ${device.name}`, 'success');
            }
          })
          .catch(err => {
            const message =
              err instanceof BackendError && err.code === 'device_offline'
                ? `${device.name} is offline`
                : err instanceof Error
                  ? err.message
                  : 'Could not send the command';
            notify(message, 'error' as ToastTone);
          });
      };
      if (spec.confirm) {
        Alert.alert(
          `${spec.label}?`,
          `${device.name} will ${spec.confirm} right away. Unsaved work on it may be lost.`,
          [
            {text: 'Cancel', style: 'cancel'},
            {text: spec.label, style: 'destructive', onPress: () => void run()},
          ],
        );
      } else {
        void run();
      }
    },
    [notify],
  );

  const confirmDelete = React.useCallback(
    (device: DeviceInfo) => {
      Alert.alert(
        `Remove ${device.name}?`,
        'It will disappear from your list and its host stops accepting connections until you pair it again.',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              deleteDevice(device.id)
                .then(() => {
                  useDevicesStore.getState().removeDevice(device.id);
                  notify(`${device.name} removed`, 'neutral');
                })
                .catch(err =>
                  notify(err instanceof Error ? err.message : 'Could not remove it', 'error'),
                );
            },
          },
        ],
      );
    },
    [notify],
  );

  const onPaired = React.useCallback(
    (name: string) => {
      setPairingOpen(false);
      notify(`${name} is ready`, 'success');
    },
    [notify],
  );

  const connect = (device: DeviceInfo) => {
    if (!device.online) {
      notify(`${device.name} is offline. Turn on remote access on that PC.`, 'neutral');
      return;
    }
    navigation.navigate('RemoteSession', {deviceId: device.id, deviceName: device.name});
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <AppBar email={email} onAvatarPress={openAccount} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          token ? (
            <RefreshControl
              refreshing={loading && loaded}
              onRefresh={() => void refresh()}
              tintColor={palette.primary}
              colors={[palette.primary]}
              progressBackgroundColor={palette.surface}
            />
          ) : undefined
        }>
        {!token ? (
          <Welcome onSignIn={openAccount} onGuide={() => navigation.navigate('Setup')} />
        ) : (
          <>
            {link === 'connecting' ? (
              <View style={[styles.banner, {backgroundColor: palette.surfaceContainer}]}>
                <ActivityIndicator size="small" color={palette.textSecondary} />
                <Text style={[styles.bannerText, {color: palette.textSecondary}]}>
                  Connecting…
                </Text>
                <SecondaryButton
                  label="Settings"
                  variant="text"
                  onPress={() => navigation.navigate('Tabs', {screen: 'Settings'})}
                  style={styles.bannerAction}
                />
              </View>
            ) : null}

            <SectionHeader title="Remote devices" />

            {error && loaded ? (
              <Text style={[styles.inlineError, {color: palette.error.base}]}>{error}</Text>
            ) : null}

            {!loaded ? (
              <Card style={styles.placeholder}>
                {link === 'online' ? (
                  <ActivityIndicator color={palette.textTertiary} />
                ) : null}
                <Text style={[styles.placeholderText, {color: palette.textTertiary}]}>
                  {link === 'online' ? 'Loading your computers…' : 'Your computers appear here once connected.'}
                </Text>
              </Card>
            ) : devices.length === 0 ? (
              <Card style={styles.placeholder}>
                <Text style={[styles.placeholderTitle, {color: palette.textPrimary}]}>
                  No computers yet
                </Text>
                <Text style={[styles.placeholderText, {color: palette.textSecondary}]}>
                  Set up remote access on a Windows PC to see it here.
                </Text>
              </Card>
            ) : (
              devices.map(device => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  now={now}
                  onConnect={() => connect(device)}
                  onRename={() => setRenameTarget(device)}
                  onDelete={() => confirmDelete(device)}
                  onCommand={spec => sendCommand(device, spec)}
                />
              ))
            )}

            <SectionHeader title="Add a computer" />
            <Card padded={false} style={styles.featureCard}>
              <Illustration kind="setup" />
              <View style={styles.featureBody}>
                <Text style={[styles.featureTitle, {color: palette.textPrimary}]}>
                  Set up remote access
                </Text>
                <Text style={[styles.featureText, {color: palette.textSecondary}]}>
                  Install Remote PC Host on the computer, then pair it with a
                  one-time access code from this app.
                </Text>
                <View style={styles.featureActions}>
                  <SecondaryButton
                    label="Setup guide"
                    variant="text"
                    onPress={() => navigation.navigate('Setup')}
                  />
                  <PrimaryButton
                    label="Get a code"
                    icon="add"
                    disabled={link !== 'online'}
                    onPress={() => setPairingOpen(true)}
                  />
                </View>
              </View>
            </Card>
          </>
        )}
      </ScrollView>

      <PairingSheet
        visible={pairingOpen}
        onClose={() => setPairingOpen(false)}
        onPaired={onPaired}
      />
      <RenameSheet device={renameTarget} onClose={() => setRenameTarget(null)} />
      <ScreenshotViewer
        shot={shot}
        onClose={() => setShot(null)}
        onDelete={() => {
          if (shot) {
            deleteScreenshot(shot.path)
              .then(() => notify('Screenshot deleted', 'neutral'))
              .catch(err => notify(err instanceof Error ? err.message : 'Could not delete it', 'error'));
          }
          setShot(null);
        }}
      />
      <Toast toast={toast} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  body: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.sm + 4,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  flex: {flex: 1},

  hero: {
    ...typography.headlineLarge,
    fontSize: 36,
    lineHeight: 42,
    marginTop: spacing.md,
  },
  heroSub: {
    ...typography.bodyLarge,
    marginBottom: spacing.sm,
  },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: shape.md,
    paddingLeft: spacing.md,
    minHeight: 48,
  },
  bannerText: {
    ...typography.bodyMedium,
    flex: 1,
  },
  bannerAction: {
    minHeight: 40,
  },
  inlineError: {
    ...typography.bodyMedium,
  },

  placeholder: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  placeholderTitle: {
    ...typography.titleMedium,
  },
  placeholderText: {
    ...typography.bodyMedium,
    textAlign: 'center',
  },

  deviceCard: {
    overflow: 'hidden',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.md,
  },
  deviceText: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    ...typography.titleLarge,
    fontWeight: '500',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    ...typography.bodyMedium,
    flexShrink: 1,
  },
  deviceFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
  },
  actionsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 40,
  },
  actionsToggleText: {
    ...typography.labelLarge,
    fontWeight: '600',
  },
  connectButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md + 4,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  tile: {
    width: '30%',
    flexGrow: 1,
    minWidth: 72,
    height: 76,
    borderRadius: shape.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tileLabel: {
    ...typography.labelMedium,
    fontWeight: '600',
  },
  viewer: {
    flex: 1,
  },
  viewerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  viewerTitle: {
    ...typography.titleMedium,
    color: '#F4F2ED',
    flex: 1,
  },
  viewerBody: {
    flex: 1,
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
  viewerHint: {
    ...typography.bodySmall,
    color: '#92969A',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  offlineHint: {
    ...typography.bodySmall,
    width: '100%',
  },

  featureCard: {
    overflow: 'hidden',
  },
  featureBody: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  featureTitle: {
    ...typography.headlineSmall,
  },
  featureText: {
    ...typography.bodyMedium,
  },
  featureActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },

  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: shape.xl,
    borderTopRightRadius: shape.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: spacing.sm,
  },
  sheetTitle: {
    ...typography.headlineSmall,
  },
  sheetBody: {
    ...typography.bodyMedium,
  },
  sheetSpinner: {
    marginVertical: spacing.xl,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  errorBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    borderRadius: shape.md,
    padding: spacing.md,
  },
  errorText: {
    ...typography.bodyMedium,
    flex: 1,
  },
  codeBlock: {
    gap: spacing.sm + 4,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  codeGap: {
    width: 10,
  },
  codeCell: {
    width: 44,
    height: 56,
    borderRadius: shape.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeDigit: {
    fontSize: 28,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    alignSelf: 'stretch',
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 3,
  },
  expiry: {
    ...typography.bodySmall,
  },
});
