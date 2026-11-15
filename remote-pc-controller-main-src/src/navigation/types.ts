/** Route param types for the root native stack and the bottom tabs. */

import type {NavigatorScreenParams} from '@react-navigation/native';

export type TabParamList = {
  Devices: undefined;
  Support: undefined;
  Settings: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /**
   * deviceId for your own computers; supportSessionId for a Remote Support
   * session redeemed with an access code (mode = what the host allowed).
   */
  RemoteSession: {
    deviceId?: string;
    deviceName?: string;
    supportSessionId?: string;
    mode?: 'control' | 'view';
  };
  Setup: undefined;
  /** "Control this phone from your PC" (src/lib/phoneHost.ts). */
  PhoneHost: undefined;
};
