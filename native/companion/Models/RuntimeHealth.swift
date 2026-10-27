import Foundation

struct RuntimeHealth: Decodable, Sendable {
    struct Runtime: Decodable, Sendable { let available: Bool; let version: String?; let error: String? }
    struct Installation: Decodable, Sendable {
        enum State: String, Decodable, Sendable {
            case absent, current, updateAvailable = "update-available", repairRequired = "repair-required", conflict, unavailable
        }
        let state: State
        let detail: String?
    }
    let version: String
    let releaseId: String
    let channel: String
    let runtime: Runtime
    let installation: Installation
    let mcpCommand: String?
}

enum RuntimeCommand: String, Sendable { case inspect, install }
protocol RuntimeRunning: Sendable {
    func run(_ command: RuntimeCommand, directory: URL) async throws -> RuntimeHealth
}
