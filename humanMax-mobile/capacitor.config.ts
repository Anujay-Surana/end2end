import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.humanmax.app',
  appName: 'HumanMax',
  webDir: 'dist',
  // Remove server config for device builds - use bundled web assets
  // Uncomment below for live reload during development (simulator only):
  // server: {
  //   url: 'http://localhost:8080',
  //   cleartext: true
  // },
  ios: {
    contentInset: 'automatic',
    scheme: 'com.humanmax.app'
  }
};

export default config;
