// FineTune/BrowserBridge/BrowserHostOwner.swift
import AppKit
import Darwin

enum BrowserHostOwner {
    /// Bundle ID of the app that launched the native messaging host process `pid` (its parent), or nil.
    static func bundleID(ofHostProcess pid: pid_t) -> String? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return NSRunningApplication(processIdentifier: pid_t(info.pbi_ppid))?.bundleIdentifier
    }
}
