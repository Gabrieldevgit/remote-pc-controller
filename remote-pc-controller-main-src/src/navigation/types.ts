/** Route param types for the root native stack and the bottom tabs. */

import type {NavigatorScreenParams} from '@react-navigation/native';

export type TabParamList = {
  Devices: undefined;
  Settings: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  RemoteSession: {deviceId: string; deviceName?: string};
  Setup: undefined;
};
