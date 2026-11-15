import React from 'react';
import {
  Image,
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
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {ThemeOverride, useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography, withAlpha} from '../theme/tokens';
import {SessionClient, RTCView, type SessionStatsSnapshot} from '../lib/sessionClient';
import {useSettingsStore, type VideoQuality} from '../store/settings';
import {useSessionStore, type PointerMode, type SessionPhase} from '../store/session';
import KeyboardBar from '../components/KeyboardBar';
import ClipboardSync, {type ClipboardSyncHandle} from '../components/ClipboardSync';
import TrackpadPanel from '../components/TrackpadPanel';
import IconButton from '../components/IconButton';
import PrimaryButton from '../components/PrimaryButton';
import SecondaryButton from '../components/SecondaryButton';
import Segmented from '../components/Segmented';
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

const TOOLBAR_HIDE_MS = 3500;
/** Ignore the clipboard snapshot the agent pushes right after connecting. */
const CLIPBOARD_GRACE_MS = 2500;

const END_REASONS: Record<string, string> = {
  ended_by_peer: 'The computer ended the session.',
  device_disconnected: 'The computer went offline.',
  device_reconnected: 'The host restarted its connection.',
  device_deleted: 'This computer was removed from your account.',
  client_disconnected: 'Your connection to the relay dropped.',
  relay_disconnected: 'Your connection to the relay dropped.',
  capture_unavailable: 'Screen sharing isn’t available on that computer.',
  rejected: 'The computer declined the session.',
};

// ---------------------------------------------------------------------------
// Direct-mode gestures (absolute clicks on the video surface)
// ---------------------------------------------------------------------------

/**
 * Tap = click where you touch, drag = left-button drag, double-tap reveals
 * the toolbar. Callbacks run on the JS thread (`runOnJS(true)`); the latest
 * layout values are read from a ref so the gesture graph is built once.
 */
function useDirectModeGestures(
  send: (message: InputMessage) => void,
  haptic: () => void,
  onReveal: () => void,
  geometry: React.MutableRefObject<{
    surface: {width: number; height: number};
    video: {width: number; height: number} | null;
  }>,
) {
  const latest = React.useRef({send, haptic, onReveal});
  latest.current = {send, haptic, onReveal};

  return React.useMemo(() => {
    const state = {dragging: false};

    /**
     * Map a point in surface coordinates to normalized remote-screen
     * coordinates. The video is letterboxed (contain), so clicks must be
     * normalized against the visible video rect, not the container.
     */
    const normalize = (x: number, y: number) => {
      const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
      const {surface, video} = geometry.current;
      const {width: w, height: h} = surface;
      if (w <= 0 || h <= 0) {
        return {x: 0, y: 0};
      }
      if (video && video.width > 0 && video.height > 0) {
        const scale = Math.min(w / video.width, h / video.height);
        const displayW = video.width * scale;
        const displayH = video.height * scale;
        return {
          x: clamp01((x - (w - displayW) / 2) / displayW),
          y: clamp01((y - (h - displayH) / 2) / displayH),
        };
      }
      return {x: clamp01(x / w), y: clamp01(y / h)};
    };

    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(250)
      .onEnd((event, success) => {
        if (!success) {
          return;
        }
        latest.current.haptic();
        const p = normalize(event.x, event.y);
        latest.current.send({t: 'click', button: 'left', x: p.x, y: p.y});
      });

    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((_event, success) => {
        if (success) {
          latest.current.onReveal();
        }
      });

    const longPress = Gesture.LongPress()
      .runOnJS(true)
      .minDuration(450)
      .onStart(event => {
        latest.current.haptic();
        const p = normalize(event.x, event.y);
        latest.current.send({t: 'click', button: 'right', x: p.x, y: p.y});
      });

    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(8)
      .onStart(event => {
        const p = normalize(event.x, event.y);
        latest.current.send({t: 'pointer.abs', x: p.x, y: p.y});
        latest.current.send({t: 'button', button: 'left', down: true});
        state.dragging = true;
      })
      .onUpdate(event => {
        const p = normalize(event.x, event.y);
        latest.current.send({t: 'pointer.abs', x: p.x, y: p.y});
      })
      .onFinalize(() => {
        if (state.dragging) {
          state.dragging = false;
          latest.current.send({t: 'button', button: 'left', down: false});
        }
      });

    return Gesture.Race(pan, longPress, Gesture.Exclusive(doubleTap, tap));
  }, [geometry]);
}

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
  onClose,
  onRetry,
}: {
  deviceName: string;
  onClose: () => void;
  onRetry: () => void;
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
    : `Connecting to ${deviceName}`;
  const detail = settled
    ? (phase === 'failed' ? error : endReason && END_REASONS[endReason]) ??
      (phase === 'failed' ? 'Something went wrong.' : 'The remote session is closed.')
    : phase === 'starting'
      ? 'Reaching the relay server…'
      : phase === 'waiting'
        ? 'Waiting for the computer to answer…'
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
            <PrimaryButton label="Reconnect" onPress={onRetry} style={styles.flex} />
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
}: {
  icon: AppIconName;
  label: string;
  onPress: () => void;
}) {
  const {palette} = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [
        styles.menuAction,
        {
          backgroundColor: pressed
            ? mix(palette.textPrimary, palette.surfaceContainer, stateOpacity.pressed)
            : palette.surfaceContainer,
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
  value,
  onChange,
}: {
  icon: AppIconName;
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const {palette} = useTheme();
  return (
    <View style={styles.menuToggle}>
      <AppIcon name={icon} color={palette.textSecondary} size={20} />
      <Text style={[styles.menuToggleLabel, {color: palette.textPrimary}]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{false: palette.surfaceContainerHighest, true: palette.primary}}
        thumbColor={palette.textPrimary}
      />
    </View>
  );
}

function SessionMenu({
  visible,
  onClose,
  quality,
  onQuality,
  statsVisible,
  onStats,
  rotationLocked,
  onRotation,
  onFullscreen,
  onSendClipboard,
  onGetClipboard,
  onMedia,
  onCtrlAltDel,
  onDisconnect,
}: {
  visible: boolean;
  onClose: () => void;
  quality: VideoQuality;
  onQuality: (quality: VideoQuality) => void;
  statsVisible: boolean;
  onStats: (value: boolean) => void;
  rotationLocked: boolean;
  onRotation: (value: boolean) => void;
  onFullscreen: () => void;
  onSendClipboard: () => void;
  onGetClipboard: () => void;
  onMedia: (key: MediaKeyName) => void;
  onCtrlAltDel: () => void;
  onDisconnect: () => void;
}) {
  const {palette} = useTheme();
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityLabel="Close menu"
          style={[StyleSheet.absoluteFill, {backgroundColor: withAlpha(palette.scrim, 0.4)}]}
          onPress={onClose}
        />
        <SafeAreaView
          edges={['bottom']}
          style={[styles.sheet, {backgroundColor: palette.surface, borderColor: palette.border}]}>
          <View style={[styles.handle, {backgroundColor: palette.borderStrong}]} />
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Quality</Text>
            <Segmented options={QUALITY_OPTIONS} value={quality} onChange={onQuality} />

            <Text style={[styles.menuSection, {color: palette.textSecondary}]}>Actions</Text>
            <View style={styles.menuGrid}>
              <MenuAction icon="clipboard" label="Send clipboard" onPress={run(onSendClipboard)} />
              <MenuAction icon="copy" label="Get clipboard" onPress={run(onGetClipboard)} />
              <MenuAction icon="fullscreen" label="Full screen" onPress={run(onFullscreen)} />
              <MenuAction icon="lock" label="Ctrl+Alt+Del" onPress={run(onCtrlAltDel)} />
              <MenuAction icon="volume-down" label="Volume –" onPress={() => onMedia('volume_down')} />
              <MenuAction icon="volume-up" label="Volume +" onPress={() => onMedia('volume_up')} />
              <MenuAction icon="volume-mute" label="Mute" onPress={() => onMedia('volume_mute')} />
              <MenuAction icon="chevron-right" label="Play/Pause" onPress={() => onMedia('play_pause')} />
            </View>

            <View style={[styles.menuToggles, {borderColor: palette.border}]}>
              <MenuToggle icon="stats" label="Connection stats" value={statsVisible} onChange={onStats} />
              <MenuToggle icon="rotate" label="Lock to portrait" value={rotationLocked} onChange={onRotation} />
            </View>

            <PrimaryButton label="Disconnect" icon="close" tone="error" onPress={run(onDisconnect)} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function RemoteSession({route, navigation}: RemoteSessionProps) {
  const {palette} = useTheme();
  const deviceId = route.params.deviceId;
  const deviceName = route.params.deviceName ?? 'Remote PC';

  const phase = useSessionStore(s => s.phase);
  const pointerMode = useSessionStore(s => s.pointerMode);
  const keyboardOpen = useSessionStore(s => s.keyboardOpen);
  const statsVisible = useSessionStore(s => s.statsVisible);
  const quality = useSessionStore(s => s.quality);
  const remoteClipboard = useSessionStore(s => s.remoteClipboard);
  const rtt = useSessionStore(s => s.stats.rttMs);
  const statsWidth = useSessionStore(s => s.stats.width);
  const statsHeight = useSessionStore(s => s.stats.height);
  const defaultQuality = useSettingsStore(s => s.defaultQuality);
  const hapticsEnabled = useSettingsStore(s => s.haptics);

  const [attempt, setAttempt] = React.useState(0);
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null);
  const [channelOpen, setChannelOpen] = React.useState(false);
  const [toolbarVisible, setToolbarVisible] = React.useState(true);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [rotationLocked, setRotationLocked] = React.useState(true);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [jpegFrame, setJpegFrame] = React.useState<string | null>(null);
  const {toast, notify} = useToast();

  const geometry = React.useRef<{
    surface: {width: number; height: number};
    video: {width: number; height: number} | null;
  }>({surface: {width: 0, height: 0}, video: null});
  geometry.current.video =
    statsWidth && statsHeight ? {width: statsWidth, height: statsHeight} : null;

  const clientRef = React.useRef<SessionClient | null>(null);
  const clipboardRef = React.useRef<ClipboardSyncHandle>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedAt = React.useRef(0);

  const haptic = React.useCallback(() => {
    if (hapticsEnabled) {
      Vibration.vibrate(8);
    }
  }, [hapticsEnabled]);

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
    clientRef.current?.end();
    clientRef.current = null;
    navigation.goBack();
  }, [navigation]);

  // Session lifecycle (re-runs on "Reconnect").
  React.useEffect(() => {
    const store = useSessionStore.getState();
    store.begin(deviceId, deviceName);
    // First connection uses the default; "Reconnect" keeps the user's pick.
    if (attempt === 0) {
      store.setQuality(defaultQuality);
    }
    setStreamUrl(null);
    setJpegFrame(null);
    setChannelOpen(false);

    const client = new SessionClient({
      onPhase: (nextPhase, error) => {
        const s = useSessionStore.getState();
        if (nextPhase === 'failed') {
          s.setPhase('failed', error);
          s.setEndReason(error ?? 'failed');
        } else if (nextPhase === 'ended') {
          s.setEndReason(error ?? 'ended');
          s.setPhase('ended');
        } else {
          s.setPhase(nextPhase);
        }
      },
      onStream: url => setStreamUrl(url),
      onStats: (stats: SessionStatsSnapshot) => useSessionStore.getState().setStats(stats),
      onDataChannelOpen: () => {
        connectedAt.current = Date.now();
        setChannelOpen(true);
      },
      onRemoteClipboard: text => {
        if (Date.now() - connectedAt.current < CLIPBOARD_GRACE_MS) {
          return;
        }
        useSessionStore.getState().setRemoteClipboard(text);
      },
      onJpegFrame: dataUrl => setJpegFrame(dataUrl),
    });
    clientRef.current = client;

    client
      .start(deviceId, useSessionStore.getState().quality)
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
      client.end();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
    // Only a new device or an explicit "Reconnect" restarts the session.
  }, [deviceId, attempt]);

  // Leaving the screen resets the shared session store.
  React.useEffect(() => () => useSessionStore.getState().reset(), []);

  // Fullscreen hides the status bar.
  React.useEffect(() => {
    StatusBar.setHidden(fullscreen, 'fade');
    return () => StatusBar.setHidden(false, 'fade');
  }, [fullscreen]);

  // Rotation lock: native-stack screens accept an `orientation` option.
  React.useEffect(() => {
    navigation.setOptions({orientation: rotationLocked ? 'portrait' : 'all'});
  }, [navigation, rotationLocked]);

  const setQuality = (next: VideoQuality) => {
    useSessionStore.getState().setQuality(next);
    clientRef.current?.setQuality(next);
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

  const directGestures = useDirectModeGestures(send, haptic, pingToolbar, geometry);
  const surfaceTap = React.useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .onEnd((_event, success) => {
          if (success) {
            pingToolbar();
          }
        }),
    [pingToolbar],
  );

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

  const connected = phase === 'connected';
  const showToolbar = !fullscreen && (!connected || toolbarVisible || menuOpen);
  const togglePointerMode = () => {
    haptic();
    const next: PointerMode = pointerMode === 'trackpad' ? 'direct' : 'trackpad';
    useSessionStore.getState().setPointerMode(next);
    notify(next === 'trackpad' ? 'Trackpad mode' : 'Touch mode — tap where you want to click', 'neutral');
    pingToolbar();
  };

  return (
    <View style={[styles.root, {backgroundColor: '#000000'}]}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      {/* Video surface */}
      <GestureDetector gesture={pointerMode === 'direct' && connected ? directGestures : surfaceTap}>
        <View
          style={styles.videoWrap}
          onLayout={event => {
            const {width, height} = event.nativeEvent.layout;
            geometry.current.surface = {width, height};
          }}>
          {streamUrl ? (
            <RTCView streamURL={streamUrl} style={styles.video} objectFit="contain" />
          ) : jpegFrame ? (
            <Image source={{uri: jpegFrame}} style={styles.video} resizeMode="contain" fadeDuration={0} />
          ) : null}
          {statsVisible && connected ? <StatsOverlay /> : null}
        </View>
      </GestureDetector>

      <PhaseOverlay
        deviceName={deviceName}
        onClose={disconnect}
        onRetry={() => setAttempt(n => n + 1)}
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
                <View
                  style={[
                    styles.liveDot,
                    {backgroundColor: connected ? palette.success.base : palette.accent},
                  ]}
                />
                <Text style={[styles.subtitle, {color: palette.textSecondary}]} numberOfLines={1}>
                  {connected
                    ? rtt != null
                      ? `Connected · ${rtt} ms`
                      : 'Connected'
                    : phase === 'ended' || phase === 'failed'
                      ? 'Disconnected'
                      : 'Connecting…'}
                </Text>
              </View>
            </View>
            {connected ? (
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
                  icon={pointerMode === 'trackpad' ? 'mouse' : 'touch'}
                  color={palette.textPrimary}
                  accessibilityLabel={
                    pointerMode === 'trackpad' ? 'Switch to touch mode' : 'Switch to trackpad mode'
                  }
                  onPress={togglePointerMode}
                />
                <IconButton
                  icon="tune"
                  color={palette.textPrimary}
                  accessibilityLabel="Session menu"
                  onPress={() => setMenuOpen(true)}
                />
              </>
            ) : null}
          </View>
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
      {connected ? (
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
        connected={channelOpen}
        remoteText={remoteClipboard}
        onDismissRemote={() => useSessionStore.getState().setRemoteClipboard(null)}
      />

      <SessionMenu
        visible={menuOpen}
        onClose={() => {
          setMenuOpen(false);
          pingToolbar();
        }}
        quality={quality}
        onQuality={setQuality}
        statsVisible={statsVisible}
        onStats={value => useSessionStore.getState().setStatsVisible(value)}
        rotationLocked={rotationLocked}
        onRotation={setRotationLocked}
        onFullscreen={() => setFullscreen(true)}
        onSendClipboard={pushClipboard}
        onGetClipboard={() => {
          connectedAt.current = 0;
          clipboardRef.current?.pullRemote();
        }}
        onMedia={key => {
          haptic();
          send({t: 'input.media', key});
        }}
        onCtrlAltDel={() => send({t: 'input.ctrlaltdel'})}
        onDisconnect={disconnect}
      />

      <Toast toast={toast} bottom={keyboardOpen ? 140 : 240} />
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
  root: {
    flex: 1,
  },
  flex: {flex: 1},
  videoWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: {
    flex: 1,
    alignSelf: 'stretch',
  },
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
  titleCol: {
    flex: 1,
    paddingHorizontal: spacing.xs,
  },
  title: {
    ...typography.titleMedium,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  subtitle: {
    ...typography.bodySmall,
  },
  exitFullscreen: {
    position: 'absolute',
    right: spacing.sm,
    top: spacing.sm,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
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
  statItem: {
    gap: 1,
  },
  statLabel: {
    ...typography.labelSmall,
  },
  statValue: {
    ...typography.labelLarge,
    fontVariant: ['tabular-nums'],
  },
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
  phaseTitle: {
    ...typography.headlineSmall,
    textAlign: 'center',
  },
  phaseText: {
    ...typography.bodyMedium,
    textAlign: 'center',
  },
  phaseSteps: {
    flexDirection: 'row',
    gap: 6,
    marginTop: spacing.xs,
  },
  phaseStep: {
    width: 28,
    height: 4,
    borderRadius: 2,
  },
  phaseActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignSelf: 'stretch',
    marginTop: spacing.xs,
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
    maxHeight: '85%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  sheetBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm + 4,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginVertical: spacing.sm,
  },
  menuSection: {
    ...typography.titleSmall,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  menuGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  menuAction: {
    width: '22.5%',
    flexGrow: 1,
    minWidth: 72,
    paddingVertical: spacing.sm + 4,
    borderRadius: shape.md,
    alignItems: 'center',
    gap: 6,
  },
  menuActionLabel: {
    ...typography.labelSmall,
    fontWeight: '600',
  },
  menuToggles: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    paddingVertical: spacing.xs,
  },
  menuToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
  },
  menuToggleLabel: {
    ...typography.bodyLarge,
    flex: 1,
  },
});
