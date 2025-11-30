/**
 * Web implementation of OpenAI Realtime plugin
 * Falls back to Web Audio API for web platforms
 */

export class OpenAIRealtimeWeb {
  async start(): Promise<void> {
    throw new Error('Voice recording is not supported on web platform. Use native iOS app.');
  }

  async stop(): Promise<void> {
    throw new Error('Voice recording is not supported on web platform.');
  }

  async onPartialTranscript(): Promise<void> {
    // No-op on web
  }

  async onFinalTranscript(): Promise<void> {
    // No-op on web
  }

  async onAudioPlayback(): Promise<void> {
    // No-op on web
  }

  async addListener(): Promise<any> {
    return { remove: () => {} };
  }

  async removeAllListeners(): Promise<void> {
    // No-op on web
  }
}

