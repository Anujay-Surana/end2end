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

// Log plugin registration
console.log('🔌 OpenAIRealtime plugin registered:', {
  plugin: !!OpenAIRealtime,
  hasStart: typeof OpenAIRealtime?.start === 'function',
  hasStop: typeof OpenAIRealtime?.stop === 'function',
  platform: Capacitor.getPlatform(),
  isNative: Capacitor.isNativePlatform()
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
      console.log('🎤 Starting voice recording...');
      console.log('📱 Platform:', Capacitor.getPlatform());
      console.log('🔌 Plugin available:', !!OpenAIRealtime);
      
      // Check if plugin methods exist
      if (!OpenAIRealtime.start) {
        throw new Error('OpenAIRealtime plugin not properly registered. start() method not found.');
      }

      await OpenAIRealtime.start();
      console.log('✅ Voice recording started successfully');
      this.isRecording = true;

      // Set up audio data listener
      console.log('🎧 Setting up audio data listener...');
      await OpenAIRealtime.addListener('audioData', (data) => {
        // Stream audio data to backend WebSocket
        // This would be handled by the chat component
        console.log('📊 Audio data received:', data.data?.length || 0, 'samples');
      });
      console.log('✅ Audio listener set up');
    } catch (error: any) {
      console.error('❌ Error starting voice recording:', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        pluginAvailable: !!OpenAIRealtime,
        platform: Capacitor.getPlatform()
      });
      this.isRecording = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRecording) {
      console.log('⚠️ Stop called but not recording');
      return;
    }

    try {
      console.log('⏹️ Stopping voice recording...');
      await OpenAIRealtime.stop();
      await OpenAIRealtime.removeAllListeners();
      this.isRecording = false;
      console.log('✅ Voice recording stopped');
    } catch (error: any) {
      console.error('❌ Error stopping voice recording:', error);
      this.isRecording = false;
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

