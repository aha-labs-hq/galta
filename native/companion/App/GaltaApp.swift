import SwiftUI
import Sparkle
import Darwin

@main
struct GaltaApp: App {
    @NSApplicationDelegateAdaptor(CompanionApplicationDelegate.self) private var appDelegate
    @State private var installation = InstallationModel()
    @State private var browsers: BrowserModel
    @Environment(\.scenePhase) private var scenePhase
    private let updater: SPUStandardUpdaterController
    private let updatesConfigured: Bool

    init() {
        if CommandLine.arguments.contains("--verify-bundle") { exit(0) }
        updatesConfigured = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String != nil
        updater = SPUStandardUpdaterController(startingUpdater: updatesConfigured, updaterDelegate: nil, userDriverDelegate: nil)
        guard let canvas = BrowserLauncher.bundledExtensionId().flatMap(BrowserLauncher.canvas) else { preconditionFailure("Missing bundled Galta release") }
        _browsers = State(initialValue: BrowserModel(canvas: canvas))
    }

    var body: some Scene {
        Window("Galta", id: "setup") {
            SetupView(model: installation, browsers: browsers)
                .task { await installation.start() }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(.presented)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await installation.becameActive() } }
        }
        .commands {
            CompanionCommands(model: installation, updatesConfigured: updatesConfigured, checkForUpdates: { updater.checkForUpdates(nil) })
        }
        Window("Connection Details", id: "connection") {
            ConnectionDetailsView(model: installation, updatesConfigured: updatesConfigured, checkForUpdates: { updater.checkForUpdates(nil) })
        }
        .defaultSize(width: 480, height: 520)
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(.suppressed)

        CompanionMenuBar(model: installation, browsers: browsers, updatesConfigured: updatesConfigured, checkForUpdates: { updater.checkForUpdates(nil) })
    }
}
