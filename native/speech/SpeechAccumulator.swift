import Foundation

struct SpeechWord {
    var text: String
    let start: Double
    let end: Double
    let confidence: Float
    var spans: [SpeechSpan]? = nil
}

/// Replace a cross-pause hypothesis only when every part has a completed
/// local recognition. Partial repairs must not erase the unrepaired words.
struct SpeechRepair { let span: SpeechSpan; let words: [SpeechWord] }
func mergeSpeechRepairs(_ original: [SpeechWord], repairs: [SpeechRepair]) -> [SpeechWord] {
    func overlaps(_ word: SpeechWord, _ repair: SpeechRepair) -> Bool { word.start < repair.span.end && word.end > repair.span.start }
    let retained = original.filter { word in
        !(word.spans ?? [SpeechSpan(start: word.start, end: word.end)]).allSatisfy { span in
            repairs.contains { $0.span.start <= span.start + 0.0001 && $0.span.end >= span.end - 0.0001 }
        }
    }
    return (retained + repairs.filter { repair in !retained.contains { overlaps($0, repair) } }.flatMap(\.words)).sorted { $0.start < $1.start }
}
struct SpeechWindow {
    let text: String
    let words: [SpeechWord]
    var start: Double { words.first?.start ?? 0 }
    var end: Double { words.last?.end ?? 0 }
}

// Legacy Apple Speech can complete several utterances before an empty final
// callback. Only accept results carrying completion metadata or a final flag;
// volatile token timestamps are placeholders, not alignment evidence.
struct SpeechAccumulator {
    private(set) var windows: [SpeechWindow] = []
    mutating func accept(_ window: SpeechWindow, stable: Bool) {
        guard stable, !window.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !window.words.isEmpty, window.end > window.start else { return }
        // A revision replaces the audio range it covers. A cumulative final
        // result can replace several prior ranges without duplicating words.
        windows.removeAll { $0.start < window.end && window.start < $0.end }
        windows.append(window)
        windows.sort { $0.start < $1.start }
    }
    var confidence: Double {
        let weight = words.reduce(0.0) { $0 + max(0, $1.end - $1.start) }
        guard weight > 0 else { return 0 }
        return words.reduce(0.0) { $0 + Double($1.confidence) * max(0, $1.end - $1.start) } / weight
    }
    var text: String { windows.map(\.text).joined(separator: "\n") }
    var words: [SpeechWord] {
        windows.enumerated().flatMap { i, window in
            window.words.enumerated().map { j, word in
                var word = word
                if i > 0 && j == 0 { word.text = "\n" + word.text }
                return word
            }
        }
    }
}
