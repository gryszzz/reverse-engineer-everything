import Cocoa
import WebKit

/// Local window for the Investigation Studio. It loads only the loopback URL
/// passed by the bundle launcher and stops that launcher's server on quit.

private let serverPid = Int32(ProcessInfo.processInfo.environment["REE_SERVER_PID"] ?? "") ?? 0
private let studioURL = ProcessInfo.processInfo.environment["REE_STUDIO_URL"] ?? ""

private func stopServer() {
    guard serverPid > 1 else { return }
    kill(-serverPid, SIGTERM)
    kill(serverPid, SIGTERM)
    Thread.sleep(forTimeInterval: 0.2)
    if kill(serverPid, 0) == 0 {
        kill(-serverPid, SIGKILL)
        kill(serverPid, SIGKILL)
    }
}

final class StudioDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let url = URL(string: studioURL), url.scheme == "http",
              let host = url.host?.lowercased(),
              host == "127.0.0.1" || host == "localhost"
        else {
            fputs("REE window refused a non-local studio address.\n", stderr)
            stopServer()
            NSApp.terminate(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "REE Investigation Studio"
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 880, height: 560)
        let web = WKWebView(frame: window.contentView?.bounds ?? .zero)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(web)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: url))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let host = navigationAction.request.url?.host?.lowercased() ?? ""
        if host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }
}

if CommandLine.arguments.contains("--check") {
    fputs("REEWindow: ready\n", stdout)
    exit(0)
}

let application = NSApplication.shared
let delegate = StudioDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
