import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fatalError("Usage: swift scripts/render-icons.swift <extension-icon-directory> <app-iconset-directory>")
}

let extensionDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let iconsetDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let logo = sourceRoot.appendingPathComponent("apps/extension/src/public/galta-logo.svg")
// Generated from the approved outline by render-brand-assets.ts. Keep the
// browser PNG independent from Codex's dark-host composer icon.
let extensionLogo = sourceRoot.appendingPathComponent("plugins/galta/assets/browser-icon.svg")
guard let logoImage = NSImage(contentsOf: logo), let extensionLogoImage = NSImage(contentsOf: extensionLogo) else {
    fatalError("Unable to load Galta logo assets")
}
let tokens = try String(contentsOf: sourceRoot.appendingPathComponent("apps/extension/src/design/tokens.css"), encoding: .utf8)
func token(_ name: String) -> String {
    guard let value = tokens.components(separatedBy: "\(name):").dropFirst().first?.components(separatedBy: ";").first else { fatalError("Missing design token: \(name)") }
    return value.trimmingCharacters(in: .whitespacesAndNewlines)
}
func color(_ name: String) -> NSColor {
    let value = token(name)
    guard value.hasPrefix("#"), value.count == 7, let rgb = UInt32(value.dropFirst(), radix: 16) else { fatalError("Expected a hex color: \(name)") }
    return NSColor(calibratedRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
}
try FileManager.default.createDirectory(at: extensionDirectory, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: iconsetDirectory, withIntermediateDirectories: true)

func render(_ size: Int, to url: URL, image: NSImage, withPlate: Bool) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot create icon bitmap") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()
    if withPlate {
        let inset = CGFloat(size) * 0.035
        let square = NSRect(x: inset, y: inset, width: CGFloat(size) - 2 * inset, height: CGFloat(size) - 2 * inset)
        color("--background").setFill()
        NSBezierPath(roundedRect: square, xRadius: CGFloat(size) * 0.21, yRadius: CGFloat(size) * 0.21).fill()
    }
    // The tightly cropped artwork owns its proportions. The outline already
    // includes breathing room; only the native app's plate needs another inset.
    let markScale = withPlate ? 0.8 : 1.0
    let factor = CGFloat(size) * markScale / max(image.size.width, image.size.height)
    let markSize = NSSize(width: image.size.width * factor, height: image.size.height * factor)
    let markRect = NSRect(
        x: (CGFloat(size) - markSize.width) / 2,
        y: (CGFloat(size) - markSize.height) / 2,
        width: markSize.width,
        height: markSize.height
    )
    image.draw(in: markRect, from: NSRect(origin: .zero, size: image.size), operation: .sourceOver, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode icon") }
    try data.write(to: url)
}

for size in [16, 32, 48, 128] {
    // Browser-owned identity is the black outline over its white backing,
    // without a tile or face.
    try render(size, to: extensionDirectory.appendingPathComponent("\(size).png"), image: extensionLogoImage, withPlate: false)
}
for (name, size) in [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
] { try render(size, to: iconsetDirectory.appendingPathComponent(name), image: logoImage, withPlate: true) }
