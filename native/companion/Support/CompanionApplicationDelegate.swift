import AppKit

/// Adding a menu extra must preserve Galta's normal Dock and window behavior.
final class CompanionApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
