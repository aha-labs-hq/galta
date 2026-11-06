import Foundation

@main
enum GaltaSpeech {
    static func main() {
        if CommandLine.arguments.contains("--verify-bundle") { exit(0) }
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--transcribe-recording" else { exit(64) }
        RecordingSpeech.run(socketPath: CommandLine.arguments[2])
    }
}
