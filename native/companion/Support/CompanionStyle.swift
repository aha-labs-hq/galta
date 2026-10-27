import SwiftUI

/// Native semantic surfaces follow macOS appearance, contrast and transparency settings.
/// Keep the companion's small layout vocabulary together; web tokens remain in tokens.css.
enum CompanionStyle {
    static let menuItemIconSize = NSSize(width: 16, height: 16)
    @MainActor static let menuBarIcon: NSImage = {
        guard let url = Bundle.main.url(forResource: "MenuBarIcon", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { preconditionFailure("Missing bundled Galta menu bar icon") }
        image.size = NSSize(width: 18, height: 18 * image.size.height / image.size.width)
        image.isTemplate = true
        return image
    }()
    static let width: CGFloat = 400
    static let minimumHeight: CGFloat = 344
    static let padding: CGFloat = 28
    static let iconSize: CGFloat = 68
    static let sectionSpacing: CGFloat = 24
    static let contentSpacing: CGFloat = 16
    static let controlSpacing: CGFloat = 10
    static let heading = Font.system(size: 25, weight: .semibold)
}
