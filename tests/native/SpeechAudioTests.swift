import Foundation

@main
enum SpeechAudioTests {
    static func main() {
        let rate = 16_000.0
        var samples = [Float](repeating: 0.00001, count: 160_000)
        for range in [16_000..<20_800, 64_000..<70_400, 112_000..<124_800] {
            for i in range { samples[i] = Float(sin(Double(i) * 0.1)) * 0.1 }
        }
        let audio = SpeechAudio(samples: samples, sampleRate: rate)
        precondition(audio.activity.count == 3)
        precondition(audio.samples.count < samples.count / 2)
        // Every audible sample survives unchanged; no resampling or time stretch.
        for region in audio.regions {
            precondition(Array(audio.samples[region.outputStart..<(region.outputStart + region.end - region.start)]) == Array(samples[region.start..<region.end]))
        }
        for region in audio.regions {
            let t = Double(region.outputStart + 100) / rate
            let mapped = audio.originalSpans(start: t, end: t + 0.1)
            precondition(mapped.count == 1)
            precondition(abs(mapped[0].start - Double(region.start + 100) / rate) < 0.0001)
        }
        // A recognizer token crossing a removed pause keeps disjoint intervals.
        // Never distribute its characters evenly over the original silence.
        let join = Double(audio.regions[1].outputStart) / rate
        let split = audio.originalSpans(start: join - 0.1, end: join + 0.1)
        precondition(split.count == 2 && split[1].start - split[0].end > 1)
        let continuous = SpeechAudio(samples: [Float](repeating: 0.1, count: 32_000), sampleRate: rate)
        precondition(continuous.samples.count == 32_000 && continuous.regions.count == 1)
        let silence = SpeechAudio(samples: [Float](repeating: 0, count: 32_000), sampleRate: rate)
        precondition(silence.activity.isEmpty && silence.samples.count == 32_000)
        // A short quiet utterance is retained, as are its low-energy edges.
        var quiet = [Float](repeating: 0.000001, count: 32_000)
        for i in 16_000..<18_400 { quiet[i] = 0.002 }
        let whispered = SpeechAudio(samples: quiet, sampleRate: rate)
        precondition(whispered.activity.count == 1)
        precondition(whispered.samples.contains(0.002))
        print("Acoustic coverage, lossless retained samples, disjoint clock mapping, silence and quiet speech: passed")
    }
}
