import Foundation

extension InstallationModel {
    /// Keep a healthy foreground inspection quiet on both the home and menu.
    var visibleOperation: Operation? { phase == .ready ? nil : operation }
    var statusTitle: String { visibleOperation?.label ?? phase.statusTitle }
    var showsBrowserActions: Bool { phase == .checking || phase == .ready }
}

extension InstallationModel.Phase {
    var statusTitle: String {
        switch self {
        case .checking: "Checking this Mac…"
        case .moveToApplications: "Move to Applications"
        case .connect: "Connect your browser"
        case .ready: "Ready on this Mac"
        case .update: "Connection update available"
        case .repair: "Connection needs repair"
        case .unavailable, .conflict: "Connection needs attention"
        case .failed: "Couldn’t finish"
        }
    }

    /// Menu actions open the home, where connection changes remain explicit.
    var menuActionTitle: String {
        switch self {
        case .connect: "Connect Browser…"
        case .update: "Update Connection…"
        case .repair: "Repair Connection…"
        case .moveToApplications: "Finish Setup…"
        case .unavailable, .conflict, .failed: "Review Connection…"
        case .checking, .ready: "Open Galta…"
        }
    }
}
