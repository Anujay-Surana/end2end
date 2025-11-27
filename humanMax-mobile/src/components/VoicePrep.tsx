import { useState, useEffect, useRef } from 'react';
import type { Meeting } from '../types';
import './VoicePrep.css';

interface VoicePrepProps {
  meeting: Meeting;
  brief: any; // The meeting prep brief
  onClose: () => void;
}

export const VoicePrep: React.FC<VoicePrepProps> = ({ meeting, brief, onClose }) => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState('Ready to start your briefing');
  const [transcript, setTranscript] = useState<string>('');
  const [timer, setTimer] = useState(120); // 2 minutes in seconds
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const audioBufferQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingAudioRef = useRef(false);

  // Get WebSocket URL
  const getWebSocketUrl = () => {
    const apiUrl = import.meta.env.VITE_API_URL || 'https://end2end-production.up.railway.app';
    // Convert HTTP/HTTPS to WS/WSS
    return apiUrl.replace(/^http/, 'ws');
  };

  // Initialize playback AudioContext
  const initPlaybackContext = () => {
    if (!playbackAudioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      playbackAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
    }
    return playbackAudioContextRef.current;
  };

  // Play TTS audio using AudioContext for seamless playback
  const playTTSAudio = async (audioData: ArrayBuffer) => {
    try {
      const context = initPlaybackContext();
      
      // Resume context if suspended (required for iOS)
      if (context.state === 'suspended') {
        await context.resume();
      }
      
      // OpenAI Realtime API sends PCM16 at 24kHz
      const sampleRate = 24000;
      const numChannels = 1;
      
      // Convert Uint8Array to Int16Array (PCM16)
      const pcmData = new Int16Array(audioData);
      
      // Convert Int16 PCM to Float32 for Web Audio API
      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = Math.max(-1, Math.min(1, pcmData[i] / 32768.0));
      }
      
      // Create AudioBuffer
      const audioBuffer = context.createBuffer(numChannels, float32Data.length, sampleRate);
      audioBuffer.copyToChannel(float32Data, 0);
      
      // Schedule seamless playback at 2x speed
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = 2.0; // Speed up audio by 2x
      source.connect(context.destination);
      
      const currentTime = context.currentTime;
      const startTime = Math.max(currentTime, nextPlayTimeRef.current);
      
      source.start(startTime);
      
      // Update next play time to prevent gaps (account for 2x speed)
      const duration = audioBuffer.duration / 2.0; // Duration is shorter at 2x speed
      nextPlayTimeRef.current = startTime + duration;
      
      setIsSpeaking(true);
      
      source.onended = () => {
        // Check if there's more audio queued
        if (audioBufferQueueRef.current.length > 0) {
          const nextBuffer = audioBufferQueueRef.current.shift()!;
          playTTSAudio(nextBuffer);
        } else {
          setIsSpeaking(false);
          isPlayingAudioRef.current = false;
          setStatus('Listening...');
        }
      };
      
      isPlayingAudioRef.current = true;
    } catch (error) {
      console.error('Error playing audio:', error);
      setIsSpeaking(false);
      isPlayingAudioRef.current = false;
      setStatus('Listening...');
    }
  };

  // Start timer countdown
  const startTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
    
    timerIntervalRef.current = window.setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          stopSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Format timer as MM:SS
  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Start voice prep session
  const startSession = async () => {
    try {
      setStatus('Connecting...');
      
      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not available. Please ensure you are using HTTPS or a secure context.');
      }
      
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      
      mediaStreamRef.current = stream;
      
      // Set up audio context
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = scriptProcessor;
      
      // Connect WebSocket
      const wsUrl = getWebSocketUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log('✅ WebSocket connected');
        setStatus('Connected. Starting briefing...');
        
        // Send voice prep start message
        ws.send(JSON.stringify({
          type: 'voice_prep_start',
          meeting: meeting,
          brief: brief,
        }));
        
        setIsActive(true);
        setIsListening(true);
        startTimer();
      };
      
      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Voice prep message:', data.type, data);
          
          if (data.type === 'voice_prep_ready') {
            setStatus('Briefing ready. Starting...');
            setIsListening(true);
            // Start sending audio
            scriptProcessor.onaudioprocess = (e) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              
              const float32Audio = e.inputBuffer.getChannelData(0);
              const int16Audio = new Int16Array(float32Audio.length);
              
              for (let i = 0; i < float32Audio.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Audio[i]));
                int16Audio[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              
              // Convert Int16Array to base64 (backend expects this format)
              const uint8Array = new Uint8Array(int16Audio.buffer);
              // Use apply method for large arrays to avoid stack overflow
              let base64Audio;
              try {
                base64Audio = btoa(String.fromCharCode.apply(null, Array.from(uint8Array)));
              } catch (err) {
                // Fallback for very large arrays
                const chunks = [];
                for (let i = 0; i < uint8Array.length; i += 8192) {
                  chunks.push(String.fromCharCode.apply(null, Array.from(uint8Array.slice(i, i + 8192))));
                }
                base64Audio = btoa(chunks.join(''));
              }
              
              // Send audio to backend (backend forwards to OpenAI Realtime API)
              ws.send(JSON.stringify({
                type: 'voice_prep_audio',
                audio: base64Audio,
              }));
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);
            console.log('🎤 Audio streaming started');
              } else if (data.type === 'realtime_audio') {
                // Receive audio chunks from OpenAI Realtime API
                console.log('🎵 Received audio chunk, length:', data.audio?.length, 'type:', typeof data.audio);
                try {
                  if (data.audio) {
                    // Audio is base64 encoded PCM data
                    const audioData = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0)).buffer;
                    console.log('🎵 Decoded audio buffer size:', audioData.byteLength);
                    await playTTSAudio(audioData);
                    setStatus('Speaking...');
                  } else {
                    console.warn('⚠️ realtime_audio message has no audio data');
                  }
                } catch (err) {
                  console.error('❌ Error decoding audio:', err);
                  setIsSpeaking(false);
                  setStatus('Listening...');
                }
          } else if (data.type === 'realtime_audio_done') {
            setStatus('Listening...');
            setIsListening(true);
            setIsSpeaking(false);
            console.log('Audio playback complete');
          } else if (data.type === 'voice_prep_section_change') {
            setStatus(data.message || 'Processing...');
            if (data.section) {
              setTranscript((prev) => prev + `\n\n[${data.section}]\n`);
            }
          } else if (data.type === 'realtime_transcript' || data.type === 'response.audio_transcript.delta') {
            // Receive transcript from OpenAI Realtime API (partial)
            if (data.text || data.delta) {
              const transcriptText = data.text || data.delta || '';
              setTranscript((prev) => {
                const newText = prev ? prev + transcriptText : transcriptText;
                return newText;
              });
            }
          } else if (data.type === 'voice_prep_transcript') {
            // Final transcript from user (question)
            if (data.text && data.isFinal) {
              setTranscript((prev) => {
                const questionText = `\n\n[You]: ${data.text}\n`;
                return prev ? prev + questionText : questionText;
              });
              setStatus('Processing your question...');
              setIsListening(false);
            } else if (data.text) {
              // Partial transcript
              setTranscript((prev) => {
                const newText = prev ? prev + data.text : data.text;
                return newText;
              });
            }
          } else if (data.type === 'voice_prep_audio') {
            // Receive TTS audio (base64 encoded)
            console.log('Received voice_prep_audio');
            try {
              if (data.audio) {
                const audioData = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0)).buffer;
                await playTTSAudio(audioData);
              }
            } catch (err) {
              console.error('Error decoding audio:', err);
            }
          } else if (data.type === 'voice_prep_status') {
            setStatus(data.message || 'Processing...');
          } else if (data.type === 'voice_prep_interrupted') {
            setStatus(data.message || 'Listening...');
            setIsListening(true);
            setIsSpeaking(false);
            console.log('Briefing interrupted - ready for question');
          } else if (data.type === 'realtime_ready' || data.type === 'realtime_session_ready') {
            // Session is ready, wait for briefing to start
            console.log('Realtime API ready');
            setStatus('Session ready. Starting briefing...');
          } else if (data.type === 'voice_prep_time_update') {
            // Update timer based on elapsed time
            const remaining = Math.max(0, Math.floor((data.total - data.elapsed) / 1000));
            setTimer(remaining);
          } else if (data.type === 'error') {
            setStatus(`Error: ${data.message}`);
            console.error('Voice prep error:', data.message);
          } else {
            // Log any other message types for debugging
            console.log('Unhandled message type:', data.type, data);
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setStatus('Connection error. Please try again.');
      };
      
      ws.onclose = () => {
        console.log('WebSocket closed');
        setIsListening(false);
        if (isActive) {
          setStatus('Connection closed');
        }
      };
      
    } catch (error: any) {
      console.error('Error starting voice prep:', error);
      const errorMessage = error.message || error.toString() || 'Failed to start';
      setStatus(`Error: ${errorMessage}`);
      
      if (error.name === 'NotAllowedError' || errorMessage.includes('permission')) {
        setStatus('Microphone access denied. Please enable microphone permissions in Settings.');
      } else if (errorMessage.includes('not available') || errorMessage.includes('undefined')) {
        setStatus('Microphone access not available. Please ensure the app has microphone permissions.');
      }
    }
  };

  // Stop voice prep session
  const stopSession = () => {
    setIsActive(false);
    setIsListening(false);
    setStatus('Stopped');
    
    // Clear timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    
    // Stop audio playback
    if (playbackAudioContextRef.current) {
      playbackAudioContextRef.current.close();
      playbackAudioContextRef.current = null;
    }
    audioBufferQueueRef.current = [];
    isPlayingAudioRef.current = false;
    nextPlayTimeRef.current = 0;
    setIsSpeaking(false);
    
    // Send stop message
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'voice_prep_stop',
      }));
    }
    
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    
    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="voice-prep-overlay" onClick={onClose}>
      <div className="voice-prep-content" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose}>×</button>
        
        <div className="voice-prep-header">
          <h2>🎙️ Voice Prep Mode</h2>
          <p className="voice-prep-subtitle">2-Minute Briefing</p>
        </div>

        {/* Meeting Info */}
        <div className="voice-prep-meeting-info">
          <strong>{meeting.summary || meeting.title || 'Meeting'}</strong>
          <div className="voice-prep-meeting-time">
            {meeting.start?.dateTime 
              ? new Date(meeting.start.dateTime).toLocaleString()
              : meeting.start?.date
              ? new Date(meeting.start.date).toLocaleDateString()
              : 'Time not specified'}
          </div>
        </div>

        {/* Timer and Status */}
        <div className="voice-prep-status">
          <div className="voice-prep-timer">{formatTimer(timer)}</div>
          <div className="voice-prep-status-text">
            {isSpeaking ? '🔊 Speaking...' : (isListening ? '🎤 Listening...' : status)}
          </div>
        </div>

        {/* Transcript */}
        <div className="voice-prep-transcript">
          {transcript || (
            <div className="voice-prep-transcript-placeholder">
              <div className="voice-prep-icon">🎙️</div>
              <div>Your 2-minute voice briefing will appear here...</div>
              <div className="voice-prep-hint">
                The AI will guide you through attendees, insights, agenda, and recommendations. 
                You can interrupt anytime to ask questions.
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="voice-prep-controls">
          {!isActive ? (
            <button 
              className="voice-prep-button voice-prep-button-start"
              onClick={startSession}
            >
              🎙️ Start Briefing
            </button>
          ) : (
            <button 
              className="voice-prep-button voice-prep-button-stop"
              onClick={stopSession}
            >
              ⏹️ Stop
            </button>
          )}
        </div>

        {/* Instructions */}
        <div className="voice-prep-instructions">
          <strong>💡 How it works:</strong>
          <ul>
            <li>The AI will deliver a structured 2-minute briefing</li>
            <li>Interrupt anytime by speaking - just ask your question</li>
            <li>After the briefing, you can continue asking questions</li>
            <li>Make sure your microphone is enabled</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

