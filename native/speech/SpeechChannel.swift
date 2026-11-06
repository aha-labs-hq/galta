import Foundation
import Darwin

/** Launch Services gives speech its own privacy identity. A private local
 * socket carries one bounded request and closes immediately on cancellation. */
enum SpeechChannel {
    static func connect(_ path: String) throws -> FileHandle {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [UInt8(0)]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw CocoaError(.fileReadInvalidFileName) }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        let status = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard status == 0 else { Darwin.close(descriptor); throw POSIXError(.ECONNREFUSED) }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
    static func request(_ channel: FileHandle) throws -> Data {
        func read(_ count: Int) throws -> Data {
            var data = Data()
            while data.count < count {
                guard let chunk = try channel.read(upToCount: count - data.count), !chunk.isEmpty else { throw POSIXError(.ECONNRESET) }
                data.append(chunk)
            }
            return data
        }
        let header = try read(4)
        let count = header.enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
        guard count > 0, count <= 2_700_000 else { throw CocoaError(.fileReadTooLarge) }
        return try read(count)
    }
}
