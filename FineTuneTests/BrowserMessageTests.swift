// FineTuneTests/BrowserMessageTests.swift
import Testing
import Foundation
@testable import FineTune

@Suite("BrowserMessage — versioned JSON codec")
struct BrowserMessageTests {

    private func json(_ text: String) -> Data { Data(text.utf8) }

    @Test("Decodes hello")
    func decodeHello() throws {
        let message = try BrowserMessage(
            decoding: json(#"{"v":1,"type":"hello","extensionVersion":"0.1.0","browser":"edge"}"#)
        )
        #expect(message == .hello(extensionVersion: "0.1.0", browser: "edge"))
    }

    @Test("Decodes ping and pong")
    func decodePingPong() throws {
        #expect(try BrowserMessage(decoding: json(#"{"v":1,"type":"ping"}"#)) == .ping)
        #expect(try BrowserMessage(decoding: json(#"{"v":1,"type":"pong"}"#)) == .pong)
    }

    @Test("Unknown type decodes to .unknown so newer peers don't break older ones")
    func unknownType() throws {
        let message = try BrowserMessage(decoding: json(#"{"v":1,"type":"tabSnapshot","tabs":[]}"#))
        #expect(message == .unknown(type: "tabSnapshot"))
    }

    @Test("Unsupported version throws")
    func unsupportedVersion() {
        #expect(throws: BrowserMessageError.unsupportedVersion(2)) {
            try BrowserMessage(decoding: json(#"{"v":2,"type":"ping"}"#))
        }
    }

    @Test("Version is checked before type, so a future hello shape isn't misread")
    func versionBeforeType() {
        #expect(throws: BrowserMessageError.unsupportedVersion(99)) {
            try BrowserMessage(decoding: json(#"{"v":99,"type":"hello"}"#))
        }
    }

    @Test(
        "Malformed input throws",
        arguments: [
            "not json",
            "[]",
            #"{"type":"ping"}"#,
            #"{"v":"1","type":"ping"}"#,
            #"{"v":1}"#,
            #"{"v":1,"type":7}"#,
            #"{"v":1,"type":"hello","browser":"chrome"}"#,
            #"{"v":1,"type":"hello","extensionVersion":3,"browser":"chrome"}"#,
        ]
    )
    func malformed(input: String) {
        #expect(throws: BrowserMessageError.malformed) {
            try BrowserMessage(decoding: json(input))
        }
    }

    @Test("Encoded messages round-trip and carry the current version")
    func roundTrip() throws {
        let messages: [BrowserMessage] = [
            .hello(extensionVersion: "1.2.3", browser: "brave"), .ping, .pong,
        ]
        for message in messages {
            let data = message.encoded()
            #expect(try BrowserMessage(decoding: data) == message)
            let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(object["v"] as? Int == 1)
        }
    }

    @Test("Pong encodes to the documented wire form")
    func pongWireForm() {
        #expect(String(decoding: BrowserMessage.pong.encoded(), as: UTF8.self) == #"{"type":"pong","v":1}"#)
    }
}

@Suite("NativeMessagingFrame — length-prefixed framing")
struct NativeMessagingFrameTests {

    @Test("Frame is a 4-byte little-endian length then the payload")
    func frameLayout() {
        let framed = NativeMessagingFrame.encode(Data("abc".utf8))
        #expect(Array(framed) == [3, 0, 0, 0, 0x61, 0x62, 0x63])
    }

    @Test("Reader yields whole frames and buffers partial ones")
    func partialFrames() throws {
        var reader = NativeMessagingFrameReader()
        let framed = NativeMessagingFrame.encode(Data("hello".utf8))
            + NativeMessagingFrame.encode(Data("x".utf8))

        #expect(try reader.append(framed.prefix(6)).isEmpty)
        let frames = try reader.append(framed.dropFirst(6))
        #expect(frames.map { String(decoding: $0, as: UTF8.self) } == ["hello", "x"])
    }

    @Test("Reader rejects a frame larger than the limit")
    func oversized() {
        var reader = NativeMessagingFrameReader(maxFrameSize: 8)
        let header = Data([9, 0, 0, 0])
        #expect(throws: NativeMessagingFrameError.frameTooLarge(9)) {
            try reader.append(header)
        }
    }

    @Test("Empty payload is a valid frame")
    func emptyFrame() throws {
        var reader = NativeMessagingFrameReader()
        let frames = try reader.append(NativeMessagingFrame.encode(Data()))
        #expect(frames == [Data()])
    }
}
