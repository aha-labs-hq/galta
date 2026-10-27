import Foundation

struct RuntimeProcess: RuntimeRunning {
    static let limitSeconds = 60

    func run(_ command: RuntimeCommand, directory: URL) async throws -> RuntimeHealth {
        try await Task.detached {
            let bytes = try Self.execute(command, directory: directory)
            do { return try JSONDecoder().decode(RuntimeHealth.self, from: bytes) }
            catch { throw Self.failure("The Galta runtime sent a reply this app can’t read. Install the complete Galta app again.") }
        }.value
    }

    private static func failure(_ message: String, code: Int = 1) -> NSError {
        NSError(domain: "Galta", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func execute(_ command: RuntimeCommand, directory: URL) throws -> Data {
        let process = Process(), output = Pipe()
        process.executableURL = directory.appendingPathComponent("Helpers/GaltaRuntime.app/Contents/MacOS/galta-runtime")
        process.arguments = [command.rawValue, directory.path]
        process.standardOutput = output
        // Keep stderr off the stdout pipe so either stream can drain independently.
        let diagnostic = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: diagnostic.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let errors = try FileHandle(forWritingTo: diagnostic)
        defer { try? errors.close(); try? FileManager.default.removeItem(at: diagnostic) }
        process.standardError = errors
        let started = ContinuousClock.now
        try process.run()
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(limitSeconds), execute: deadline)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit(); deadline.cancel()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            // The runtime reports its own failures as one line on stderr. A
            // runtime that stops without one still needs a readable cause.
            let detail = ((try? String(contentsOf: diagnostic, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let status = Int(process.terminationStatus)
            let cause = process.terminationReason == .uncaughtSignal
                ? ContinuousClock.now - started >= .seconds(limitSeconds) ? "The Galta runtime didn’t finish within \(limitSeconds) seconds." : "The Galta runtime stopped unexpectedly (signal \(status))."
                : detail.isEmpty ? "The Galta runtime stopped without a reason (exit status \(status))." : ""
            throw failure(String([cause, detail].filter { !$0.isEmpty }.joined(separator: "\n").prefix(1600)), code: status)
        }
        return data
    }
}
