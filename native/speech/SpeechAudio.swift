import Foundation

struct SpeechSpan {
    let start: Double
    let end: Double
    var json: [String: Double] { ["start": start, "end": end] }
}

/// Short pointing utterances lose context across long pauses in legacy Speech.
/// Compact only quiet gaps for recognition, preserving PCM and an exact sample
/// map. Energy is an activity observation, not a speech/intent classifier.
struct SpeechAudio {
    struct Region { let start: Int; var end: Int; var outputStart: Int }
    let samples: [Float]
    let activity: [SpeechSpan]
    let regions: [Region]
    let sampleRate: Double
    let removedSilence: Double

    init(samples source: [Float], sampleRate: Double) {
        self.sampleRate = sampleRate
        let hop = max(1, Int(sampleRate * 0.02))
        let energy = stride(from: 0, to: source.count, by: hop).map { start in
            let end = min(source.count, start + hop)
            let mean = source[start..<end].reduce(0.0) { $0 + Double($1) * Double($1) } / Double(end - start)
            return 10 * log10(max(1e-12, mean))
        }
        let ordered = energy.sorted()
        let floor = ordered.isEmpty ? -120 : ordered[ordered.count / 5]
        let foreground = ordered.isEmpty ? -120 : ordered[min(ordered.count - 1, ordered.count * 95 / 100)]
        let threshold = min(-35.0, max(-65.0, floor + 12, foreground - 20))
        var runs: [(start: Int, end: Int, peak: Double)] = []
        for (i, db) in energy.enumerated() where db >= threshold - 6 {
            if let last = runs.last, i - last.end <= 10 {
                runs[runs.count - 1] = (last.start, i + 1, max(last.peak, db))
            } else { runs.append((i, i + 1, db)) }
        }
        let active = runs.filter { $0.peak >= threshold && $0.end - $0.start >= 5 }
        activity = active.map { SpeechSpan(start: Double($0.start * hop) / sampleRate, end: Double(min(source.count, $0.end * hop)) / sampleRate) }
        let padding = Int(sampleRate * 0.35)
        var kept: [Region] = []
        for run in active {
            let start = max(0, run.start * hop - padding), end = min(source.count, run.end * hop + padding)
            if let last = kept.last, start <= last.end { kept[kept.count - 1].end = max(last.end, end) }
            else { kept.append(Region(start: start, end: end, outputStart: 0)) }
        }
        // No evidence of activity, or negligible savings: retain the full audio.
        if kept.isEmpty || source.count - kept.reduce(0, { $0 + $1.end - $1.start }) < Int(sampleRate * 0.5) {
            kept = [Region(start: 0, end: source.count, outputStart: 0)]
        }
        var output: [Float] = []; output.reserveCapacity(source.count)
        for i in kept.indices { kept[i].outputStart = output.count; output.append(contentsOf: source[kept[i].start..<kept[i].end]) }
        regions = kept; samples = output
        removedSilence = Double(source.count - output.count) / sampleRate
    }

    func originalSpans(start: Double, end: Double) -> [SpeechSpan] {
        guard start.isFinite, end.isFinite, end > start else { return [] }
        return regions.compactMap { region in
            let from = Double(region.outputStart) / sampleRate
            let to = from + Double(region.end - region.start) / sampleRate
            let a = max(start, from), b = min(end, to)
            guard b > a else { return nil }
            let offset = Double(region.start - region.outputStart) / sampleRate
            return SpeechSpan(start: a + offset, end: b + offset)
        }
    }
}
