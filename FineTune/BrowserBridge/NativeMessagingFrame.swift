// FineTune/BrowserBridge/NativeMessagingFrame.swift
import Foundation

enum NativeMessagingFrameError: Error, Equatable {
    case frameTooLarge(Int)
}

/// Chrome native messaging framing: a 4-byte native-endian (little-endian on every
/// supported Mac) length, then that many bytes of UTF-8 JSON.
enum NativeMessagingFrame {
    static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        return Data(bytes: &length, count: 4) + payload
    }
}

/// Reassembles frames from an arbitrarily chunked byte stream.
struct NativeMessagingFrameReader {
    /// Chrome caps host→extension messages at 1 MiB; we use the same bound both ways.
    static let defaultMaxFrameSize = 1_048_576

    private var buffer = Data()
    private let maxFrameSize: Int

    init(maxFrameSize: Int = defaultMaxFrameSize) {
        self.maxFrameSize = maxFrameSize
    }

    mutating func append(_ bytes: some DataProtocol) throws -> [Data] {
        buffer.append(contentsOf: bytes)
        var frames: [Data] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) }
            guard length <= maxFrameSize else { throw NativeMessagingFrameError.frameTooLarge(length) }
            guard buffer.count >= 4 + length else { break }
            frames.append(Data(buffer.dropFirst(4).prefix(length)))
            buffer = Data(buffer.dropFirst(4 + length))
        }
        return frames
    }
}
