import SwiftUI

struct ConnectionDetailsView: View {
    let model: InstallationModel
    let updatesConfigured: Bool
    let checkForUpdates: () -> Void
    @State private var copiedConfiguration = false
    @State private var copiedDiagnostics = false
    @State private var copyError: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("App runtime", value: model.health.map { $0.runtime.available ? "Available" : "Unavailable" } ?? (model.operation != nil ? "Checking…" : "Not checked"))
                LabeledContent("Installation", value: registration)
                if let codex = model.health?.codex { LabeledContent("Codex for Chat in Galta", value: Self.describe(codex)) }
                Text("Your browser checks its connection when you open Galta. Manage agent sign-in from the canvas. You can close the Mac window and keep creating.")
                    .font(.callout).foregroundStyle(.secondary)
                Button(model.operation?.label ?? "Check connection") { Task { await model.refresh() } }
                    .disabled(model.operation != nil)
            } header: { Text("On this Mac") }

            Section {
                Text("Use the same canvas tools in any app that supports MCP. Add this configuration in that app’s settings.")
                    .font(.callout).foregroundStyle(.secondary)
                Button(copiedConfiguration ? "Configuration copied" : "Copy MCP configuration") { copyConfiguration() }
                    .disabled(model.mcpCommand == nil)
            } header: { Text("Other agents") }

            Section {
                LabeledContent("Version", value: version)
                if updatesConfigured { Button("Check for Updates…", action: checkForUpdates) }
                else { Text("Local build · Updates are installed manually.").font(.callout).foregroundStyle(.secondary) }
            } header: { Text("Updates") }

            if let diagnostic = model.diagnostic {
                Section {
                    Text(diagnostic).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(copiedDiagnostics ? "Details copied" : "Copy diagnostic details") { copyDiagnostics(diagnostic) }
                } header: { Text("What happened") }
            }
            if let copyError { Text(copyError).font(.callout).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .frame(minWidth: 440, idealWidth: 480, maxWidth: 600, minHeight: 460, idealHeight: 520)
        .task(id: copiedConfiguration) {
            guard copiedConfiguration else { return }
            do { try await Task.sleep(for: .seconds(2)); copiedConfiguration = false } catch { }
        }
        .task(id: copiedDiagnostics) {
            guard copiedDiagnostics else { return }
            do { try await Task.sleep(for: .seconds(2)); copiedDiagnostics = false } catch { }
        }
    }

    /// The build number names the exact local build; the version alone repeats across builds.
    private var version: String {
        let version = model.health?.version ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        guard let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String else { return version }
        return "\(version) (\(build))"
    }
    /// Galta uses the user's own Codex, or downloads one when asked in the browser.
    static func describe(_ codex: RuntimeHealth.Codex) -> String {
        switch codex.state {
        case "ready": "\(codex.version ?? "Ready")\(codex.source == "yours" ? " · yours" : codex.source == "galta" ? " · Galta’s copy" : "")"
        case "downloading": "Downloading…"
        case "failed": "Download didn’t finish · try again from Galta’s Settings in your browser"
        case "outdated": "Update needed · download it from Galta’s Settings in your browser"
        default: "Not installed · download it from Galta’s Settings in your browser"
        }
    }

    private var registration: String {
        guard let health = model.health else { return model.operation != nil ? "Checking…" : "Not checked" }
        return switch health.installation.state {
        case .absent: "Not connected"
        case .current: "Registered on this Mac"
        case .updateAvailable: "Update available"
        case .repairRequired: "Needs repair"
        case .conflict: "Different installation"
        case .unavailable: "Runtime unavailable"
        }
    }
    private func copyConfiguration() {
        guard let command = model.mcpCommand else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: ["mcpServers": ["galta": ["command": command, "args": []] as [String: Any]]], options: [.prettyPrinted, .sortedKeys])
            guard let text = String(data: data, encoding: .utf8) else { return }
            copiedConfiguration = copy(text)
        } catch { copyError = "The configuration couldn’t be copied. Try again." }
    }
    private func copyDiagnostics(_ diagnostic: String) {
        let text = "Galta \(version)\nRelease: \(model.health?.releaseId ?? "unknown")\nState: \(model.health?.installation.state.rawValue ?? "unavailable")\n\(diagnostic)"
        copiedDiagnostics = copy(text.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
    }
    private func copy(_ text: String) -> Bool {
        NSPasteboard.general.clearContents()
        let success = NSPasteboard.general.setString(text, forType: .string)
        copyError = success ? nil : "The clipboard is unavailable. Try again."
        return success
    }
}
