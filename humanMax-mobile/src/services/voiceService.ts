import { Capacitor } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

export interface OpenAIRealtimePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPartialTranscript(options: { callback: (text: string) => void }): Promise<void>;
  onFinalTranscript(options: { callback: (text: string) => void }): Promise<void>;
  onAudioPlayback(options: { callback: (audioData: number[]) => void }): Promise<void>;
  addListener(eventName: 'audioData', listenerFunc: (data: { data: number[] }) => void): Promise<any>;
  removeAllListeners(): Promise<void>;
}

const OpenAIRealtime = registerPlugin<OpenAIRealtimePlugin>('OpenAIRealtime', {
  web: () => import('./voiceService.web').then(m => new m.OpenAIRealtimeWeb()),
});

class VoiceService {
  private isRecording = false;

  async start(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Voice recording already in progress');
    }

    if (!Capacitor.isNativePlatform()) {
      throw new Error('Voice recording is only available on native platforms');
    }

    try {
      await OpenAIRealtime.start();
      this.isRecording = true;

      // Set up audio data listener
      await OpenAIRealtime.addListener('audioData', (data) => {
        // Stream audio data to backend WebSocket
        // This would be handled by the chat component
        console.log('Audio data received:', data.data.length);
      });
    } catch (error) {
      this.isRecording = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRecording) {
      return;
    }

    try {
      await OpenAIRealtime.stop();
      await OpenAIRealtime.removeAllListeners();
      this.isRecording = false;
    } catch (error) {
      throw error;
    }
  }

  onPartialTranscript(callback: (text: string) => void): void {
    OpenAIRealtime.onPartialTranscript({ callback });
  }

  onFinalTranscript(callback: (text: string) => void): void {
    OpenAIRealtime.onFinalTranscript({ callback });
  }

  onAudioPlayback(callback: (audioData: number[]) => void): void {
    OpenAIRealtime.onAudioPlayback({ callback });
  }

  getIsRecording(): boolean {
    return this.isRecording;
  }
}

export const voiceService = new VoiceService();

