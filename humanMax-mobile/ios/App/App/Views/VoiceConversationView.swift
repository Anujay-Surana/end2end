import SwiftUI

/// Main voice conversation view combining waveform, VU meter, and live captions
/// This is the primary UI for real-time voice interactions with Shadow
struct VoiceConversationView: View {
    @StateObject private var voiceService = VoiceService.shared
    @State private var isExpanded = false
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var transcriptHistory: [TranscriptMessage] = []
    
    var onDismiss: (() -> Void)?
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            header
            
            Divider()
            
            // Main content
            if isExpanded {
                expandedContent
            } else {
                compactContent
            }
            
            Divider()
            
            // Control bar
            controlBar
        }
        .background(Color(.systemBackground))
        .cornerRadius(20)
        .shadow(color: .black.opacity(0.15), radius: 10, x: 0, y: -5)
        .alert("Error", isPresented: $showError) {
            Button("OK") { }
        } message: {
            Text(errorMessage)
        }
        .onAppear {
            setupCallbacks()
        }
    }
    
    // MARK: - Header
    
    private var header: some View {
        HStack {
            // Connection status indicator
            HStack(spacing: 6) {
                Circle()
                    .fill(connectionStatusColor)
                    .frame(width: 8, height: 8)
                
                Text(voiceService.connectionStateDescription())
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Spacer()
            
            // Title
            Text("Voice Conversation")
                .font(.headline)
            
            Spacer()
            
            // Expand/collapse button
            Button(action: {
                withAnimation(.spring(response: 0.3)) {
                    isExpanded.toggle()
                }
            }) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                    .font(.title3)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }
    
    private var connectionStatusColor: Color {
        switch voiceService.connectionState {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .orange
        case .disconnected:
            return .gray
        case .failed:
            return .red
        }
    }
    
    // MARK: - Compact Content
    
    private var compactContent: some View {
        VStack(spacing: 16) {
            // Waveform or pulsing indicator
            HStack {
                if voiceService.isRecording {
                    MirroredWaveformView(
                        samples: voiceService.waveformSamples,
                        isActive: voiceService.isSpeaking || voiceService.isAssistantResponding,
                        barColor: voiceService.isSpeaking ? .blue : .green
                    )
                    .frame(height: 50)
                } else {
                    PulsingAudioIndicator(
                        isActive: false,
                        level: 0,
                        inactiveColor: .gray.opacity(0.3)
                    )
                    .frame(width: 50, height: 50)
                }
            }
            .padding(.horizontal)
            
            // Compact caption
            if !voiceService.partialTranscript.isEmpty || !voiceService.userTranscript.isEmpty || !voiceService.assistantTranscript.isEmpty {
                CompactCaptionView(
                    text: currentCaptionText,
                    isPartial: voiceService.isSpeaking || voiceService.isAssistantResponding,
                    source: voiceService.isAssistantResponding ? .assistant : .user
                )
                .padding(.horizontal)
            }
        }
        .padding(.vertical, 16)
    }
    
    private var currentCaptionText: String {
        if !voiceService.partialTranscript.isEmpty {
            return voiceService.partialTranscript
        } else if voiceService.isAssistantResponding && !voiceService.assistantTranscript.isEmpty {
            return voiceService.assistantTranscript
        } else if !voiceService.userTranscript.isEmpty {
            return voiceService.userTranscript
        }
        return ""
    }
    
    // MARK: - Expanded Content
    
    private var expandedContent: some View {
        VStack(spacing: 20) {
            // Circular VU meter with waveform
            HStack(spacing: 24) {
                // User VU meter
                VStack(spacing: 8) {
                    VUMeterView(
                        level: voiceService.inputLevel,
                        isActive: voiceService.isSpeaking,
                        style: .circular,
                        activeColor: .blue
                    )
                    .frame(width: 100, height: 100)
                    
                    Text("You")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                // Assistant VU meter
                VStack(spacing: 8) {
                    VUMeterView(
                        level: voiceService.outputLevel,
                        isActive: voiceService.isAssistantResponding,
                        style: .circular,
                        activeColor: .green
                    )
                    .frame(width: 100, height: 100)
                    
                    Text("Shadow")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(.top, 8)
            
            // Waveform
            WaveformView(
                samples: voiceService.waveformSamples,
                isActive: voiceService.isRecording,
                barColor: voiceService.isSpeaking ? .blue : (voiceService.isAssistantResponding ? .green : .gray)
            )
            .frame(height: 60)
            .padding(.horizontal)
            
            // Live captions
            LiveCaptionView(
                userTranscript: voiceService.userTranscript,
                assistantTranscript: voiceService.assistantTranscript,
                partialTranscript: voiceService.partialTranscript,
                isSpeaking: voiceService.isSpeaking,
                isAssistantResponding: voiceService.isAssistantResponding,
                maxHeight: 150
            )
            
            // Transcript history (if any)
            if !transcriptHistory.isEmpty {
                Divider()
                
                TranscriptHistoryView(messages: transcriptHistory)
                    .frame(maxHeight: 200)
            }
        }
        .padding(.vertical, 16)
    }
    
    // MARK: - Control Bar
    
    private var controlBar: some View {
        HStack(spacing: 24) {
            // Close button
            Button(action: {
                Task {
                    await voiceService.stop()
                    onDismiss?()
                }
            }) {
                Image(systemName: "xmark")
                    .font(.title2)
                    .foregroundColor(.secondary)
                    .frame(width: 44, height: 44)
            }
            
            Spacer()
            
            // Main action button
            Button(action: {
                Task {
                    await toggleRecording()
                }
            }) {
                ZStack {
                    Circle()
                        .fill(voiceService.isRecording ? Color.red : Color.blue)
                        .frame(width: 70, height: 70)
                    
                    if voiceService.isRecording {
                        // Recording - show stop icon
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.white)
                            .frame(width: 24, height: 24)
                    } else {
                        // Not recording - show mic icon
                        Image(systemName: "mic.fill")
                            .font(.title)
                            .foregroundColor(.white)
                    }
                }
            }
            .scaleEffect(voiceService.isSpeaking ? 1.1 : 1.0)
            .animation(.spring(response: 0.3), value: voiceService.isSpeaking)
            
            Spacer()
            
            // Stop AI response button
            Button(action: {
                Task {
                    try? await voiceService.sendStop()
                }
            }) {
                Image(systemName: "stop.fill")
                    .font(.title2)
                    .foregroundColor(voiceService.isAssistantResponding ? .red : .secondary.opacity(0.5))
                    .frame(width: 44, height: 44)
            }
            .disabled(!voiceService.isAssistantResponding)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }
    
    // MARK: - Actions
    
    private func toggleRecording() async {
        if voiceService.isRecording {
            await voiceService.stop()
        } else {
            do {
                try await voiceService.start()
            } catch {
                errorMessage = error.localizedDescription
                showError = true
            }
        }
    }
    
    // MARK: - Setup
    
    private func setupCallbacks() {
        // Track transcript history
        voiceService.onTranscript = { text, isFinal, source in
            if isFinal && !text.isEmpty {
                let message = TranscriptMessage(
                    text: text,
                    isUser: source == "user"
                )
                transcriptHistory.append(message)
            }
        }
        
        voiceService.onError = { error in
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

/// Floating voice button to trigger conversation
struct VoiceButton: View {
    @State private var showConversation = false
    @StateObject private var voiceService = VoiceService.shared
    
    var body: some View {
        Button(action: {
            showConversation = true
        }) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [.blue, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 60, height: 60)
                    .shadow(color: .blue.opacity(0.4), radius: 8, x: 0, y: 4)
                
                Image(systemName: "waveform")
                    .font(.title2)
                    .foregroundColor(.white)
            }
        }
        .sheet(isPresented: $showConversation) {
            VoiceConversationView(onDismiss: {
                showConversation = false
            })
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }
}

/// Mini voice indicator for inline use
struct MiniVoiceIndicator: View {
    @ObservedObject var voiceService = VoiceService.shared
    
    var body: some View {
        HStack(spacing: 8) {
            // Status indicator
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            
            // Mini waveform
            if voiceService.isRecording {
                HStack(spacing: 2) {
                    ForEach(0..<5, id: \.self) { index in
                        let sampleIndex = index * (voiceService.waveformSamples.count / 5)
                        let sample = voiceService.waveformSamples.indices.contains(sampleIndex) ? voiceService.waveformSamples[sampleIndex] : 0
                        
                        RoundedRectangle(cornerRadius: 1)
                            .fill(voiceService.isSpeaking ? Color.blue : Color.green)
                            .frame(width: 3, height: CGFloat(4 + sample * 12))
                            .animation(.easeOut(duration: 0.1), value: sample)
                    }
                }
            }
            
            // Status text
            Text(statusText)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.systemGray6))
        .cornerRadius(16)
    }
    
    private var statusColor: Color {
        if voiceService.isSpeaking {
            return .blue
        } else if voiceService.isAssistantResponding {
            return .green
        } else if voiceService.isRecording {
            return .orange
        }
        return .gray
    }
    
    private var statusText: String {
        if voiceService.isSpeaking {
            return "Listening..."
        } else if voiceService.isAssistantResponding {
            return "Responding..."
        } else if voiceService.isRecording {
            return "Ready"
        }
        return "Tap to start"
    }
}

// MARK: - Previews

#Preview("Voice Conversation") {
    VoiceConversationView()
        .frame(height: 500)
}

#Preview("Voice Button") {
    VoiceButton()
        .padding()
}

#Preview("Mini Indicator") {
    MiniVoiceIndicator()
        .padding()
}

