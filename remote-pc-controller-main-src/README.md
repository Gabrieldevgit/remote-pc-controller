# Remote PC Controller — mobile app

React Native 0.81 (bare workflow, Hermes, Fabric) client for the self-hosted
relay in `../relay` and the Windows agent in `../agent`. See the repo-root
README for the big picture.

## Requirements

- Node.js 20+ (for Metro and the relay/agent)
- Android Studio (SDK 36, NDK 27.1.12297006) and/or Xcode
- A running relay server (`node ../relay/src/server.js`) and, for sessions,
  a paired Windows agent (`node ../agent/src/index.js run`)

## Develop

```bat
npm install
npm run android        # debug build + start Metro (or: npm run start)
npm run tsc            # typecheck
```

The default relay URL targets the Android emulator loopback
(`ws://10.0.2.2:8080`). On a physical device open **Settings** in the app and
enter your PC's LAN address, e.g. `ws://192.168.1.20:8080`.

## Release APK

A self-signed release keystore lives at `android/app/release.keystore` with
credentials in `android/keystore.properties` (git-ignored). Build with:

```bat
cd android
gradlew.bat assembleRelease
:: -> android\app\build\outputs\apk\release\app-release.apk
```

The manifest allows cleartext traffic so plain `ws://` LAN relays work from
release builds; WebRTC media is DTLS/SRTP encrypted regardless.

## Layout

```
src/lib/        relay WebSocket client, session/WebRTC client, input protocol
src/store/      zustand stores (auth, devices, settings, session)
src/screens/    Devices, RemoteSession, Settings, Profile, Setup
src/components/ design-system widgets + session surfaces (trackpad, keyboard, clipboard)
src/theme/      Material-You-style tokens (light/dark) + ThemeProvider
```
