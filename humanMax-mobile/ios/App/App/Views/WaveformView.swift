import SwiftUI

/// Animated audio waveform visualization
/// Displays real-time audio amplitude as animated bars
struct WaveformView: View {
    let samples: [Float]
    let isActive: Bool
    var barColor: Color = .blue
    var inactiveColor: Color = .gray.opacity(0.3)
    var barSpacing: CGFloat = 2
    var cornerRadius: CGFloat = 2
    var minBarHeight: CGFloat = 4
    
    @State private var animatedSamples: [Float] = []
    
    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: barSpacing) {
                ForEach(0..<displaySamples.count, id: \.self) { index in
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(isActive ? barColor : inactiveColor)
                        .frame(
                            width: barWidth(for: geometry.size.width, count: displaySamples.count),
                            height: barHeight(for: displaySamples[index], maxHeight: geometry.size.height)
                        )
                        .animation(.easeOut(duration: 0.1), value: displaySamples[index])
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
        .onChange(of: samples) { newSamples in
            withAnimation(.easeOut(duration: 0.08)) {
                animatedSamples = newSamples
            }
        }
        .onAppear {
            animatedSamples = samples
        }
    }
    
    private var displaySamples: [Float] {
        animatedSamples.isEmpty ? samples : animatedSamples
    }
    
    private func barWidth(for totalWidth: CGFloat, count: Int) -> CGFloat {
        let totalSpacing = barSpacing * CGFloat(count - 1)
        return max(2, (totalWidth - totalSpacing) / CGFloat(count))
    }
    
    private func barHeight(for sample: Float, maxHeight: CGFloat) -> CGFloat {
        let height = CGFloat(sample) * maxHeight
        return max(minBarHeight, min(maxHeight, height))
    }
}

/// Circular waveform visualization (alternative style)
struct CircularWaveformView: View {
    let samples: [Float]
    let isActive: Bool
    var activeColor: Color = .blue
    var inactiveColor: Color = .gray.opacity(0.3)
    var lineWidth: CGFloat = 3
    
    var body: some View {
        GeometryReader { geometry in
            let radius = min(geometry.size.width, geometry.size.height) / 2 - lineWidth
            
            ZStack {
                // Base circle
                Circle()
                    .stroke(inactiveColor, lineWidth: lineWidth)
                
                // Waveform circle
                if isActive {
                    WaveformShape(samples: samples, radius: radius)
                        .stroke(activeColor, lineWidth: lineWidth)
                        .animation(.easeOut(duration: 0.1), value: samples)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

/// Shape for circular waveform
struct WaveformShape: Shape {
    let samples: [Float]
    let radius: CGFloat
    
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        
        guard !samples.isEmpty else {
            path.addEllipse(in: rect.insetBy(dx: rect.width/2 - radius, dy: rect.height/2 - radius))
            return path
        }
        
        let angleStep = (2 * .pi) / CGFloat(samples.count)
        
        for (index, sample) in samples.enumerated() {
            let angle = CGFloat(index) * angleStep - .pi / 2
            let sampleRadius = radius * (1 + CGFloat(sample) * 0.3)
            let x = center.x + sampleRadius * cos(angle)
            let y = center.y + sampleRadius * sin(angle)
            
            if index == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        
        path.closeSubpath()
        return path
    }
}

/// Mirrored waveform (shows above and below center line)
struct MirroredWaveformView: View {
    let samples: [Float]
    let isActive: Bool
    var barColor: Color = .blue
    var inactiveColor: Color = .gray.opacity(0.3)
    var barSpacing: CGFloat = 1
    var cornerRadius: CGFloat = 1
    
    var body: some View {
        GeometryReader { geometry in
            let barCount = samples.count
            let totalSpacing = barSpacing * CGFloat(barCount - 1)
            let barWidth = max(2, (geometry.size.width - totalSpacing) / CGFloat(barCount))
            let halfHeight = geometry.size.height / 2
            
            ZStack {
                // Center line
                Rectangle()
                    .fill(inactiveColor)
                    .frame(height: 1)
                
                // Bars
                HStack(spacing: barSpacing) {
                    ForEach(0..<samples.count, id: \.self) { index in
                        let height = CGFloat(samples[index]) * halfHeight
                        
                        VStack(spacing: 0) {
                            // Top bar
                            RoundedRectangle(cornerRadius: cornerRadius)
                                .fill(isActive ? barColor : inactiveColor)
                                .frame(width: barWidth, height: max(1, height))
                            
                            // Bottom bar (mirror)
                            RoundedRectangle(cornerRadius: cornerRadius)
                                .fill(isActive ? barColor : inactiveColor)
                                .frame(width: barWidth, height: max(1, height))
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Previews

#Preview("Bar Waveform") {
    WaveformView(
        samples: (0..<32).map { _ in Float.random(in: 0.1...1.0) },
        isActive: true,
        barColor: .blue
    )
    .frame(height: 60)
    .padding()
}

#Preview("Circular Waveform") {
    CircularWaveformView(
        samples: (0..<64).map { _ in Float.random(in: 0.1...1.0) },
        isActive: true
    )
    .frame(width: 150, height: 150)
    .padding()
}

#Preview("Mirrored Waveform") {
    MirroredWaveformView(
        samples: (0..<64).map { _ in Float.random(in: 0.1...1.0) },
        isActive: true
    )
    .frame(height: 80)
    .padding()
}

