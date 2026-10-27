import Foundation
import Observation

@MainActor @Observable
final class InstallationModel {
    enum Phase: Equatable { case checking, moveToApplications, connect, ready, update, repair, unavailable, conflict, failed }
    enum Operation { case checking, connecting, updating, repairing
        var label: String {
            switch self {
            case .checking: "Checking this Mac…"
            case .connecting: "Connecting your browser…"
            case .updating: "Updating the connection…"
            case .repairing: "Repairing the connection…"
            }
        }
    }
    private(set) var health: RuntimeHealth?
    private(set) var operation: Operation?
    private(set) var error: String?
    let inApplications: Bool
    private let directory: URL
    private let runtime: any RuntimeRunning
    private let preferences: UserDefaults
    private var started = false

    init(directory: URL = Bundle.main.bundleURL.appendingPathComponent("Contents"),
         inApplications: Bool? = nil, runtime: any RuntimeRunning = RuntimeProcess(), preferences: UserDefaults = .standard) {
        self.directory = directory
        self.runtime = runtime
        self.preferences = preferences
        let parent = directory.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL.path
        self.inApplications = inApplications ?? (parent == "/Applications" || parent == FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path)
    }

    var phase: Phase {
        if error != nil { return .failed }
        guard let health else { return .checking }
        guard health.runtime.available else { return .unavailable }
        if health.installation.state == .conflict { return .conflict }
        if health.installation.state == .unavailable { return .unavailable }
        if health.installation.state == .current { return .ready }
        guard inApplications else { return .moveToApplications }
        switch health.installation.state {
        case .absent: return .connect
        case .updateAvailable: return .update
        case .repairRequired: return .repair
        case .current: return .ready
        case .conflict: return .conflict
        case .unavailable: return .unavailable
        }
    }
    var diagnostic: String? { error ?? health?.runtime.error ?? health?.installation.detail }
    var canConnect: Bool { operation == nil && [.connect, .update, .repair].contains(phase) }
    var mcpCommand: String? { phase == .ready && operation == nil ? health?.mcpCommand : nil }

    /// A previously authorized update activates once at launch. Focus changes only inspect.
    func start() async {
        guard !started else { return }
        started = true
        await refresh()
        if phase == .update && preferences.bool(forKey: "browserConnectionRequested") { await connect() }
    }

    func refresh() async {
        guard operation == nil else { return }
        operation = .checking
        defer { operation = nil }
        do { health = try await runtime.run(.inspect, directory: directory); error = nil }
        catch { self.health = nil; self.error = error.localizedDescription }
    }

    func becameActive() async {
        guard started else { return }
        await refresh()
    }

    func connect() async {
        guard canConnect else { return }
        operation = phase == .repair ? .repairing : phase == .update ? .updating : .connecting
        error = nil
        defer { operation = nil }
        do {
            health = try await runtime.run(.install, directory: directory)
            guard health?.installation.state == .current, health?.runtime.available == true else {
                throw NSError(domain: "Galta", code: 1, userInfo: [NSLocalizedDescriptionKey: "The runtime did not confirm a complete installation."])
            }
            preferences.set(true, forKey: "browserConnectionRequested")
        } catch { self.health = nil; self.error = error.localizedDescription }
    }
}
