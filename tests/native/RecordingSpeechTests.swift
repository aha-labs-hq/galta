import Foundation

@main
enum RecordingSpeechTests {
    static func main() {
        let word = SpeechWord(text: "original", start: 1, end: 2, confidence: 0.3)
        var result = SpeechAccumulator()
        result.accept(SpeechWindow(text: "unstable", words: [word]), stable: false)
        precondition(result.words.isEmpty)
        result.accept(SpeechWindow(text: "original", words: [word]), stable: true)
        result.accept(SpeechWindow(text: "", words: []), stable: true)
        precondition(result.text == "original")
        result.accept(SpeechWindow(text: "revision", words: [word]), stable: true)
        precondition(result.windows.count == 1 && result.text == "revision")
        result.accept(SpeechWindow(text: "next", words: [SpeechWord(text: "next", start: 3, end: 4, confidence: 1)]), stable: true)
        precondition(result.words.count == 2 && result.words[1].start == 3)
        precondition(abs(result.confidence - 0.65) < 0.001)
        var segmented = SpeechAccumulator()
        segmented.accept(SpeechWindow(text: "two words", words: [
            SpeechWord(text: "two", start: 0, end: 1, confidence: 0.8),
            SpeechWord(text: "words", start: 1, end: 3, confidence: 0.2)
        ]), stable: true)
        precondition(abs(segmented.confidence - 0.4) < 0.001)
        let bridge = SpeechWord(text: "here enlarge", start: 1, end: 5, confidence: 0.3, spans: [SpeechSpan(start: 1, end: 1.5), SpeechSpan(start: 4.5, end: 5)])
        let early = SpeechRepair(span: SpeechSpan(start: 0.9, end: 1.6), words: [SpeechWord(text: "here", start: 1.1, end: 1.4, confidence: 0.5)])
        let late = SpeechRepair(span: SpeechSpan(start: 4.4, end: 5.1), words: [SpeechWord(text: "enlarge", start: 4.6, end: 4.9, confidence: 0.6)])
        precondition(mergeSpeechRepairs([bridge], repairs: [early]).map(\.text) == ["here enlarge"])
        precondition(mergeSpeechRepairs([bridge], repairs: [early, late]).map(\.text) == ["here", "enlarge"])
        let missing = SpeechRepair(span: SpeechSpan(start: 1.9, end: 3.1), words: [SpeechWord(text: "also here", start: 2, end: 3, confidence: 0.5)])
        precondition(mergeSpeechRepairs(early.words, repairs: [missing]).count == 2)
        let partial = SpeechWord(text: "keep the rest", start: 1, end: 3, confidence: 0.5)
        precondition(mergeSpeechRepairs([partial], repairs: [early]).map(\.text) == ["keep the rest"])
        print("Speech completion windows, empty final and overlapping revisions: passed")
    }
}
