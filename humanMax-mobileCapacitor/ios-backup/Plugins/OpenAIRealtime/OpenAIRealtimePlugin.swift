import Foundation
import Capacitor
import AVFoundation

/**
 * OpenAI Realtime Plugin
 * 
 * Handles low-latency audio streaming to OpenAI Realtime API
 * Uses AVAudioEngine for PCM capture and playback
 */
@objc(OpenAIRealtimePlugin)
public class OpenAIRealtimePlugin: CAPPlugin {
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var playerNode: AVAudioPlayerNode?
    private var audioFormat: AVAudioFormat?
    private var isRecording = false
    private var websocketTask: URLSessionWebSocketTask?
    
    @objc func start(_ call: CAPPluginCall) {
        guard !isRecording else {
            call.reject("Already recording")
            return
        }
        
        // Request microphone permission
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            guard granted else {
                call.reject("Microphone permission denied")
                return
            }
            
            DispatchQueue.main.async {
                self?.setupAudioEngine()
                self?.startRecording()
                call.resolve()
            }
        }
    }
    
    @objc func stop(_ call: CAPPluginCall) {
        stopRecording()
        call.resolve()
    }
    
    private func setupAudioEngine() {
        audioEngine = AVAudioEngine()
        guard let engine = audioEngine else { return }
        
        inputNode = engine.inputNode
        playerNode = AVAudioPlayerNode()
        
        // Configure for 16kHz, 16-bit PCM
        audioFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        )
        
        guard let format = audioFormat else { return }
        
        // Optimize audio session for low latency
        do {
            let audioSession = AVAudioSession.sharedInstance()
            // Use voiceChat mode for lowest latency
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            // Set preferred buffer duration to 5ms for ultra-low latency (default is ~23ms)
            try audioSession.setPreferredIOBufferDuration(0.005)
            // Set preferred sample rate
            try audioSession.setPreferredSampleRate(16000)
            try audioSession.setActive(true)
        } catch {
            print("Error setting up audio session: \(error)")
            return
        }
        
        // Attach player node
        engine.attach(playerNode!)
        engine.connect(playerNode!, to: engine.mainMixerNode, format: format)
        
        do {
            try engine.start()
        } catch {
            print("Error starting audio engine: \(error)")
        }
    }
    
    private func startRecording() {
        guard let engine = audioEngine,
              let input = inputNode,
              let format = audioFormat else {
            return
        }
        
        isRecording = true
        
        // Install tap to capture audio with optimized buffer size for low latency
        // Reduced from 4096 to 1024 frames for lower latency (64ms at 16kHz)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            guard let self = self, self.isRecording else { return }
            
            // Convert buffer to PCM16 data efficiently
            guard let channelData = buffer.int16ChannelData else { return }
            let channelDataValue = channelData.pointee
            let frameLength = Int(buffer.frameLength)
            
            // Use UnsafeBufferPointer for better performance
            let audioData = UnsafeBufferPointer(start: channelDataValue, count: frameLength)
            let audioArray = Array(audioData)
            
            // Send to JavaScript layer (smaller chunks = lower latency)
            self.notifyListeners("audioData", data: [
                "data": audioArray.map { Int($0) }
            ])
        }
    }
    
    private func stopRecording() {
        isRecording = false
        inputNode?.removeTap(onBus: 0)
        audioEngine?.stop()
        websocketTask?.cancel()
    }
    
    @objc func onPartialTranscript(_ call: CAPPluginCall) {
        // Store callback for partial transcripts
        // This would be called from WebSocket message handler
        call.resolve()
    }
    
    @objc func onFinalTranscript(_ call: CAPPluginCall) {
        // Store callback for final transcripts
        // This would be called from WebSocket message handler
        call.resolve()
    }
    
    @objc func onAudioPlayback(_ call: CAPPluginCall) {
        // Store callback for audio playback
        // This would handle received audio chunks from OpenAI
        call.resolve()
    }
}

