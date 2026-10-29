import SwiftUI

/// Test-only host. It compiles the shipping views; it never installs a runtime.
@main struct CompanionPreview: App {
    @NSApplicationDelegateAdaptor(CompanionApplicationDelegate.self) private var appDelegate
    @State private var model = InstallationModel(inApplications: true, runtime: FixtureRuntime(fixtureHealth(.current)))
    // The preview opens the canvas of the extension ID its build script recorded.
    private static let canvas = (Bundle.main.object(forInfoDictionaryKey: "GaltaPreviewExtensionID") as? String).flatMap(BrowserLauncher.canvas)!
    @State private var browsers = BrowserModel(canvas: canvas)
    var body: some Scene {
        Window("Galta Preview", id: "setup") {
            SetupView(model: model, browsers: browsers).task {
                // `-GaltaPreviewState <name>` and `-GaltaPreviewAppearance light|dark` open one
                // state in the background, for window captures that leave the screen alone.
                let launch = UserDefaults.standard
                switch launch.string(forKey: "GaltaPreviewAppearance") {
                case "light": NSApp.appearance = NSAppearance(named: .aqua)
                case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
                default: break
                }
                if let name = launch.string(forKey: "GaltaPreviewState") { await select(name); return }
                NSApp.activate(ignoringOtherApps: true)
                await model.refresh()
            }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(.presented)
        .commands {
            CompanionCommands(model: model, updatesConfigured: false, checkForUpdates: {})
            // A second native presentation of the shipping menu supports
            // acceptance tools that expose app menus but not menu extras.
            CommandMenu("Menu Bar Preview") {
                CompanionMenu(model: model, browsers: browsers, updatesConfigured: false, checkForUpdates: {})
            }
            CommandMenu("Preview") {
                Button("Bring Preview Forward") { NSApp.activate(ignoringOtherApps: true) }
                Divider()
                ForEach(["Ready", "First connection", "Update", "Repair", "Unavailable", "Conflict", "Move to Applications", "Checking", "Connecting", "Updating", "Repairing", "Failure"], id: \.self) { name in
                    Button(name) { Task { await select(name) } }
                }
                Divider()
                Button("Light appearance") { NSApp.appearance = NSAppearance(named: .aqua) }
                Button("Dark appearance") { NSApp.appearance = NSAppearance(named: .darkAqua) }
                Button("High contrast light") { NSApp.appearance = NSAppearance(named: .accessibilityHighContrastAqua) }
                Button("High contrast dark") { NSApp.appearance = NSAppearance(named: .accessibilityHighContrastDarkAqua) }
                Divider()
                Button("Browser open failure") {
                    browsers = BrowserModel(installed: BrowserLauncher.installed(), launch: { _ in
                        throw NSError(domain: "Preview", code: 1, userInfo: [NSLocalizedDescriptionKey: "Browser launch fixture failure"])
                    })
                }
                Button("Restore browser launcher") { browsers = BrowserModel(canvas: Self.canvas) }
            }
        }
        Window("Connection Details · Preview", id: "connection") {
            ConnectionDetailsView(model: model, updatesConfigured: false, checkForUpdates: {})
        }.defaultSize(width: 480, height: 520).windowResizability(.contentSize).defaultLaunchBehavior(.suppressed)
        CompanionMenuBar(model: model, browsers: browsers, updatesConfigured: false, checkForUpdates: {})
    }
    @MainActor private func select(_ name: String) async {
        let states: [String: RuntimeHealth.Installation.State] = ["Ready": .current, "First connection": .absent, "Update": .updateAvailable, "Repair": .repairRequired, "Unavailable": .absent, "Conflict": .conflict, "Move to Applications": .absent, "Connecting": .absent, "Updating": .updateAvailable, "Repairing": .repairRequired]
        let runtime = FixtureRuntime(fixtureHealth(states[name] ?? .current, available: name != "Unavailable"))
        await runtime.configure(fail: name == "Failure", delay: name == "Checking" ? .seconds(30) : .milliseconds(250))
        model = InstallationModel(inApplications: name != "Move to Applications", runtime: runtime)
        await model.refresh()
        if ["Connecting", "Updating", "Repairing"].contains(name) {
            await runtime.configure(delay: .seconds(30))
            await model.connect()
        }
    }
}
