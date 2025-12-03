import SwiftUI

/// Volume Unit (VU) meter view showing audio level
/// Supports both linear and circular styles
struct VUMeterView: View {
    let level: Float // 0.0 - 1.0
    let isActive: Bool
    var style: VUMeterStyle = .linear
    var activeColor: Color = .green
    var warningColor: Color = .yellow
    var peakColor: Color = .red
    var inactiveColor: Color = .gray.opacity(0.3)
    var showPeakHold: Bool = true
    
    @State private var peakLevel: Float = 0
    @State private var peakHoldTimer: Timer?
    
    var body: some View {
        Group {
            switch style {
            case .linear:
                linearMeter
            case .circular:
                circularMeter
            case .arc:
                arcMeter
            case .segmented:
                segmentedMeter
            }
        }
        .onChange(of: level) { newLevel in
            updatePeakLevel(newLevel)
        }
    }
    
    // MARK: - Linear Meter
    
    private var linearMeter: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // Background
                RoundedRectangle(cornerRadius: 4)
                    .fill(inactiveColor)
                
                // Level bar
                RoundedRectangle(cornerRadius: 4)
                    .fill(levelGradient)
                    .frame(width: geometry.size.width * CGFloat(isActive ? level : 0))
                    .animation(.easeOut(duration: 0.1), value: level)
                
                // Peak hold indicator
                if showPeakHold && isActive && peakLevel > 0 {
                    Rectangle()
                        .fill(colorForLevel(peakLevel))
                        .frame(width: 3)
                        .offset(x: geometry.size.width * CGFloat(peakLevel) - 1.5)
                        .animation(.easeOut(duration: 0.05), value: peakLevel)
                }
            }
        }
    }
    
    private var levelGradient: LinearGradient {
        LinearGradient(
            colors: [activeColor, warningColor, peakColor],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
    
    // MARK: - Circular Meter
    
    private var circularMeter: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let lineWidth: CGFloat = size * 0.12
            
            ZStack {
                // Background circle
                Circle()
                    .stroke(inactiveColor, lineWidth: lineWidth)
                
                // Level arc
                Circle()
                    .trim(from: 0, to: CGFloat(isActive ? level : 0))
                    .stroke(
                        AngularGradient(
                            colors: [activeColor, warningColor, peakColor],
                            center: .center,
                            startAngle: .degrees(0),
                            endAngle: .degrees(360)
                        ),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.1), value: level)
                
                // Center label
                VStack(spacing: 2) {
                    Text("\(Int(level * 100))")
                        .font(.system(size: size * 0.25, weight: .bold, design: .rounded))
                        .foregroundColor(isActive ? .primary : .secondary)
                    
                    Text("dB")
                        .font(.system(size: size * 0.1))
                        .foregroundColor(.secondary)
                }
            }
            .frame(width: size, height: size)
            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
        }
    }
    
    // MARK: - Arc Meter
    
    private var arcMeter: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let lineWidth: CGFloat = size * 0.08
            
            ZStack {
                // Background arc
                ArcShape(startAngle: -150, endAngle: 150)
                    .stroke(inactiveColor, lineWidth: lineWidth)
                
                // Level arc
                ArcShape(startAngle: -150, endAngle: -150 + 300 * Double(isActive ? level : 0))
                    .stroke(
                        LinearGradient(
                            colors: [activeColor, warningColor, peakColor],
                            startPoint: .leading,
                            endPoint: .trailing
                        ),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .animation(.easeOut(duration: 0.1), value: level)
                
                // Needle indicator
                if isActive {
                    NeedleShape()
                        .fill(colorForLevel(level))
                        .frame(width: 4, height: size * 0.35)
                        .offset(y: -size * 0.15)
                        .rotationEffect(.degrees(-150 + 300 * Double(level)))
                        .animation(.easeOut(duration: 0.1), value: level)
                }
            }
            .frame(width: size, height: size * 0.7)
            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
        }
    }
    
    // MARK: - Segmented Meter
    
    private var segmentedMeter: some View {
        GeometryReader { geometry in
            let segmentCount = 20
            let spacing: CGFloat = 2
            let segmentWidth = (geometry.size.width - spacing * CGFloat(segmentCount - 1)) / CGFloat(segmentCount)
            
            HStack(spacing: spacing) {
                ForEach(0..<segmentCount, id: \.self) { index in
                    let threshold = Float(index) / Float(segmentCount)
                    let isLit = isActive && level > threshold
                    
                    RoundedRectangle(cornerRadius: 2)
                        .fill(isLit ? colorForSegment(index, total: segmentCount) : inactiveColor)
                        .frame(width: segmentWidth)
                        .animation(.easeOut(duration: 0.05), value: isLit)
                }
            }
        }
    }
    
    // MARK: - Helpers
    
    private func colorForLevel(_ level: Float) -> Color {
        if level > 0.9 {
            return peakColor
        } else if level > 0.7 {
            return warningColor
        } else {
            return activeColor
        }
    }
    
    private func colorForSegment(_ index: Int, total: Int) -> Color {
        let position = Float(index) / Float(total)
        if position > 0.9 {
            return peakColor
        } else if position > 0.7 {
            return warningColor
        } else {
            return activeColor
        }
    }
    
    private func updatePeakLevel(_ newLevel: Float) {
        if newLevel > peakLevel {
            peakLevel = newLevel
            
            // Reset peak hold timer
            peakHoldTimer?.invalidate()
            peakHoldTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { _ in
                withAnimation(.easeOut(duration: 0.3)) {
                    peakLevel = 0
                }
            }
        }
    }
}

// MARK: - VU Meter Styles

enum VUMeterStyle {
    case linear
    case circular
    case arc
    case segmented
}

// MARK: - Helper Shapes

struct ArcShape: Shape {
    let startAngle: Double
    let endAngle: Double
    
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(startAngle),
            endAngle: .degrees(endAngle),
            clockwise: false
        )
        
        return path
    }
}

struct NeedleShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        
        path.move(to: CGPoint(x: rect.midX, y: 0))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        
        return path
    }
}

// MARK: - Pulsing Indicator

/// Pulsing audio indicator (like Siri)
struct PulsingAudioIndicator: View {
    let isActive: Bool
    let level: Float
    var activeColor: Color = .blue
    var inactiveColor: Color = .gray.opacity(0.3)
    
    @State private var isPulsing = false
    
    var body: some View {
        ZStack {
            // Outer pulse rings
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .stroke(activeColor.opacity(0.3), lineWidth: 2)
                    .scaleEffect(isPulsing && isActive ? 1 + CGFloat(level) * 0.5 * CGFloat(index + 1) / 3 : 1)
                    .opacity(isPulsing && isActive ? 0.3 - Double(index) * 0.1 : 0)
                    .animation(
                        .easeInOut(duration: 0.8)
                        .repeatForever(autoreverses: true)
                        .delay(Double(index) * 0.2),
                        value: isPulsing
                    )
            }
            
            // Center circle
            Circle()
                .fill(isActive ? activeColor : inactiveColor)
                .scaleEffect(isActive ? 1 + CGFloat(level) * 0.2 : 1)
                .animation(.easeOut(duration: 0.1), value: level)
        }
        .onAppear {
            isPulsing = true
        }
    }
}

// MARK: - Previews

#Preview("Linear VU Meter") {
    VUMeterView(level: 0.7, isActive: true, style: .linear)
        .frame(height: 20)
        .padding()
}

#Preview("Circular VU Meter") {
    VUMeterView(level: 0.7, isActive: true, style: .circular)
        .frame(width: 120, height: 120)
        .padding()
}

#Preview("Arc VU Meter") {
    VUMeterView(level: 0.7, isActive: true, style: .arc)
        .frame(width: 150, height: 100)
        .padding()
}

#Preview("Segmented VU Meter") {
    VUMeterView(level: 0.7, isActive: true, style: .segmented)
        .frame(height: 30)
        .padding()
}

#Preview("Pulsing Indicator") {
    PulsingAudioIndicator(isActive: true, level: 0.5)
        .frame(width: 80, height: 80)
        .padding()
}

