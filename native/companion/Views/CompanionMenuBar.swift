import SwiftUI

/// The shipping app and isolated preview use the same native menu scene.
struct CompanionMenuBar: Scene {
    let model: InstallationModel
    let browsers: BrowserModel
    let updatesConfigured: Bool
    let checkForUpdates: () -> Void

    var body: some Scene {
        MenuBarExtra {
            CompanionMenu(model: model, browsers: browsers, updatesConfigured: updatesConfigured, checkForUpdates: checkForUpdates)
        } label: {
            Image(nsImage: CompanionStyle.menuBarIcon)
                .accessibilityLabel("Galta")
                .help("Galta")
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in
                    browsers.refreshInstalled()
                }
        }
        .menuBarExtraStyle(.menu)
    }
}

struct CompanionMenu: View {
    let model: InstallationModel
    let browsers: BrowserModel
    let updatesConfigured: Bool
    let checkForUpdates: () -> Void
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Section {
            if model.showsBrowserActions {
                ForEach(browsers.installed) { browser in
                    Button {
                        Task {
                            if !(await browsers.open(browser)), browsers.error != nil { showWindow("setup") }
                        }
                    } label: {
                        Label {
                            Text("Open in \(browser.name)")
                        } icon: {
                            browserImage(browser)
                        }
                    }
                    .disabled(browsers.opening != nil)
                }
                Link("Get Browser Extension…", destination: BrowserLauncher.extensionDownload)
                Divider()
            }
            Button(model.phase.menuActionTitle) { showWindow("setup") }
                .keyboardShortcut("o")
            Button("Connection Details…") { showWindow("connection") }
                .keyboardShortcut(",")
            Button("Check Connection") { Task { await model.refresh() } }
                .keyboardShortcut("r")
                .disabled(model.operation != nil)
        } header: {
            Text(model.statusTitle)
        }
        Divider()
        if updatesConfigured { Button("Check for Updates…", action: checkForUpdates) }
        Button("Quit Galta") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func showWindow(_ id: String) {
        openWindow(id: id)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func browserImage(_ browser: InstalledBrowser) -> Image {
        let image = browser.icon.copy() as! NSImage
        image.size = CompanionStyle.menuItemIconSize
        return Image(nsImage: image)
    }
}
