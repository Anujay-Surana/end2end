import SwiftUI

struct VoicePrepView: View {
    @StateObject private var voiceService = VoiceService.shared
    @State private var transcript = ""
    @State private var isFinal = false
    
    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Spacer()
                
                // Recording indicator
                if voiceService.isRecording {
                    VStack(spacing: 16) {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 60))
                            .foregroundColor(.red)
                        
                        Text("Recording...")
                            .font(.headline)
                    }
                } else {
                    Image(systemName: "mic")
                        .font(.system(size: 60))
                        .foregroundColor(.gray)
                }
                
                // Transcript
                if !transcript.isEmpty {
                    ScrollView {
                        Text(transcript)
                            .font(.body)
                            .padding()
                    }
                    .frame(maxHeight: 200)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(10)
                }
                
                Spacer()
                
                // Control buttons
                HStack(spacing: 24) {
                    Button(action: {
                        Task {
                            if voiceService.isRecording {
                                await voiceService.stop()
                            } else {
                                do {
                                    try await voiceService.start()
                                } catch {
                                    print("Error starting voice recording: \(error)")
                                }
                            }
                        }
                    }) {
                        HStack {
                            Image(systemName: voiceService.isRecording ? "stop.fill" : "play.fill")
                            Text(voiceService.isRecording ? "Stop" : "Start")
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(voiceService.isRecording ? Color.red : Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                    }
                }
                .padding()
            }
            .navigationTitle("Voice Prep")
            .onAppear {
                setupCallbacks()
            }
        }
    }
    
    private func setupCallbacks() {
        voiceService.onTranscript = { text, final in
            Task { @MainActor in
                transcript = text
                isFinal = final
            }
        }
    }
}

