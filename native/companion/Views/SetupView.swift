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
                Text(message).foregroundStyle(.secondary).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                action
                if let browserError = browsers.error {
                    Text(browserError).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityLabel("Browser could not open. \(browserError)")
                }
            }

            Spacer(minLength: CompanionStyle.sectionSpacing)

            Button { openWindow(id: "connection") } label: {
                HStack(spacing: 4) {
                    Text("Connection details")
                    Image(systemName: "chevron.right").imageScale(.small)
                }
                .font(.callout).foregroundStyle(.secondary)
                .padding(.vertical, 6).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .help("Open connection details (⌘,).")
        }
        .padding(CompanionStyle.padding)
        .frame(width: CompanionStyle.width)
        .frame(minHeight: CompanionStyle.minimumHeight)
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
                            else { Image(systemName: "arrow.up.forward").foregroundStyle(.secondary) }
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
            Button("Check again") { Task { await model.refresh() } }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(model.operation != nil)
        } else if [.unavailable, .conflict].contains(model.phase) {
            Button("View connection details") { openWindow(id: "connection") }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
    }

    private var message: String {
        switch model.phase {
        case .checking, .ready: "Open your canvas in a browser with the Galta extension installed."
        case .moveToApplications: "Drag the app into Applications, then open it there to finish setup."
        case .connect: "Let the agents on this Mac work with Galta in your browser. Your canvases stay in your browser."
        case .update: "A new connection is ready to install. Your canvases and active work stay in place."
        case .repair: "The browser connection needs a repair. Your canvases and conversations stay in place."
        case .unavailable: "Galta’s runtime couldn’t start. Check the details before connecting."
        case .conflict: "This app doesn’t match the installed connection. Check the details to find the next step."
        case .failed: "The connection couldn’t be checked or changed. Check again, or open the details for help."
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
