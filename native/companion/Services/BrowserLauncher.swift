import AppKit

struct InstalledBrowser: Identifiable {
    let id: String
    let name: String
    let url: URL
    var icon: NSImage { NSWorkspace.shared.icon(forFile: url.path) }
}

@MainActor
enum BrowserLauncher {
    /// The website owns store availability and installation instructions.
    static let extensionDownload = URL(string: "https://galta.art/download/")!

    static func installed() -> [InstalledBrowser] {
        [("com.google.Chrome", "Google Chrome"), ("company.thebrowser.dia", "Dia")].compactMap { id, name in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { InstalledBrowser(id: id, name: name, url: $0) }
        }
    }

    /// The full canvas page of the extension this app serves.
    nonisolated static func canvas(extensionId: String) -> URL? {
        guard extensionId.range(of: "^[a-p]{32}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "chrome-extension://\(extensionId)/canvas/index.html")
    }

    /// The extension ID recorded in the app's bundled release, which the runtime also serves.
    nonisolated static func bundledExtensionId(contents: URL = Bundle.main.bundleURL.appendingPathComponent("Contents")) -> String? {
        struct Release: Decodable { let extensionId: String }
        guard let data = try? Data(contentsOf: contents.appendingPathComponent("Resources/release.json")) else { return nil }
        return try? JSONDecoder().decode(Release.self, from: data).extensionId
    }

    /// Open the Galta canvas in the browser. macOS launches the browser when it is
    /// not running; the browser shows the page in a new window when it has none,
    /// otherwise in a new tab of its front window, in its last used profile.
    /// The side panel stays one toolbar click away: Chrome opens an extension's
    /// side panel only in response to a user action inside the browser.
    static func open(_ browser: InstalledBrowser, canvas: URL) async throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        try await NSWorkspace.shared.open([canvas], withApplicationAt: browser.url, configuration: configuration)
    }
}
