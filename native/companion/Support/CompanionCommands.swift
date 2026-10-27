import SwiftUI

struct CompanionCommands: Commands {
    let model: InstallationModel
    let updatesConfigured: Bool
    let checkForUpdates: () -> Void
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Connection Details…") { openWindow(id: "connection") }.keyboardShortcut(",")
            Button("Check for Updates…", action: checkForUpdates).disabled(!updatesConfigured)
        }
        CommandMenu("Connection") {
            Button("Check Connection") { Task { await model.refresh() } }
                .keyboardShortcut("r").disabled(model.operation != nil)
        }
    }
}
