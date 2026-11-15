import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  Vibration,
  View,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {ThemeOverride, useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography, withAlpha} from '../theme/tokens';
import {SessionClient, type SessionStatsSnapshot} from '../lib/sessionClient';
import {TransferManager, type Transfer} from '../lib/fileTransfer';
import {resolutionLabel, sizeLabel, type Size, type StreamResolution} from '../lib/resolution';
import ResolutionPicker from '../components/ResolutionPicker';
import {useSettingsStore, type VideoQuality} from '../store/settings';
import {useSessionStore, type PointerMode, type SessionPhase} from '../store/session';
import KeyboardBar from '../components/KeyboardBar';
import ClipboardSync, {type ClipboardSyncHandle} from '../components/ClipboardSync';
import TrackpadPanel from '../components/TrackpadPanel';
import RemoteSurface, {
  type RemoteCursor,
  type RemoteSurfaceHandle,
} from '../components/RemoteSurface';
import type {CursorShape} from '../components/CursorOverlay';
import IconButton from '../components/IconButton';
import PrimaryButton from '../components/PrimaryButton';
import SecondaryButton from '../components/SecondaryButton';
import Segmented from '../components/Segmented';
import PinPad from '../components/PinPad';
import AppIcon, {type AppIconName} from '../components/AppIcon';
import Toast, {useToast} from '../components/Toast';
import {DeviceBadge} from '../components/Illustration';
import type {RootStackParamList} from '../navigation/types';
import type {InputMessage, MediaKeyName, ModifierName} from '../lib/inputProtocol';

type RemoteSessionProps = NativeStackScreenProps<RootStackParamList, 'RemoteSession'>;

const QUALITY_OPTIONS: {value: VideoQuality; label: string}[] = [
  {value: 'adaptive', label: 'Auto'},
  {value: 'high', label: 'High'},
  {value: 'medium', label: 'Med'},
  {value: 'low', label: 'Low'},
];

const POINTER_OPTIONS: {value: PointerMode; label: string}[] = [
  {value: 'mouse', label: 'Mouse'},
  {value: 'touch', label: 'Touch'},
  {value: 'trackpad', label: 'Trackpad'},
];

const POINTER_ICON: Record<PointerMode, AppIconName> = {
  mouse: 'mouse',
  touch: 'touch',
  trackpad: 'tune',
};

const POINTER_HINT: Record<PointerMode, string> = {
  mouse: 'Mouse — drag the pointer, tap to click, hold then drag to drag',
  touch: 'Touch — tap where you want to click',
  trackpad: 'Trackpad — use the pad at the bottom',
};

const TOOLBAR_HIDE_MS = 3500;
/** Ignore the clipboard snapshot the agent pushes right after connecting. */
const CLIPBOARD_GRACE_MS = 2500;
const PIN_KEY = (deviceId: string) => `app.pin.${deviceId}`;
const SHAPES = new Set<CursorShape>([
  'arrow', 'ibeam', 'hand', 'wait', 'progress', 'cross', 'size-ns', 'size-we',
  'size-nwse', 'size-nesw', 'size-all', 'no',
]);

const END_REASONS: Record<string, string> = {
  ended_by_peer: 'The other side ended the session.',
  peer_closed: 'The connection was closed.',
  device_disconnected: 'The computer went offline.',
  device_deleted: 'This computer was removed from your account.',
  relay_disconnected: 'Your connection dropped.',
  capture_unavailable: 'Screen sharing isn’t available on that computer.',
  rejected: 'The request was declined on the other computer.',
  pin_failed: 'Too many wrong PIN attempts.',
  stopped_sharing: 'The other person stopped sharing their screen.',
  expired: 'The support session expired.',
};

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function StatsOverlay() {
  const {palette} = useTheme();
  const stats = useSessionStore(s => s.stats);
  const items: [string, string][] = [
    ['RTT', stats.rttMs != null ? `${stats.rttMs} ms` : '–'],
    ['FPS', stats.fps != null ? String(stats.fps) : '–'],
    ['Rate', stats.bitrateKbps != null ? `${stats.bitrateKbps} kbps` : '–'],
    ['Size', stats.width && stats.height ? `${stats.width}×${stats.height}` : '–'],
    ['Route', stats.route ?? '–'],
  ];
  return (
    <View
      pointerEvents="none"
      style={[styles.stats, {backgroundColor: withAlpha(palette.background, 0.82), borderColor: palette.border}]}>
      {items.map(([label, value]) => (
        <View key={label} style={styles.statItem}>
          <Text style={[styles.statLabel, {color: palette.textTertiary}]}>{label}</Text>
          <Text style={[styles.statValue, {color: palette.textPrimary}]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function PhaseOverlay({
  deviceName,
  support,
  onClose,
  onRetry,
}: {
  deviceName: string;
  support: boolean;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const {palette} = useTheme();
  const phase = useSessionStore(s => s.phase);
  const error = useSessionStore(s => s.error);
  const endReason = useSessionStore(s => s.endReason);
  if (phase === 'connected' || phase === 'idle') {
    return null;
  }
  const settled = phase === 'ended' || phase === 'failed';
  const steps: SessionPhase[] = ['starting', 'waiting', 'signaling'];
  const stepIndex = steps.indexOf(phase);
  const title = settled
    ? phase === 'failed'
      ? 'Couldn’t connect'
      : 'Session ended'
    : support
      ? 'Waiting for approval'
      : `Connecting to ${deviceName}`;
  const detail = settled
    ? (phase === 'failed' ? error : endReason && END_REASONS[endReason]) ??
      (phase === 'failed' ? 'Something went wrong.' : 'The remote session is closed.')
    : phase === 'starting'
      ? 'Reaching the server…'
      : phase === 'waiting'
        ? support
          ? `Ask the person at ${deviceName} to click Allow.`
          : 'Waiting for the computer to answer…'
        : 'Setting up a secure peer-to-peer link…';

  return (
    <View style={styles.phaseOverlay}>
      <View style={[styles.phaseCard, {backgroundColor: palette.surface, borderColor: palette.border}]}>
        <DeviceBadge online={!settled} size={64} />
        <Text style={[styles.phaseTitle, {color: palette.textPrimary}]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.phaseText, {color: palette.textSecondary}]}>{detail}</Text>
        {!settled ? (
          <>
            <View style={styles.phaseSteps}>
              {steps.map((step, index) => (
                <View
                  key={step}
                  style={[
                    styles.phaseStep,
                    {backgroundColor: index <= stepIndex ? palette.accent : palette.surfaceContainerHigh},
                  ]}
                />
              ))}
            </View>
            <SecondaryButton label="Cancel" variant="text" onPress={onClose} />
          </>
        ) : (
          <View style={styles.phaseActions}>
            <SecondaryButton label="Close" onPress={onClose} style={styles.flex} />
            {onRetry ? <PrimaryButton label="Reconnect" onPress={onRetry} style={styles.flex} /> : null}
          </View>
        )}
      </View>
    </View>
  );
}

function MenuAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: AppIconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const {palette} = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.menuAction,
        {
          backgroundColor: pressed
            ? mix(palette.textPrimary, palette.surfaceContainer, stateOpacity.pressed)
            : palette.surfaceContainer,
          opacity: disabled ? stateOpacity.disabled : 1,
        },
      ]}>
      <AppIcon name={icon} color={palette.textPrimary} size={20} />
      <Text style={[styles.menuActionLabel, {color: palette.textSecondary}]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function MenuToggle({
  icon,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  icon: AppIconName;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const {palette} = useTheme();
  return (
    <View style={[styles.menuToggle, disabled && {opacity: stateOpacity.disabled}]}>
      <AppIcon name={icon} color={palette.textSecondary} size={20} />
      <View style={styles.flex}>
        <Text style={[styles.menuToggleLabel, {color: palette.textPrimary}]}>{label}</Text>
        {hint ? <Text style={[styles.menuHint, {color: palette.textTertiary}]}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{false: palette.surfaceContainerHighest, true: palette.primary}}
        thumbColor={palette.textPrimary}
      />
    </View>
  );
}

function Sheet({visible, onClose, children}: {visible: boolean; onClose: () => void; children: React.ReactNode}) {
  const {palette} = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, {backgroundColor: withAlpha(palette.scrim, 0.4)}]}
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

/** Remote Access PIN prompt (checked by the PC itself). */
function PinSheet({
  visible,
  deviceName,
  error,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  deviceName: string;
  error: string | null;
  onSubmit: (pin: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  const {palette} = useTheme();
  const [pin, setPin] = React.useState('');
  const [remember, setRemember] = React.useState(false);
  React.useEffect(() => {
    if (visible) {
      setPin('');
    }
  }, [visible, error]);
  return (
    <Sheet visible={visible} onClose={onCancel}>
      <View style={styles.sheetBody}>
        <Text style={[styles.sheetTitle, {color: palette.textPrimary}]}>Enter PIN</Text>
        <Text style={[styles.sheetText, {color: palette.textSecondary}]}>
          The PIN you chose when you set up remote access on {deviceName}.
        </Text>
        <View style={styles.pinDots}>
          {Array.from({length: Math.max(6, pin.length)}, (_, i) => (
            <View
              key={i}
              style={[
                styles.pinDot,
                {
                  backgroundColor: i < pin.length ? palette.textPrimary : 'transparent',
                  borderColor: error ? palette.error.base : palette.borderStrong,
                },
              ]}
            />
          ))}
        </View>
        {error ? <Text style={[styles.sheetError, {color: palette.error.base}]}>{error}</Text> : null}
        <PinPad value={pin} onChange={setPin} length={12} />
        <View style={styles.menuToggle}>
          <AppIcon name="lock" color={palette.textSecondary} size={20} />
          <Text style={[styles.menuToggleLabel, {color: palette.textPrimary}]}>Remember on this phone</Text>
          <Switch
            accessibilityLabel="Remember PIN on this phone"
            value={remember}
            onValueChange={setRemember}
            trackColor={{false: palette.surfaceContainerHighest, true: palette.primary}}
            thumbColor={palette.textPrimary}
          />
        </View>
        <View style={styles.phaseActions}>
          <SecondaryButton label="Cancel" onPress={onCancel} style={styles.flex} />
          <PrimaryButton
            label="Unlock"
            disabled={pin.length < 6}
            onPress={() => onSubmit(pin, remember)}
            style={styles.flex}
          />
        </View>
      </View>
    </Sheet>
  );
}

function formatBytes(n: number) {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function TransfersSheet({
  visible,
  transfers,
  onClose,
  onCancel,
  onSend,
  onGet,
  disabled,
}: {
  visible: boolean;
  transfers: Transfer[];
  onClose: () => void;
  onCancel: (id: string) => void;
  onSend: () => void;
  onGet: () => void;
  disabled: boolean;
}) {
  const {palette} = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.sheetBody}>
        <Text style={[styles.sheetTitle, {color: palette.textPrimary}]}>Files</Text>
        <Text style={[styles.sheetText, {color: palette.textSecondary}]}>
          Files travel directly between your phone and the computer, encrypted. Sent files land in
          the PC’s Downloads › Remote PC folder; received files in your phone’s Downloads › Remote PC.
        </Text>
        <View style={styles.phaseActions}>
          <SecondaryButton label="Send a file" icon="add" onPress={onSend} disabled={disabled} style={styles.flex} />
          <PrimaryButton label="Get from PC" icon="computer" onPress={onGet} disabled={disabled} style={styles.flex} />
        </View>
        {transfers.length === 0 ? (
          <Text style={[styles.menuHint, {color: palette.textTertiary}]}>No transfers yet.</Text>
        ) : (
          transfers.map(t => {
            const pct = t.size > 0 ? Math.min(1, t.done / t.size) : t.status === 'done' ? 1 : 0;
            const active = t.status === 'sending' || t.status === 'receiving' || t.status === 'waiting';
            return (
              <View key={t.id} style={[styles.transfer, {borderColor: palette.border}]}>
                <AppIcon
                  name={t.direction === 'upload' ? 'chevron-up' : 'chevron-down'}
                  color={palette.textSecondary}
                  size={20}
                />
                <View style={styles.flex}>
                  <Text style={[styles.menuToggleLabel, {color: palette.textPrimary}]} numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text style={[styles.menuHint, {color: t.status === 'failed' ? palette.error.base : palette.textTertiary}]} numberOfLines={1}>
                    {t.status === 'done'
                      ? `Saved${t.message ? ` · ${t.message}` : ''}`
                      : t.status === 'failed'
                        ? t.message ?? 'Failed'
                        : t.status === 'cancelled'
                          ? 'Cancelled'
                          : `${formatBytes(t.done)} of ${formatBytes(t.size)}`}
                  </Text>
                  <View style={[styles.progressTrack, {backgroundColor: palette.surfaceContainerHigh}]}>
                    <View style={[styles.progressFill, {width: `${pct * 100}%`, backgroundColor: palette.accent}]} />
                  </View>
                </View>
                {active ? (
                  <IconButton icon="close" accessibilityLabel={`Cancel ${t.name}`} onPress={() => onCancel(t.id)} />
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function RemoteSession({route, navigation}: RemoteSessionProps) {
  const {palette} = useTheme();
  const {deviceId, supportSessionId} = route.params;
  const support = Boolean(supportSessionId);
  const viewOnly = support && route.params.mode === 'view';
  const deviceName = route.params.deviceName ?? (support ? 'Shared screen' : 'Remote PC');
  const sessionKey = supportSessionId ?? deviceId ?? '';

  const phase = useSessionStore(s => s.phase);
  const pointerMode = useSessionStore(s => s.pointerMode);
  const keyboardOpen = useSessionStore(s => s.keyboardOpen);
  const statsVisible = useSessionStore(s => s.statsVisible);
  const quality = useSessionStore(s => s.quality);
  const remoteClipboard = useSessionStore(s => s.remoteClipboard);
  const rtt = useSessionStore(s => s.stats.rttMs);
  const routeKind = useSessionStore(s => s.stats.route);
  const statsWidth = useSessionStore(s => s.stats.width);
  const statsHeight = useSessionStore(s => s.stats.height);
  const settings = useSettingsStore();

  const [attempt, setAttempt] = React.useState(0);
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null);
  const [channelOpen, setChannelOpen] = React.useState(false);
  const [toolbarVisible, setToolbarVisible] = React.useState(true);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [resolutionOpen, setResolutionOpen] = React.useState(false);
  const [resolution, setResolutionState] = React.useState<StreamResolution>(() => useSettingsStore.getState().resolution);
  const [pcScreen, setPcScreen] = React.useState<Size | null>(null);
  const [streamSize, setStreamSize] = React.useState<Size | null>(null);
  // Follow the phone's rotation: in landscape the PC screen fills the display.
  const [rotationLocked, setRotationLocked] = React.useState(false);
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const [fullscreen, setFullscreen] = React.useState(false);
  const [jpegFrame, setJpegFrame] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<RemoteCursor | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [pinPrompt, setPinPrompt] = React.useState<{error: string | null} | null>(null);
  const [locked, setLocked] = React.useState(false);
  const [audio, setAudio] = React.useState({available: false, on: settings.computerSound});
  const [curtain, setCurtain] = React.useState({available: false, on: false});
  const [transfers, setTransfers] = React.useState<Transfer[]>([]);
  const {toast, notify} = useToast();

  const clientRef = React.useRef<SessionClient | null>(null);
  const transfersRef = React.useRef<TransferManager | null>(null);
  const surfaceRef = React.useRef<RemoteSurfaceHandle>(null);
  const clipboardRef = React.useRef<ClipboardSyncHandle>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedAt = React.useRef(0);
  const pinRemember = React.useRef(false);
  const pinPending = React.useRef<string | null>(null);
  const triedSavedPin = React.useRef(false);

  const haptic = React.useCallback(() => {
    if (useSettingsStore.getState().haptics) {
      Vibration.vibrate(8);
    }
  }, []);

  const send = React.useCallback((message: InputMessage) => {
    clientRef.current?.sendInput(message);
  }, []);

  const pingToolbar = React.useCallback(() => {
    setToolbarVisible(true);
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
    }
    hideTimer.current = setTimeout(() => setToolbarVisible(false), TOOLBAR_HIDE_MS);
  }, []);

  const disconnect = React.useCallback(() => {
    transfersRef.current?.closeAll();
    clientRef.current?.end();
    clientRef.current = null;
    navigation.goBack();
  }, [navigation]);

  const submitPin = React.useCallback(
    (pin: string, remember: boolean) => {
      pinRemember.current = remember;
      pinPending.current = pin;
      setPinPrompt(null);
      send({t: 'auth.pin', pin});
    },
    [send],
  );

  /** Messages from the agent beyond video/cursor/clipboard. */
  const onControl = React.useCallback(
    (message: Record<string, unknown>) => {
      switch (message.t) {
        case 'auth.required': {
          setLocked(true);
          if (!deviceId) {
            return;
          }
          // Try a remembered PIN once, silently.
          if (!triedSavedPin.current) {
            triedSavedPin.current = true;
            AsyncStorage.getItem(PIN_KEY(deviceId))
              .then(saved => {
                if (saved) {
                  pinPending.current = saved;
                  pinRemember.current = true;
                  send({t: 'auth.pin', pin: saved});
                } else {
                  setPinPrompt({error: null});
                }
              })
              .catch(() => setPinPrompt({error: null}));
          } else {
            setPinPrompt({error: null});
          }
          return;
        }
        case 'auth.ok':
          setLocked(false);
          setPinPrompt(null);
          if (deviceId && pinPending.current) {
            if (pinRemember.current) {
              AsyncStorage.setItem(PIN_KEY(deviceId), pinPending.current).catch(() => {});
            }
          }
          pinPending.current = null;
          // Now that the stream is unlocked, apply the session preferences.
          send({t: 'audio.set', on: useSettingsStore.getState().computerSound});
          return;
        case 'auth.failed': {
          if (deviceId) {
            AsyncStorage.removeItem(PIN_KEY(deviceId)).catch(() => {});
          }
          const left = Number(message.attemptsLeft);
          setPinPrompt({
            error: Number.isFinite(left)
              ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`
              : 'Wrong PIN.',
          });
          return;
        }
        case 'audio.state':
          setAudio({available: message.available === true, on: message.on === true});
          return;
        case 'quality.ack': {
          const screen = message.screen as Size | null | undefined;
          const size = message.size as Size | null | undefined;
          if (screen?.width && screen?.height) {
            setPcScreen({width: screen.width, height: screen.height});
          }
          if (size?.width && size?.height) {
            setStreamSize({width: size.width, height: size.height});
          }
          return;
        }
        case 'curtain.state':
          setCurtain({available: message.available === true, on: message.on === true});
          if (typeof message.error === 'string') {
            notify(message.error, 'error');
          }
          return;
        case 'file.picking':
          notify('Choose the file in the window that opened on the computer', 'neutral');
          return;
        case 'file.none':
          notify('No file was chosen on the computer', 'neutral');
          return;
        case 'error':
          if (typeof message.message === 'string') {
            notify(message.message, 'error');
          }
          return;
      }
    },
    [deviceId, notify, send],
  );

  // Session lifecycle (re-runs on "Reconnect").
  React.useEffect(() => {
    const store = useSessionStore.getState();
    const prefs = useSettingsStore.getState();
    store.begin(sessionKey, deviceName);
    if (attempt === 0) {
      store.setQuality(prefs.defaultQuality);
      store.setPointerMode(prefs.pointerMode);
    }
    setStreamUrl(null);
    setJpegFrame(null);
    setChannelOpen(false);
    setCursor(null);
    setLocked(false);
    triedSavedPin.current = false;

    const client = new SessionClient(
      {
        onPhase: (nextPhase, error) => {
          const s = useSessionStore.getState();
          if (nextPhase === 'failed') {
            s.setPhase('failed', error);
            s.setEndReason(error ?? 'failed');
          } else if (nextPhase === 'ended') {
            s.setEndReason(error ?? 'ended');
            s.setPhase('ended');
            setPinPrompt(null);
          } else {
            s.setPhase(nextPhase);
          }
        },
        onStream: url => setStreamUrl(url),
        onStats: (stats: SessionStatsSnapshot) => useSessionStore.getState().setStats(stats),
        onDataChannelOpen: () => {
          connectedAt.current = Date.now();
          setChannelOpen(true);
          client.sendInput({t: 'audio.set', on: useSettingsStore.getState().computerSound});
        },
        onRemoteClipboard: text => {
          if (Date.now() - connectedAt.current < CLIPBOARD_GRACE_MS) {
            return;
          }
          useSessionStore.getState().setRemoteClipboard(text);
        },
        onJpegFrame: dataUrl => setJpegFrame(dataUrl),
        onCursor: c =>
          setCursor({
            x: c.x,
            y: c.y,
            visible: c.visible,
            shape: SHAPES.has(c.shape as CursorShape) ? (c.shape as CursorShape) : 'arrow',
          }),
        onControl,
        onPeerChannel: channel => transfersRef.current?.acceptIncoming(channel),
      },
      support ? 'support' : 'access',
    );
    clientRef.current = client;
    // Stream resolution chosen in Settings (or earlier in this session).
    client.setResolution(resolutionRef.current);

    const manager = new TransferManager(
      label => client.createChannel(label),
      (_t, location) => notify(`Saved to ${location}`, 'success'),
    );
    transfersRef.current = manager;
    const offTransfers = manager.subscribe(setTransfers);

    const starting = supportSessionId
      ? client.attach(supportSessionId, useSessionStore.getState().quality)
      : client.start(deviceId!, useSessionStore.getState().quality);
    starting
      .then(() => client.startStatsPolling())
      .catch(error => {
        useSessionStore
          .getState()
          .setPhase('failed', error instanceof Error ? error.message : 'Session failed');
      });

    pingToolbar();

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
      offTransfers();
      manager.closeAll();
      client.end();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
    // Only a new target or an explicit "Reconnect" restarts the session.
  }, [sessionKey, attempt]);

  // Leaving the screen resets the shared session store.
  React.useEffect(() => () => useSessionStore.getState().reset(), []);

  // Fullscreen hides the status bar.
  // Landscape also hides it, so the PC screen uses the whole display.
  React.useEffect(() => {
    StatusBar.setHidden(fullscreen || landscape, 'fade');
    return () => StatusBar.setHidden(false, 'fade');
  }, [fullscreen, landscape]);

  // Rotation lock: native-stack screens accept an `orientation` option.
  React.useEffect(() => {
    navigation.setOptions({orientation: rotationLocked ? 'portrait' : 'all'});
  }, [navigation, rotationLocked]);

  const resolutionRef = React.useRef(resolution);
  resolutionRef.current = resolution;
  const changeResolution = (next: StreamResolution) => {
    setResolutionState(next);
    clientRef.current?.setResolution(next);
    setResolutionOpen(false);
  };

  const setQuality = (next: VideoQuality) => {
    useSessionStore.getState().setQuality(next);
    clientRef.current?.setQuality(next);
  };

  const setPointerMode = (next: PointerMode) => {
    haptic();
    useSessionStore.getState().setPointerMode(next);
    notify(POINTER_HINT[next], 'neutral');
    pingToolbar();
  };

  const cyclePointerMode = () => {
    const order: PointerMode[] = ['mouse', 'touch', 'trackpad'];
    setPointerMode(order[(order.indexOf(pointerMode) + 1) % order.length]);
  };

  const sendKey = React.useCallback(
    (code: string, modifiers: ModifierName[]) => {
      haptic();
      send({t: 'key', code, down: true, modifiers});
      send({t: 'key', code, down: false, modifiers});
    },
    [haptic, send],
  );

  const sendText = React.useCallback((text: string) => send({t: 'text', text}), [send]);

  const pushClipboard = React.useCallback(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    Clipboard.getString()
      .then(text => {
        if (text) {
          client.pushLocalClipboard(text);
          notify('Clipboard sent to the computer', 'success');
        } else {
          notify('Your phone clipboard is empty', 'neutral');
        }
      })
      .catch(() => notify('Clipboard access was denied', 'error'));
  }, [notify]);

  const sendFile = React.useCallback(() => {
    transfersRef.current
      ?.pickAndSend()
      .catch(err => {
        const message = err instanceof Error ? err.message : '';
        if (!/cancel/i.test(message)) {
          notify(message || 'Could not send the file', 'error');
        }
      });
  }, [notify]);

  const connected = phase === 'connected';
  const interactive = connected && !locked && !viewOnly;
  const showToolbar = !fullscreen && (!connected || toolbarVisible || menuOpen);
  const videoSize = statsWidth && statsHeight ? {width: statsWidth, height: statsHeight} : null;

  const statusText = connected
    ? [
        locked ? 'Locked' : viewOnly ? 'View only' : 'Connected',
        rtt != null ? `${rtt} ms` : null,
        routeKind === 'relayed' ? 'Relayed' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : phase === 'ended' || phase === 'failed'
      ? 'Disconnected'
      : 'Connecting…';

  return (
    <View style={[styles.root, {backgroundColor: '#000000'}]}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <RemoteSurface
        ref={surfaceRef}
        streamUrl={locked ? null : streamUrl}
        jpegFrame={locked ? null : jpegFrame}
        videoSize={videoSize}
        mode={interactive ? pointerMode : 'view'}
        remoteCursor={cursor}
        pointerSize={settings.pointerSize}
        pointerColor={settings.pointerColor}
        pointerSpeed={settings.pointerSpeed}
        send={send}
        haptic={haptic}
        onSurfaceTap={pingToolbar}
        onZoomChange={setZoom}>
        {statsVisible && connected ? <StatsOverlay /> : null}
      </RemoteSurface>

      <PhaseOverlay
        deviceName={deviceName}
        support={support}
        onClose={disconnect}
        onRetry={support ? undefined : () => setAttempt(n => n + 1)}
      />

      {/* Auto-hiding top bar */}
      {showToolbar ? (
        <SafeAreaView edges={['top']} style={styles.topBarAnchor} pointerEvents="box-none">
          <View
            style={[
              styles.topBar,
              {backgroundColor: withAlpha(palette.surface, 0.94), borderColor: palette.border},
            ]}>
            <IconButton
              icon="close"
              color={palette.textPrimary}
              accessibilityLabel="Disconnect"
              onPress={disconnect}
            />
            <View style={styles.titleCol}>
              <Text style={[styles.title, {color: palette.textPrimary}]} numberOfLines={1}>
                {deviceName}
              </Text>
              <View style={styles.subtitleRow}>
                {connected ? (
                  <AppIcon name="lock" color={palette.success.base} size={12} />
                ) : (
                  <View style={[styles.liveDot, {backgroundColor: palette.accent}]} />
                )}
                <Text
                  style={[styles.subtitle, {color: palette.textSecondary}]}
                  numberOfLines={1}
                  accessibilityLabel={connected ? `${statusText}. End-to-end encrypted.` : statusText}>
                  {statusText}
                </Text>
              </View>
            </View>
            {interactive ? (
              <>
                <IconButton
                  icon="keyboard"
                  active={keyboardOpen}
                  color={palette.textPrimary}
                  accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
                  onPress={() => {
                    haptic();
                    useSessionStore.getState().setKeyboardOpen(!keyboardOpen);
                  }}
                />
                <IconButton
                  icon={POINTER_ICON[pointerMode]}
                  color={palette.textPrimary}
                  accessibilityLabel={`Pointer: ${pointerMode}. Switch mode`}
                  onPress={cyclePointerMode}
                />
              </>
            ) : null}
            {connected ? (
              <IconButton
                icon="settings"
                color={palette.textPrimary}
                accessibilityLabel="Session menu"
                onPress={() => setMenuOpen(true)}
              />
            ) : null}
          </View>
        </SafeAreaView>
      ) : null}

      {/* When the bar is hidden: a small handle to bring it back. */}
      {connected && !showToolbar && !fullscreen ? (
        <SafeAreaView edges={['top']} style={styles.handleAnchor} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show session controls"
            onPress={pingToolbar}
            hitSlop={10}
            style={[styles.barHandle, {backgroundColor: withAlpha(palette.surface, 0.75), borderColor: palette.border}]}>
            <AppIcon name="chevron-down" color={palette.textPrimary} size={18} />
          </Pressable>
        </SafeAreaView>
      ) : null}

      {zoom > 1.01 && connected ? (
        <SafeAreaView edges={['top']} style={styles.fitAnchor} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            onPress={() => surfaceRef.current?.resetZoom()}
            style={[styles.fitPill, {backgroundColor: withAlpha(palette.surface, 0.85), borderColor: palette.border}]}>
            <AppIcon name="fullscreen-exit" color={palette.textPrimary} size={16} />
            <Text style={[styles.fitText, {color: palette.textPrimary}]}>
              {`${zoom.toFixed(1)}× · Fit screen`}
            </Text>
          </Pressable>
        </SafeAreaView>
      ) : null}

      {fullscreen ? (
        <SafeAreaView edges={['top']} style={styles.exitFullscreen} pointerEvents="box-none">
          <IconButton
            icon="fullscreen-exit"
            color={palette.textPrimary}
            accessibilityLabel="Exit full screen"
            onPress={() => setFullscreen(false)}
            style={{backgroundColor: withAlpha(palette.surface, 0.7)}}
          />
        </SafeAreaView>
      ) : null}

      {/* Bottom input surfaces */}
      {interactive ? (
        // Edge-to-edge Android ignores adjustResize, so lift the panel by the
        // measured keyboard overlap (works on resizing windows too).
        <KeyboardAvoidingView behavior="padding" style={styles.bottom} pointerEvents="box-none">
          <SafeAreaView edges={['bottom']} pointerEvents="box-none">
            {keyboardOpen ? (
              <KeyboardBar
                onText={sendText}
                onKey={sendKey}
                onCtrlAltDel={() => send({t: 'input.ctrlaltdel'})}
                onClose={() => useSessionStore.getState().setKeyboardOpen(false)}
              />
            ) : pointerMode === 'trackpad' && !fullscreen ? (
              <TrackpadPanel send={send} haptic={haptic} />
            ) : null}
          </SafeAreaView>
        </KeyboardAvoidingView>
      ) : null}

      <ClipboardSync
        ref={clipboardRef}
        send={send}
        connected={channelOpen && !viewOnly}
        remoteText={remoteClipboard}
        onDismissRemote={() => useSessionStore.getState().setRemoteClipboard(null)}
      />

      {/* Session menu */}
      <Sheet visible={menuOpen} onClose={() => { setMenuOpen(false); pingToolbar(); }}>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          {interactive ? (
            <>
              <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Pointer</Text>
              <Segmented options={POINTER_OPTIONS} value={pointerMode} onChange={setPointerMode} />
            </>
          ) : null}

          <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Quality</Text>
          <Segmented options={QUALITY_OPTIONS} value={quality} onChange={setQuality} />

          <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Resolution</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => { setMenuOpen(false); setResolutionOpen(true); }}
            style={({pressed}) => [styles.resRow, {borderColor: palette.border}, pressed && {opacity: 0.8}]}>
            <View style={styles.flex}>
              <Text style={[styles.resTitle, {color: palette.textPrimary}]}>{resolutionLabel(resolution)}</Text>
              <Text style={[styles.resSub, {color: palette.textSecondary}]}>
                {streamSize ? `Receiving ${sizeLabel(streamSize)}` : 'Size of the PC picture'}
                {pcScreen ? ` · PC ${sizeLabel(pcScreen)}` : ''}
              </Text>
            </View>
            <AppIcon name="chevron-right" color={palette.textSecondary} size={20} />
          </Pressable>

          <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Actions</Text>
          <View style={styles.menuGrid}>
            <MenuAction icon="clipboard" label="Send clipboard" disabled={!interactive}
              onPress={() => { setMenuOpen(false); pushClipboard(); }} />
            <MenuAction icon="copy" label="Get clipboard" disabled={!interactive}
              onPress={() => { setMenuOpen(false); connectedAt.current = 0; clipboardRef.current?.pullRemote(); }} />
            <MenuAction icon="share" label="Files" disabled={!interactive}
              onPress={() => { setMenuOpen(false); setFilesOpen(true); }} />
            <MenuAction icon="fullscreen" label="Full screen"
              onPress={() => { setMenuOpen(false); setFullscreen(true); }} />
            <MenuAction icon="lock" label="Ctrl+Alt+Del" disabled={!interactive}
              onPress={() => { setMenuOpen(false); send({t: 'input.ctrlaltdel'}); }} />
            {(['volume_down', 'volume_up', 'volume_mute', 'play_pause'] as MediaKeyName[]).map(key => (
              <MenuAction
                key={key}
                disabled={!interactive}
                icon={key === 'volume_down' ? 'volume-down' : key === 'volume_up' ? 'volume-up' : key === 'volume_mute' ? 'volume-mute' : 'chevron-right'}
                label={key === 'volume_down' ? 'Volume –' : key === 'volume_up' ? 'Volume +' : key === 'volume_mute' ? 'Mute PC' : 'Play/Pause'}
                onPress={() => { haptic(); send({t: 'input.media', key}); }}
              />
            ))}
          </View>

          <View style={[styles.menuToggles, {borderColor: palette.border}]}>
            <MenuToggle
              icon="volume-up"
              label="Computer sound"
              hint={audio.available ? 'Hear the PC on this phone' : 'Not available on this computer'}
              value={audio.on}
              disabled={!audio.available}
              onChange={on => {
                setAudio(a => ({...a, on}));
                send({t: 'audio.set', on});
              }}
            />
            {!support ? (
              <MenuToggle
                icon="shield"
                label="Curtain mode"
                hint={curtain.available
                  ? 'Black out the PC’s own screen while you work'
                  : 'Needs Windows 10 (2004) or later'}
                value={curtain.on}
                disabled={!curtain.available || !interactive}
                onChange={on => {
                  setCurtain(c => ({...c, on}));
                  send({t: 'curtain.set', on});
                }}
              />
            ) : null}
            <MenuToggle icon="stats" label="Connection stats" value={statsVisible}
              onChange={v => useSessionStore.getState().setStatsVisible(v)} />
            <MenuToggle icon="rotate" label="Lock to portrait" value={rotationLocked} onChange={setRotationLocked} />
          </View>

          <View style={styles.encrypted}>
            <AppIcon name="shield" color={palette.success.base} size={16} />
            <Text style={[styles.menuHint, {color: palette.textSecondary}]}>
              {`End-to-end encrypted (DTLS-SRTP) · ${routeKind === 'relayed' ? 'relayed through TURN' : 'direct peer-to-peer'}`}
            </Text>
          </View>

          <PrimaryButton label={support ? 'Leave session' : 'Disconnect'} icon="close" tone="error"
            onPress={() => { setMenuOpen(false); disconnect(); }} />
        </ScrollView>
      </Sheet>

      <Sheet visible={resolutionOpen} onClose={() => { setResolutionOpen(false); pingToolbar(); }}>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Stream resolution</Text>
          <ResolutionPicker value={resolution} onChange={changeResolution} native={pcScreen} />
        </ScrollView>
      </Sheet>

      <TransfersSheet
        visible={filesOpen}
        transfers={transfers}
        disabled={!interactive}
        onClose={() => setFilesOpen(false)}
        onCancel={id => transfersRef.current?.cancel(id)}
        onSend={sendFile}
        onGet={() => {
          send({t: 'file.request'});
          setFilesOpen(false);
          notify('Choose a file on the computer…', 'neutral');
        }}
      />

      <PinSheet
        visible={pinPrompt != null && connected}
        deviceName={deviceName}
        error={pinPrompt?.error ?? null}
        onSubmit={submitPin}
        onCancel={disconnect}
      />

      <Toast toast={toast} bottom={keyboardOpen ? 140 : pointerMode === 'trackpad' ? 240 : 48} />
    </View>
  );
}

/** The session viewer is always dark, whatever the app theme. */
export default function RemoteSessionScreen(props: RemoteSessionProps) {
  return (
    <ThemeOverride mode="dark">
      <RemoteSession {...props} />
    </ThemeOverride>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  flex: {flex: 1},
  resRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: shape.md, padding: spacing.md},
  resTitle: {...typography.bodyLarge, fontWeight: '600'},
  resSub: {...typography.bodySmall},
  topBarAnchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: shape.lg + 4,
    borderWidth: StyleSheet.hairlineWidth * 2,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  titleCol: {flex: 1, paddingHorizontal: spacing.xs},
  title: {...typography.titleMedium},
  subtitleRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  liveDot: {width: 7, height: 7, borderRadius: 4},
  subtitle: {...typography.bodySmall, flexShrink: 1},
  handleAnchor: {position: 'absolute', top: 0, right: spacing.md},
  barHandle: {
    marginTop: spacing.sm,
    width: 40,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fitAnchor: {position: 'absolute', top: 64, left: 0, right: 0, alignItems: 'center'},
  fitPill: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: shape.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  fitText: {...typography.labelLarge, fontWeight: '600'},
  exitFullscreen: {position: 'absolute', right: spacing.sm, top: spacing.sm},
  bottom: {position: 'absolute', left: 0, right: 0, bottom: 0},
  stats: {
    position: 'absolute',
    top: 96,
    left: spacing.md,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    borderRadius: shape.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  statItem: {gap: 1},
  statLabel: {...typography.labelSmall},
  statValue: {...typography.labelLarge, fontVariant: ['tabular-nums']},
  phaseOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  phaseCard: {
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    gap: spacing.sm + 4,
    padding: spacing.lg,
    borderRadius: shape.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  phaseTitle: {...typography.headlineSmall, textAlign: 'center'},
  phaseText: {...typography.bodyMedium, textAlign: 'center'},
  phaseSteps: {flexDirection: 'row', gap: 6, marginTop: spacing.xs},
  phaseStep: {width: 28, height: 4, borderRadius: 2},
  phaseActions: {flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch', marginTop: spacing.xs},
  sheetRoot: {flex: 1, justifyContent: 'flex-end'},
  sheet: {
    borderTopLeftRadius: shape.xl,
    borderTopRightRadius: shape.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: 0,
    maxHeight: '88%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  sheetBody: {paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm + 4},
  sheetTitle: {...typography.headlineSmall},
  sheetText: {...typography.bodyMedium},
  sheetError: {...typography.bodyMedium, textAlign: 'center'},
  handle: {alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginVertical: spacing.sm},
  menuSection: {...typography.titleSmall, fontWeight: '600', marginTop: spacing.xs},
  menuGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  menuAction: {
    width: '22.5%',
    flexGrow: 1,
    minWidth: 72,
    paddingVertical: spacing.sm + 4,
    borderRadius: shape.md,
    alignItems: 'center',
    gap: 6,
  },
  menuActionLabel: {...typography.labelSmall, fontWeight: '600'},
  menuToggles: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    paddingVertical: spacing.xs,
  },
  menuToggle: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56},
  menuToggleLabel: {...typography.bodyLarge},
  menuHint: {...typography.bodySmall},
  encrypted: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  pinDots: {flexDirection: 'row', justifyContent: 'center', gap: 10, marginVertical: spacing.sm},
  pinDot: {width: 14, height: 14, borderRadius: 7, borderWidth: 2},
  transfer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  progressTrack: {height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 6},
  progressFill: {height: 3},
});
