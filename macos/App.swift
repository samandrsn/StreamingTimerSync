// Streaming Timer Sync for macOS: a menu bar app that runs the timer server
// (bundled Node + server files) and opens its dashboard in the browser.
import AppKit
import ServiceManagement

let appName = "Streaming Timer Sync"
let releasesURL = URL(string: "https://github.com/samandrsn/StreamingTimerSync/releases")!
let latestReleaseAPI = URL(string: "https://api.github.com/repos/samandrsn/StreamingTimerSync/releases/latest")!

final class ServerProcess {
	enum State { case starting, running, stopped(String) }

	private var process: Process?
	private var quitting = false
	private var restarts = 0
	var onChange: ((State) -> Void)?
	private(set) var state: State = .stopped("Not started") { didSet { onChange?(state) } }

	let dataDir: URL
	let logFile: URL
	var port: Int

	init(port: Int) {
		let fm = FileManager.default
		dataDir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(appName, isDirectory: true)
		let logDir = fm.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/\(appName)", isDirectory: true)
		try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
		try? fm.createDirectory(at: logDir, withIntermediateDirectories: true)
		logFile = logDir.appendingPathComponent("server.log")
		self.port = port
	}

	func start() {
		guard let res = Bundle.main.resourceURL else { return }
		let node = res.appendingPathComponent("node")
		let entry = res.appendingPathComponent("server/src/index.js")

		// Keep the log from growing forever: start fresh when it passes 5 MB.
		if let size = try? FileManager.default.attributesOfItem(atPath: logFile.path)[.size] as? Int, size > 5_000_000 {
			try? FileManager.default.removeItem(at: logFile)
		}
		if !FileManager.default.fileExists(atPath: logFile.path) { FileManager.default.createFile(atPath: logFile.path, contents: nil) }
		let log = try? FileHandle(forWritingTo: logFile)
		log?.seekToEndOfFile()

		let p = Process()
		p.executableURL = node
		p.arguments = [entry.path]
		p.currentDirectoryURL = res.appendingPathComponent("server")
		var env = ProcessInfo.processInfo.environment
		env["DATA_DIR"] = dataDir.path
		env["PORT"] = String(port)
		p.environment = env
		p.standardOutput = log
		p.standardError = log
		p.terminationHandler = { [weak self] proc in
			DispatchQueue.main.async { self?.exited(code: proc.terminationStatus) }
		}
		do {
			state = .starting
			try p.run()
			process = p
			waitUntilUp()
		} catch {
			state = .stopped("Couldn't start: \(error.localizedDescription)")
		}
	}

	private func waitUntilUp(attempt: Int = 0) {
		let url = URL(string: "http://127.0.0.1:\(port)/health")!
		URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
			DispatchQueue.main.async {
				guard let self, self.process?.isRunning == true else { return }
				if (response as? HTTPURLResponse)?.statusCode == 200 {
					self.restarts = 0
					self.state = .running
				} else if attempt < 40 {
					DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilUp(attempt: attempt + 1) }
				}
			}
		}.resume()
	}

	private func exited(code: Int32) {
		process = nil
		if quitting { return }
		// Restart a crashed server a few times, then give up and point at the log.
		restarts += 1
		if restarts <= 3 {
			state = .starting
			DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.start() }
		} else {
			state = .stopped("Stopped (exit \(code)). Port \(port) may be in use. See the log.")
		}
	}

	func stop() {
		quitting = true
		process?.terminate()
		process?.waitUntilExit()
		process = nil
	}

	func restart(port newPort: Int? = nil) {
		stop()
		quitting = false
		restarts = 0
		if let newPort { port = newPort }
		start()
	}
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
	private let defaults = UserDefaults.standard
	private var statusItem: NSStatusItem!
	private var server: ServerProcess!
	private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
	private let addressLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
	private let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")

	var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
	var port: Int { server.port }
	var localURL: URL { URL(string: "http://localhost:\(port)/")! }

	func applicationDidFinishLaunching(_ notification: Notification) {
		defaults.register(defaults: ["port": 7374, "openedBefore": false])
		server = ServerProcess(port: defaults.integer(forKey: "port"))

		statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		if let button = statusItem.button {
			button.image = NSImage(systemSymbolName: "timer", accessibilityDescription: appName)
			button.image?.isTemplate = true
		}
		statusItem.menu = buildMenu()

		server.onChange = { [weak self] state in self?.render(state) }
		server.start()
	}

	func applicationWillTerminate(_ notification: Notification) {
		server.stop()
	}

	private func buildMenu() -> NSMenu {
		let menu = NSMenu()
		menu.delegate = self
		let title = NSMenuItem(title: "\(appName) \(version)", action: nil, keyEquivalent: "")
		title.isEnabled = false
		menu.addItem(title)
		statusLine.isEnabled = false
		menu.addItem(statusLine)
		menu.addItem(.separator())
		menu.addItem(item("Open Dashboard", #selector(openDashboard), "d"))
		addressLine.isEnabled = false
		menu.addItem(addressLine)
		menu.addItem(item("Copy Stage Display Address", #selector(copyAddress), "c"))
		menu.addItem(.separator())
		menu.addItem(loginItem)
		loginItem.target = self
		menu.addItem(item("Change Port…", #selector(changePort), ""))
		menu.addItem(item("Restart Server", #selector(restartServer), "r"))
		menu.addItem(.separator())
		menu.addItem(item("Show Log", #selector(showLog), "l"))
		menu.addItem(item("Open Data Folder", #selector(openData), ""))
		menu.addItem(item("Check for Updates…", #selector(checkForUpdates), ""))
		menu.addItem(.separator())
		menu.addItem(item("Quit \(appName)", #selector(quit), "q"))
		return menu
	}

	private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
		let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
		i.target = self
		return i
	}

	func menuWillOpen(_ menu: NSMenu) {
		addressLine.title = "Stage displays: \(lanAddress())"
		loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
		render(server.state)
	}

	private func render(_ state: ServerProcess.State) {
		switch state {
		case .starting: statusLine.title = "Starting on port \(port)…"
		case .running:
			statusLine.title = "Running on port \(port)"
			if !defaults.bool(forKey: "openedBefore") {
				defaults.set(true, forKey: "openedBefore")
				openDashboard()
			}
		case .stopped(let why): statusLine.title = why
		}
		statusItem.button?.appearsDisabled = { if case .running = state { return false } else { return true } }()
	}

	/** First IPv4 address on a real network interface, for other computers on the network. */
	private func lanAddress() -> String {
		var best: String?
		var ifaddr: UnsafeMutablePointer<ifaddrs>?
		guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return "http://<this Mac's IP>:\(port)/<venue>" }
		defer { freeifaddrs(ifaddr) }
		for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
			let ifa = ptr.pointee
			guard ifa.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
			let name = String(cString: ifa.ifa_name)
			guard name.hasPrefix("en") else { continue }
			var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
			getnameinfo(ifa.ifa_addr, socklen_t(ifa.ifa_addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
			let ip = String(cString: host)
			if !ip.hasPrefix("169.254") { best = best ?? ip }
		}
		return "http://\(best ?? "<this Mac's IP>"):\(port)/<venue>"
	}

	@objc func openDashboard() { NSWorkspace.shared.open(localURL) }

	@objc func copyAddress() {
		let text = lanAddress().replacingOccurrences(of: "/<venue>", with: "/")
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(text, forType: .string)
	}

	@objc func toggleLogin() {
		do {
			if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
		} catch {
			alert("Couldn't change Open at Login", error.localizedDescription)
		}
	}

	@objc func changePort() {
		let a = NSAlert()
		a.messageText = "Server port"
		a.informativeText = "Stage displays and Companion use this port. Change it only if another app already uses \(port)."
		let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 120, height: 24))
		field.stringValue = String(port)
		a.accessoryView = field
		a.addButton(withTitle: "Restart on This Port")
		a.addButton(withTitle: "Cancel")
		NSApp.activate(ignoringOtherApps: true)
		guard a.runModal() == .alertFirstButtonReturn else { return }
		guard let p = Int(field.stringValue.trimmingCharacters(in: .whitespaces)), (1024...65535).contains(p) else {
			return alert("Invalid port", "Use a number from 1024 to 65535.")
		}
		defaults.set(p, forKey: "port")
		server.restart(port: p)
	}

	@objc func restartServer() { server.restart() }
	@objc func showLog() { NSWorkspace.shared.open(server.logFile) }
	@objc func openData() { NSWorkspace.shared.open(server.dataDir) }

	@objc func checkForUpdates() {
		var req = URLRequest(url: latestReleaseAPI)
		req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
		URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
			let tag = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["tag_name"] as? String
			DispatchQueue.main.async {
				guard let self else { return }
				guard let tag else {
					NSWorkspace.shared.open(releasesURL)
					return
				}
				let latest = tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
				if latest.compare(self.version, options: .numeric) == .orderedDescending {
					let a = NSAlert()
					a.messageText = "Version \(latest) is available"
					a.informativeText = "You have \(self.version). Download the new version, quit this app, and replace it in Applications. Your settings are kept."
					a.addButton(withTitle: "Download")
					a.addButton(withTitle: "Later")
					NSApp.activate(ignoringOtherApps: true)
					if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(releasesURL) }
				} else {
					self.alert("You're up to date", "\(appName) \(self.version) is the latest version.")
				}
			}
		}.resume()
	}

	@objc func quit() { NSApp.terminate(nil) }

	private func alert(_ title: String, _ text: String) {
		let a = NSAlert()
		a.messageText = title
		a.informativeText = text
		NSApp.activate(ignoringOtherApps: true)
		a.runModal()
	}
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
