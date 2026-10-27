import AppKit
import Observation

/// Browser actions share their in-flight and failure state across the home and menu.
@MainActor @Observable
final class BrowserModel {
    private(set) var installed: [InstalledBrowser]
    private(set) var opening: String?
    private(set) var error: String?
    private let launch: (InstalledBrowser) async throws -> Void

    /// Each browser action opens this Galta canvas page.
    convenience init(canvas: URL) {
        self.init(installed: BrowserLauncher.installed(), launch: { try await BrowserLauncher.open($0, canvas: canvas) })
    }

    init(installed: [InstalledBrowser], launch: @escaping (InstalledBrowser) async throws -> Void) {
        self.installed = installed
        self.launch = launch
    }

    func refreshInstalled() { installed = BrowserLauncher.installed() }

    @discardableResult
    func open(_ browser: InstalledBrowser) async -> Bool {
        guard opening == nil else { return false }
        opening = browser.id
        error = nil
        defer { opening = nil }
        do { try await launch(browser); return true }
        catch {
            self.error = "Couldn’t open Galta in \(browser.name). Open \(browser.name), then choose Galta in its toolbar."
            return false
        }
    }
}
