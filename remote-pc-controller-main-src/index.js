// Supabase needs a spec-compliant URL implementation and TextDecoder
// (Realtime decodes binary broadcast frames); Hermes ships neither.
import 'fast-text-encoding';
import 'react-native-url-polyfill/auto';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
