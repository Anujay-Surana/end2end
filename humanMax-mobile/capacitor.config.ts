import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.shadow.app',
  appName: 'Shadow',
  webDir: 'dist',
  // Remove server config for device builds - use bundled web assets
  // Uncomment below for live reload during development (simulator only):
  // server: {
  //   url: 'http://localhost:8080',
  //   cleartext: true
  // },
  ios: {
    contentInset: 'automatic',
    scheme: 'com.shadow.app'
  }
};

export default config;
