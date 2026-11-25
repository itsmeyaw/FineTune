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
            #"{"v":1,"type":"tabs"}"#,
            #"{"v":1,"type":"tabs","tabs":[{"id":1}]}"#,
            #"{"v":1,"type":"tabUpdated","tab":{"id":"1","title":"","site":"","muted":false,"windowFocused":false}}"#,
            #"{"v":1,"type":"tabRemoved","tabId":1}"#,
            #"{"v":1,"type":"setMuted","tabId":1}"#,
            #"{"v":1,"type":"focus"}"#,
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
            .tabs([BrowserTab(id: 1, title: "A", site: "a.com", favicon: "data:image/png;base64,AA==", isMuted: true, isWindowFocused: false)]),
            .tabUpdated(BrowserTab(id: 2, title: "", site: "", favicon: nil, isMuted: false, isWindowFocused: true)),
            .tabRemoved(tabID: 3, closed: true),
            .setMuted(tabID: 4, muted: true),
            .focus(tabID: 5),
        ]
        for message in messages {
            let data = message.encoded()
            #expect(try BrowserMessage(decoding: data) == message)
            let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(object["v"] as? Int == 1)
        }
    }

    @Test("Decodes a tab snapshot, ignoring unknown fields")
    func decodeTabs() throws {
        let message = try BrowserMessage(decoding: json("""
            {"v":1,"type":"tabs","tabs":[
              {"id":12,"title":"Song","site":"www.youtube.com","favicon":"https://y.com/f.ico","muted":false,"windowFocused":true,"future":1},
              {"id":13,"title":"","site":"","muted":true,"windowFocused":false}
            ]}
            """))
        #expect(message == .tabs([
            BrowserTab(id: 12, title: "Song", site: "www.youtube.com", favicon: "https://y.com/f.ico", isMuted: false, isWindowFocused: true),
            BrowserTab(id: 13, title: "", site: "", favicon: nil, isMuted: true, isWindowFocused: false),
        ]))
    }

    @Test("Decodes tab removal")
    func decodeTabRemoved() throws {
        #expect(try BrowserMessage(decoding: json(#"{"v":1,"type":"tabRemoved","tabId":3,"closed":true}"#)) == .tabRemoved(tabID: 3, closed: true))
        #expect(try BrowserMessage(decoding: json(#"{"v":1,"type":"tabRemoved","tabId":3,"closed":false}"#)) == .tabRemoved(tabID: 3, closed: false))
    }

    @Test("Commands encode to the documented wire form")
    func commandWireForms() {
        #expect(String(decoding: BrowserMessage.setMuted(tabID: 4, muted: true).encoded(), as: UTF8.self)
            == #"{"muted":true,"tabId":4,"type":"setMuted","v":1}"#)
        #expect(String(decoding: BrowserMessage.focus(tabID: 5).encoded(), as: UTF8.self)
            == #"{"tabId":5,"type":"focus","v":1}"#)
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
