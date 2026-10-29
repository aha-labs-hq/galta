import SwiftUI

struct SetupView: View {
    let model: InstallationModel
    let browsers: BrowserModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: CompanionStyle.contentSpacing) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable().frame(width: CompanionStyle.iconSize, height: CompanionStyle.iconSize)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Galta").font(CompanionStyle.heading)
                    HStack(spacing: 6) {
                        Text(model.statusTitle).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if model.phase == .checking || model.visibleOperation != nil {
                            ProgressView().controlSize(.mini).accessibilityHidden(true)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .gesture(WindowDragGesture())
            .allowsWindowActivationEvents(true)
            .padding(.bottom, CompanionStyle.sectionSpacing)

            VStack(alignment: .leading, spacing: CompanionStyle.contentSpacing) {
                if let message {
                    Text(message).foregroundStyle(.secondary).lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                action
                if let browserError = browsers.error {
                    Text(browserError).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityLabel("Browser could not open. \(browserError)")
                }
            }
        }
        .padding(CompanionStyle.padding)
        .frame(width: CompanionStyle.width)
        .fixedSize(horizontal: false, vertical: true)
        .containerBackground(.thickMaterial, for: .window)
        .onAppear { browsers.refreshInstalled() }
    }

    @ViewBuilder private var action: some View {
        if model.showsBrowserActions {
            VStack(spacing: CompanionStyle.controlSpacing) {
                ForEach(browsers.installed) { browser in
                    Button {
                        Task { await browsers.open(browser) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(nsImage: browser.icon).resizable().frame(width: 28, height: 28)
                            Text("Open in \(browser.name)").font(.body.weight(.medium))
                            Spacer()
                            if browsers.opening == browser.id { ProgressView().controlSize(.small) }
                        }.padding(.horizontal, 6).padding(.vertical, 6).contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered).controlSize(.large)
                    .disabled(browsers.opening != nil)
                    .help("Open your Galta canvas in \(browser.name).")
                }
                if browsers.installed.isEmpty { Text("Use Galta in Google Chrome or Dia.").font(.callout).foregroundStyle(.secondary) }
                Link("Get the browser extension", destination: BrowserLauncher.extensionDownload)
                    .font(.callout)
                    .help("Install Galta in the browser profile you want to use.")
            }
        } else if [.connect, .update, .repair].contains(model.phase) {
            Button(actionTitle) { Task { await model.connect() } }
                .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
                .disabled(!model.canConnect)
        } else if model.phase == .moveToApplications {
            Button("Show Galta in Finder") { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
                .buttonStyle(.borderedProminent).controlSize(.large)
        } else if model.phase == .failed {
            HStack(spacing: CompanionStyle.contentSpacing) {
                Button("Check again") { Task { await model.refresh() } }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(model.operation != nil)
                // Why it failed is in Connection Details, also at ⌘,.
                Button("Details") { openWindow(id: "connection") }
                    .buttonStyle(.link).help("Open connection details (⌘,).")
            }
        } else if [.unavailable, .conflict].contains(model.phase) {
            Button("View connection details") { openWindow(id: "connection") }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
    }

    /// Only what the title and the action don't already say. A ready home
    /// needs none: its buttons name the browsers they open.
    private var message: String? {
        switch model.phase {
        case .checking, .ready: nil
        case .moveToApplications: "Then open Galta from there."
        case .connect: "Let the agents on this Mac work with Galta in your browser. Your canvases stay there."
        case .update, .repair: "Your canvases and conversations stay in place."
        case .unavailable: "Galta’s runtime couldn’t start."
        case .conflict: "This app doesn’t match the installed connection."
        case .failed: "The connection couldn’t be checked or changed."
        }
    }
    private var actionTitle: String {
        switch model.phase {
        case .repair: "Repair connection"
        case .update: "Update connection"
        default: "Connect browser"
        }
    }
}
