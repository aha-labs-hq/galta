import Foundation

func fixtureHealth(_ state: RuntimeHealth.Installation.State, available: Bool = true) -> RuntimeHealth {
    RuntimeHealth(version: "0.1.1", releaseId: "native-preview", channel: "development",
                  runtime: .init(available: available, version: "0.154.0", error: available ? nil : "The bundled runtime could not start."),
                  installation: .init(state: state, detail: state == .repairRequired ? "Browser registration needs repair." : state == .conflict ? "This Mac is registered to a different Galta extension. Use the matching Mac app." : nil),
                  mcpCommand: state == .current && available ? "/preview/Galta/current/Resources/galta-mcp" : nil)
}

actor FixtureRuntime: RuntimeRunning {
    var health: RuntimeHealth
    var commands: [RuntimeCommand] = []
    var fail = false
    var delay: Duration = .zero
    init(_ health: RuntimeHealth) { self.health = health }
    func configure(fail: Bool = false, delay: Duration = .zero) { self.fail = fail; self.delay = delay }
    func run(_ command: RuntimeCommand, directory: URL) async throws -> RuntimeHealth {
        commands.append(command)
        try await Task.sleep(for: delay)
        if fail { throw NSError(domain: "Preview", code: 1, userInfo: [NSLocalizedDescriptionKey: "The runtime process could not finish. No registration was changed."]) }
        if command == .install { health = fixtureHealth(.current) }
        return health
    }
}
