import AppKit
import AVFoundation
import Speech

/** One bounded invocation; no microphone, persistent worker or model download.
 * Automatic selection compares Apple results for the Mac's configured languages.
 * Confidence is a ranking signal, not a guarantee of the user's intended words. */
final class RecordingSpeech {
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechURLRecognitionRequest?
    private var temporaryURL: URL?
    private var audioTimeline: SpeechAudio?
    private var sourceSamples: [Float] = []
    private var audioFormat: AVAudioFormat?
    private var primary: (String, SpeechAccumulator)?
    private var repairRegions: [SpeechAudio.Region] = []
    private var repairs: [SpeechRepair] = []
    private var transcript = SpeechAccumulator()
    private var candidates: [(String, SpeechAccumulator)] = []
    private var languages: [String] = []
    private var generation = 0
    private var deadline: DispatchWorkItem?
    private var finished = false
    private var termination: DispatchSourceSignal?
    private var channel: FileHandle?
    private var id = ""
    private var duration = 0.0

    static func run(socketPath: String) -> Never {
        let service = RecordingSpeech()
        signal(SIGTERM, SIG_IGN)
        service.termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        service.termination?.setEventHandler { service.fail("Recording cancelled.") }
        service.termination?.resume()
        NSApplication.shared.setActivationPolicy(.prohibited)
        let data: Data
        do {
            let channel = try SpeechChannel.connect(socketPath)
            service.channel = channel
            data = try SpeechChannel.request(channel)
            channel.readabilityHandler = { _ in DispatchQueue.main.async { service.fail("Recording cancelled.") } }
        } catch { service.fail("The recording connection closed."); exit(1) }
        guard data.count <= 2_700_000,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = input["id"] as? String, UUID(uuidString: id) != nil,
              let encoded = input["wav"] as? String, let audio = Data(base64Encoded: encoded),
              audio.count <= 1_920_044 else { service.fail("Invalid recording audio."); exit(1) }
        let supported = ["zh-CN", "en-US", "ja-JP", "ko-KR"]
        if let locale = input["locale"] as? String {
            guard supported.contains(locale) else { service.fail("Unsupported speech language."); exit(1) }
            service.languages = [locale]
        } else {
            for preferred in Locale.preferredLanguages {
                guard let locale = supported.first(where: { preferred.lowercased().hasPrefix(String($0.prefix(2))) }), !service.languages.contains(locale) else { continue }
                service.languages.append(locale)
            }
        }
        guard !service.languages.isEmpty else { service.fail("Apple Speech does not support this Mac’s configured languages."); exit(1) }
        service.id = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { service.fail("Could not process the recording in time. Your recording is saved; try sending again.") }
        service.start(audio)
        withExtendedLifetime(service) { RunLoop.main.run() }
        exit(1)
    }

    private func start(_ audio: Data) {
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("galta-speech-\(UUID().uuidString).wav")
            temporaryURL = url
            guard FileManager.default.createFile(atPath: url.path, contents: audio, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            let file = try AVAudioFile(forReading: url)
            duration = Double(file.length) / file.processingFormat.sampleRate
            guard duration > 0, duration <= 60.001, file.processingFormat.channelCount == 1, file.processingFormat.sampleRate == 16000 else { fail("Use a recording up to 60 seconds, mono 16 kHz PCM audio."); return }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { throw CocoaError(.fileReadCorruptFile) }
            try file.read(into: buffer)
            guard let samples = buffer.floatChannelData?[0] else { throw CocoaError(.fileReadCorruptFile) }
            sourceSamples = Array(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
            audioFormat = file.processingFormat
            let timeline = SpeechAudio(samples: sourceSamples, sampleRate: 16000)
            audioTimeline = timeline
            if timeline.removedSilence > 0 {
                buffer.frameLength = AVAudioFrameCount(timeline.samples.count)
                timeline.samples.withUnsafeBufferPointer { samples.update(from: $0.baseAddress!, count: $0.count) }
                let output = try AVAudioFile(forWriting: url, settings: file.fileFormat.settings)
                try output.write(from: buffer)
            }
            SFSpeechRecognizer.requestAuthorization { state in
                DispatchQueue.main.async {
                    guard !self.finished else { return }
                    guard state == .authorized else { self.fail("Allow Galta in System Settings → Privacy & Security → Speech Recognition, then send again."); return }
                    self.nextLanguage()
                }
            }
        } catch { fail("Could not open the recording audio: \(error.localizedDescription)") }
    }
    private func nextLanguage() {
        guard !finished else { return }
        guard !languages.isEmpty else {
            guard let best = candidates.max(by: { $0.1.confidence < $1.1.confidence }) else { fail("No speech was understood. Your recording is saved; try again or record another request."); return }
            primary = best
            let mapped = mappedWords(best.1.words)
            repairRegions = audioTimeline!.regions.filter { region in
                let start = Double(region.start) / 16000, end = Double(region.end) / 16000
                let activity = audioTimeline!.activity.filter { $0.start >= start && $0.end <= end }
                return activity.contains { span in
                    let covering = mapped.filter { $0.start < span.end && $0.end > span.start }
                    return covering.isEmpty || covering.contains { ($0.spans?.count ?? 1) > 1 }
                }
            }
            // Bounded second pass only for missing or cross-pause segments.
            // Unrepaired segments retain their uncertainty; never invent words.
            repairRegions = Array(repairRegions.prefix(12))
            nextRepair(); return
        }
        let locale = languages.removeFirst()
        recognize(locale: locale) { result in
            if let result, !result.text.isEmpty { self.candidates.append((locale, result)) }
            self.nextLanguage()
        }
    }
    private func mappedWords(_ words: [SpeechWord]) -> [SpeechWord] {
        words.compactMap { word in
            let spans = audioTimeline!.originalSpans(start: word.start, end: word.end)
            guard let first = spans.first, let last = spans.last else { return nil }
            return SpeechWord(text: word.text, start: first.start, end: last.end, confidence: word.confidence, spans: spans.count > 1 ? spans : nil)
        }
    }
    private func nextRepair() {
        guard !finished, let primary else { return }
        guard !repairRegions.isEmpty else {
            let merged = mergeSpeechRepairs(mappedWords(primary.1.words), repairs: repairs)
            guard !merged.isEmpty else { fail("No speech was understood. Your recording is saved; try again or record another request."); return }
            let text = merged.enumerated().map { i, word in
                (i > 0 && word.start - merged[i - 1].end > 0.5 ? "\n" : "") + word.text.trimmingCharacters(in: .newlines)
            }.joined()
            let words = merged.map { word -> [String: Any] in
                var value: [String: Any] = ["text": word.text, "start": word.start, "end": word.end, "confidence": word.confidence]
                if let spans = word.spans { value["spans"] = spans.map(\.json) }
                return value
            }
            var result: [String: Any] = ["ok": true, "id": id, "text": text, "words": words, "duration": duration, "provider": "apple", "onDevice": true, "locale": primary.0,
                "audio": ["activity": audioTimeline!.activity.map(\.json), "removedSilence": audioTimeline!.removedSilence]]
            if !repairs.isEmpty && text != primary.1.text { result["contextText"] = primary.1.text }
            finish(result); return
        }
        let region = repairRegions.removeFirst(), offset = Double(region.start) / 16000
        do {
            let samples = Array(sourceSamples[region.start..<region.end])
            guard let format = audioFormat, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)), let target = buffer.floatChannelData?[0] else { throw CocoaError(.fileReadCorruptFile) }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { target.update(from: $0.baseAddress!, count: $0.count) }
            let file = try AVAudioFile(forWriting: temporaryURL!, settings: format.settings)
            try file.write(from: buffer)
        } catch { nextRepair(); return }
        recognize(locale: primary.0, context: primary.1.text) { result in
            if let result, !result.words.isEmpty {
                let words = result.words.filter { $0.start >= 0 && $0.end <= Double(region.end - region.start) / 16000 + 0.05 }.map {
                    SpeechWord(text: $0.text, start: $0.start + offset, end: min(Double(region.end) / 16000, $0.end + offset), confidence: $0.confidence)
                }
                if !words.isEmpty { self.repairs.append(SpeechRepair(span: SpeechSpan(start: offset, end: Double(region.end) / 16000), words: words)) }
            }
            self.nextRepair()
        }
    }
    private func recognize(locale: String, context: String = "", completion: @escaping (SpeechAccumulator?) -> Void) {
        generation += 1; let current = generation
        deadline?.cancel(); task?.cancel(); task = nil; request = nil
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.supportsOnDeviceRecognition else { completion(nil); return }
        self.recognizer = recognizer; transcript = SpeechAccumulator()
        let request = SFSpeechURLRecognitionRequest(url: temporaryURL!)
        self.request = request
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        if !context.isEmpty { request.contextualStrings = [String(context.prefix(100))] }
        // A timeout is never used to promote partial speech into stable evidence.
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.finished, self.generation == current else { return }
            completion(nil)
        }
        self.deadline = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: deadline)
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.finished, self.generation == current else { return }
                if let result {
                    let best = result.bestTranscription, fullText = best.formattedString as NSString
                    let words = best.segments.enumerated().map { i, segment in
                        let from = i == 0 ? 0 : segment.substringRange.location
                        let to = i + 1 < best.segments.count ? best.segments[i + 1].substringRange.location : fullText.length
                        return SpeechWord(text: fullText.substring(with: NSRange(location: from, length: max(0, to - from))), start: segment.timestamp, end: segment.timestamp + segment.duration, confidence: segment.confidence)
                    }
                    self.transcript.accept(SpeechWindow(text: best.formattedString, words: words), stable: result.isFinal || (result.speechRecognitionMetadata?.speechDuration ?? 0) > 0)
                    if result.isFinal {
                        completion(self.transcript); return
                    }
                }
                if error != nil { completion(nil) }
            }
        }
    }
    private func fail(_ message: String) { finish(["ok": false, "error": message]) }
    private func finish(_ value: [String: Any]) {
        guard !finished else { return }; finished = true
        deadline?.cancel(); task?.cancel(); task = nil; request = nil
        if let url = temporaryURL { try? FileManager.default.removeItem(at: url) }
        channel?.readabilityHandler = nil
        if let data = try? JSONSerialization.data(withJSONObject: value) { try? channel?.write(contentsOf: data) }
        try? channel?.close(); channel = nil
        exit(0)
    }
}
