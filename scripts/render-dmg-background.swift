import AppKit
import Foundation

// The disk image's install window: Galta asks, in galta.art's handwriting, to
// be dragged in, an arrow says where and a loop chooses Applications
// (`distribution/install-window.svg`, drawn with galta.art's pen).
// It lies on the product's paper and grain from the design tokens, at 1x and
// 2x. The drawing says where Finder puts the two icons; the packager reads
// that from layout.json.
guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: swift scripts/render-dmg-background.swift <output-directory>")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let tokens = try String(contentsOf: sourceRoot.appendingPathComponent("apps/extension/src/design/tokens.css"), encoding: .utf8)
func token(_ name: String) -> String {
    guard let value = tokens.components(separatedBy: "\(name):").dropFirst().first?.components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces),
          !value.isEmpty else { fatalError("Missing design token: \(name)") }
    return value
}
func color(_ name: String) -> NSColor {
    let value = token(name)
    guard value.hasPrefix("#"), value.count == 7, let rgb = UInt32(value.dropFirst(), radix: 16) else { fatalError("Expected a hex color: \(name)") }
    return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
}

let drawingURL = sourceRoot.appendingPathComponent("distribution/install-window.svg")
let drawingSource = try String(contentsOf: drawingURL, encoding: .utf8)
guard let drawing = NSImage(contentsOf: drawingURL) else { fatalError("Unable to load \(drawingURL.path)") }
func numbers(_ attribute: String, count: Int) -> [CGFloat] {
    let value = drawingSource.components(separatedBy: " \(attribute)=\"").dropFirst().first?.components(separatedBy: "\"").first ?? ""
    let parsed = value.split(separator: " ").compactMap { Double($0) }.map { CGFloat($0) }
    guard parsed.count == count else { fatalError("install-window.svg needs \(count) numbers in \(attribute)") }
    return parsed
}
let width = numbers("width", count: 1)[0], height = numbers("height", count: 1)[0]
let app = numbers("data-app", count: 2), applications = numbers("data-applications", count: 2)

// The paper's grain is the token itself: an SVG tile of fractal noise through a
// colour matrix. Finder's SVG renderer has no filters, so the tile is made
// here, as SVG's feTurbulence reference defines it, from the token's numbers.
let grainPrefix = "url(\"data:image/svg+xml,", grainToken = token("--paper-grain")
guard grainToken.hasPrefix(grainPrefix), grainToken.hasSuffix("\")"),
      let grainSource = String(grainToken.dropFirst(grainPrefix.count).dropLast(2)).removingPercentEncoding else {
    fatalError("Expected --paper-grain to be an SVG data URL")
}
func grainValue(_ attribute: String) -> String {
    guard let value = grainSource.components(separatedBy: "\(attribute)='").dropFirst().first?.components(separatedBy: "'").first else {
        fatalError("--paper-grain has no \(attribute)")
    }
    return value
}
guard grainValue("type") == "fractalNoise", grainValue("stitchTiles") == "stitch",
      let grainSize = Double(grainValue("width")), Double(grainValue("height")) == grainSize,
      let frequency = Double(grainValue("baseFrequency")), let octaves = Int(grainValue("numOctaves")),
      Double(token("--paper-grain-size").replacingOccurrences(of: "px", with: "")) == grainSize else {
    fatalError("Expected a square, stitched fractalNoise --paper-grain drawn at its own size")
}
let matrix = grainValue("values").split(separator: " ").compactMap { Double($0) }
guard matrix.count == 20 else { fatalError("Expected a 4 × 5 colour matrix in --paper-grain") }

struct Turbulence {
    private var lattice = [Int](repeating: 0, count: 514), gradient = [[[Double]]](repeating: [[Double]](repeating: [0, 0], count: 514), count: 4)
    init(seed: Int) {
        var s = seed <= 0 ? -(seed % 2147483646) + 1 : min(seed, 2147483646)
        func random() -> Int { s = 16807 * (s % 127773) - 2836 * (s / 127773); if s <= 0 { s += 2147483647 }; return s }
        for k in 0..<4 {
            for i in 0..<256 {
                lattice[i] = i
                let x = Double(random() % 512 - 256) / 256, y = Double(random() % 512 - 256) / 256, n = (x * x + y * y).squareRoot()
                gradient[k][i] = [x / n, y / n]
            }
        }
        for i in stride(from: 255, to: 0, by: -1) { let j = random() % 256; lattice.swapAt(i, j) }
        for i in 0..<258 { lattice[256 + i] = lattice[i]; for k in 0..<4 { gradient[k][256 + i] = gradient[k][i] } }
    }
    /// One channel of fractal noise at `point`, stitched to a tile at `origin` of `size`.
    func fractal(_ channel: Int, _ point: (Double, Double), frequency base: Double, octaves: Int, origin: Double, size: Double) -> Double {
        let lo = (size * base).rounded(.down) / size, hi = (size * base).rounded(.up) / size
        let f = base / lo < hi / base ? lo : hi
        var width = Int(size * f + 0.5), wrap = Int(origin * f + 4096 + Double(width))
        var x = point.0 * f, y = point.1 * f, ratio = 1.0, sum = 0.0
        for _ in 0..<octaves {
            let tx = x + 4096, ty = y + 4096, ix = Int(tx), iy = Int(ty)
            // A square tile wraps both axes alike.
            let stitch = { (v: Int) in (v >= wrap ? v - width : v) & 255 }
            let bx0 = stitch(ix), bx1 = stitch(ix + 1), by0 = stitch(iy), by1 = stitch(iy + 1)
            let rx0 = tx - Double(ix), ry0 = ty - Double(iy), rx1 = rx0 - 1, ry1 = ry0 - 1
            let i = lattice[bx0], j = lattice[bx1]
            let q = { (b: Int, rx: Double, ry: Double) in rx * gradient[channel][b][0] + ry * gradient[channel][b][1] }
            let sx = rx0 * rx0 * (3 - 2 * rx0), sy = ry0 * ry0 * (3 - 2 * ry0)
            let a = q(lattice[i + by0], rx0, ry0) + sx * (q(lattice[j + by0], rx1, ry0) - q(lattice[i + by0], rx0, ry0))
            let b = q(lattice[i + by1], rx0, ry1) + sx * (q(lattice[j + by1], rx1, ry1) - q(lattice[i + by1], rx0, ry1))
            sum += (a + sy * (b - a)) / ratio
            x *= 2; y *= 2; ratio *= 2; width *= 2; wrap = 2 * wrap - 4096
        }
        return sum
    }
}

/// The grain's ink, black at the colour matrix's alpha, for each pixel of one tile at `scale`.
func grainTile(scale: CGFloat) -> (side: Int, alpha: [UInt8]) {
    let noise = Turbulence(seed: 0), side = Int(grainSize * Double(scale)), origin = -grainSize * 0.1, region = grainSize * 1.2
    var alpha = [UInt8](repeating: 0, count: side * side)
    for py in 0..<side {
        for px in 0..<side {
            let point = ((Double(px) + 0.5) / Double(scale), (Double(py) + 0.5) / Double(scale))
            let rgba = (0..<4).map { min(1, max(0, (noise.fractal($0, point, frequency: frequency, octaves: octaves, origin: origin, size: region) + 1) / 2)) }
            let a = matrix[15] * rgba[0] + matrix[16] * rgba[1] + matrix[17] * rgba[2] + matrix[18] * rgba[3] + matrix[19]
            alpha[py * side + px] = UInt8((min(1, max(0, a)) * 255).rounded())
        }
    }
    return (side, alpha)
}

func render(scale: CGFloat, to url: URL) throws {
    let pixelsWide = Int(width * scale), pixelsHigh = Int(height * scale)
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8,
                                        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot create the background bitmap") }
    bitmap.size = NSSize(width: width, height: height) // points, so a 2x bitmap reads as Retina
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    context.cgContext.scaleBy(x: scale, y: scale) // draw in points

    color("--background").setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    drawing.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    context.flushGraphics()
    // Over everything, as on the site: tiled from the top left.
    let (side, alpha) = grainTile(scale: scale)
    guard let pixels = bitmap.bitmapData else { fatalError("Cannot read the background bitmap") }
    for row in 0..<pixelsHigh {
        for column in 0..<pixelsWide {
            let a = Int(alpha[(row % side) * side + column % side]), offset = row * bitmap.bytesPerRow + column * 4
            for channel in 0..<3 { pixels[offset + channel] = UInt8(Int(pixels[offset + channel]) * (255 - a) / 255) }
        }
    }

    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode the background") }
    try png.write(to: url)
}

try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try render(scale: 1, to: output.appendingPathComponent("background.png"))
try render(scale: 2, to: output.appendingPathComponent("background@2x.png"))
let layout = ["width": width, "height": height, "app": app, "applications": applications] as [String: Any]
try JSONSerialization.data(withJSONObject: layout, options: [.sortedKeys]).write(to: output.appendingPathComponent("layout.json"))
