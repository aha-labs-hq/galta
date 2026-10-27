import Foundation

@main struct CompanionModelTests {
    @MainActor static func main() async {
        func check(_ condition: Bool, _ message: String = "Assertion failed") { precondition(condition, message) }
        // One fixed domain: macOS keeps an empty preferences file for every suite a run creates.
        let suite = "com.galta.companion.tests"
        let preferences = UserDefaults(suiteName: suite)!
        preferences.removePersistentDomain(forName: suite)
        defer { preferences.removePersistentDomain(forName: suite) }
        func model(_ runtime: FixtureRuntime, installedApp: Bool = true) -> InstallationModel {
            InstallationModel(inApplications: installedApp, runtime: runtime, preferences: preferences)
        }

        let readyRuntime = FixtureRuntime(fixtureHealth(.current))
        let ready = model(readyRuntime)
        check(ready.showsBrowserActions && ready.statusTitle == "Checking this Mac…", "The canvas must remain reachable before the first inspection")
        await ready.becameActive() // Launch notification must not race the first inspection.
        check(await readyRuntime.commands.isEmpty)
        await ready.start()
        check(ready.phase == .ready && !ready.canConnect && ready.mcpCommand != nil)
        await ready.becameActive(); await ready.connect()
        check(await readyRuntime.commands == [.inspect, .inspect], "Opening a healthy app must never install")
        await readyRuntime.configure(delay: .milliseconds(30))
        let foreground = Task { await ready.becameActive() }
        while ready.operation == nil { await Task.yield() }
        check(ready.showsBrowserActions && ready.visibleOperation == nil && ready.statusTitle == "Ready on this Mac", "Home and menu must keep a healthy foreground check quiet")
        await foreground.value

        preferences.set(true, forKey: "browserConnectionRequested")
        let updateRuntime = FixtureRuntime(fixtureHealth(.updateAvailable))
        let update = model(updateRuntime)
        await update.start(); await update.start(); await update.becameActive()
        check(update.phase == .ready)
        check(await updateRuntime.commands == [.inspect, .install, .inspect], "Only an authorized update activates at launch")

        let repairRuntime = FixtureRuntime(fixtureHealth(.repairRequired))
        let repair = model(repairRuntime)
        await repair.start()
        check(repair.phase == .repair && repair.canConnect)
        check(await repairRuntime.commands == [.inspect], "Repair must be an explicit action")
        await repairRuntime.configure(delay: .milliseconds(30))
        let first = Task { await repair.connect() }
        while repair.operation == nil { await Task.yield() }
        check(!repair.canConnect && !repair.showsBrowserActions && repair.statusTitle == "Repairing the connection…", "Both surfaces must show the in-flight repair without allowing another activation")
        await repair.connect()
        await first.value
        check(await repairRuntime.commands == [.inspect, .install], "Concurrent activation must coalesce")
        check(repair.phase == .ready)

        let outsideRuntime = FixtureRuntime(fixtureHealth(.absent))
        let outside = model(outsideRuntime, installedApp: false)
        await outside.start(); await outside.connect()
        check(outside.phase == .moveToApplications)
        check(await outsideRuntime.commands == [.inspect])

        let conflict = model(FixtureRuntime(fixtureHealth(.conflict)))
        await conflict.start()
        check(conflict.phase == .conflict && !conflict.canConnect)
        let broken = model(FixtureRuntime(fixtureHealth(.absent, available: false)))
        await broken.start()
        check(broken.phase == .unavailable && !broken.canConnect && broken.mcpCommand == nil)
        let damaged = model(FixtureRuntime(fixtureHealth(.unavailable)))
        await damaged.start()
        check(damaged.phase == .unavailable && !damaged.canConnect && damaged.mcpCommand == nil)

        await readyRuntime.configure(fail: true)
        await ready.refresh()
        check(ready.phase == .failed && ready.health == nil && ready.mcpCommand == nil, "A failed check must invalidate stale readiness")
        check(!ready.showsBrowserActions && ready.statusTitle == "Couldn’t finish", "A failed foreground check must replace readiness on both surfaces")
        await readyRuntime.configure()
        await ready.refresh()
        check(ready.phase == .ready && ready.error == nil)

        preferences.set(false, forKey: "browserConnectionRequested")
        let freshRuntime = FixtureRuntime(fixtureHealth(.absent))
        let fresh = model(freshRuntime)
        await fresh.start()
        check(fresh.phase == .connect && fresh.canConnect)
        await freshRuntime.configure(fail: true)
        await fresh.connect()
        check(fresh.phase == .failed && !preferences.bool(forKey: "browserConnectionRequested"))
        await freshRuntime.configure()
        await fresh.refresh(); await fresh.connect()
        check(fresh.phase == .ready && preferences.bool(forKey: "browserConnectionRequested"))
        print("PASS: native state lifecycle, read-only launch/focus, consented update, explicit repair, activation exclusion, Applications guard, conflicts, unavailable runtime and failure recovery.")

        let browser = InstalledBrowser(id: "fixture", name: "Fixture Browser", url: URL(fileURLWithPath: "/fixture.app"))
        var launchCount = 0
        var failLaunch = true
        let browsers = BrowserModel(installed: [browser], launch: { _ in
            launchCount += 1
            try await Task.sleep(for: .milliseconds(30))
            if failLaunch { throw NSError(domain: "Preview", code: 1) }
        })
        let launch = Task { await browsers.open(browser) }
        while browsers.opening == nil { await Task.yield() }
        check(!(await browsers.open(browser)), "Home and menu must not launch two browsers concurrently")
        check(!(await launch.value) && launchCount == 1 && browsers.error != nil && browsers.opening == nil)
        failLaunch = false
        check(await browsers.open(browser))
        check(launchCount == 2 && browsers.error == nil && browsers.opening == nil, "An explicit successful launch clears the shared failure")
        print("PASS: shared browser launch exclusion, visible failure without retry, and explicit recovery.")

        // Browser actions open the canvas of the extension named by the bundled release.
        check(BrowserLauncher.canvas(extensionId: "oocbicpnofichiglihkbmpkjegiakhgg")?.absoluteString == "chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/canvas/index.html")
        check(BrowserLauncher.canvas(extensionId: "not-an-extension") == nil && BrowserLauncher.canvas(extensionId: "OOCBICPNOFICHIGLIHKBMPKJEGIAKHGG") == nil)
        let bundle = FileManager.default.temporaryDirectory.appendingPathComponent("galta-bundle-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: bundle) }
        try! FileManager.default.createDirectory(at: bundle.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        check(BrowserLauncher.bundledExtensionId(contents: bundle) == nil, "A bundle without its release names no canvas")
        try! #"{"schema":1,"extensionId":"oocbicpnofichiglihkbmpkjegiakhgg","files":{}}"#.write(to: bundle.appendingPathComponent("Resources/release.json"), atomically: true, encoding: .utf8)
        check(BrowserLauncher.bundledExtensionId(contents: bundle) == "oocbicpnofichiglihkbmpkjegiakhgg")
        print("PASS: browser actions open the canvas of the bundled release's extension.")

        // A runtime that fails without its own one-line reason still reports a readable cause.
        let fake = FileManager.default.temporaryDirectory.appendingPathComponent("galta-runtime-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: fake) }
        let executable = fake.appendingPathComponent("Helpers/GaltaRuntime.app/Contents/MacOS/galta-runtime")
        try! FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        func failure(_ script: String) async -> String {
            try! "#!/bin/sh\n\(script)\n".write(to: executable, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
            do { _ = try await RuntimeProcess().run(.inspect, directory: fake); return "" }
            catch { return error.localizedDescription }
        }
        check(await failure("echo 'Close every open Galta canvas first.' >&2; exit 1") == "Close every open Galta canvas first.", "The runtime's own reason is shown as written")
        check(await failure("exit 3") == "The Galta runtime stopped without a reason (exit status 3).")
        check(await failure("kill -9 $$") == "The Galta runtime stopped unexpectedly (signal 9).")
        check(await failure("echo not-json") == "The Galta runtime sent a reply this app can’t read. Install the complete Galta app again.")
        print("PASS: runtime failures without a reason, killed runtimes and unreadable replies report a readable cause.")
        if let path = CommandLine.arguments.dropFirst().first {
            do {
                let health = try await RuntimeProcess().run(.inspect, directory: URL(fileURLWithPath: path))
                check(health.runtime.available)
                print("PASS: Swift process client decoded the packaged runtime's real inspection: \(health.installation.state.rawValue). No activation was requested.")
            } catch { fatalError("Packaged inspection failed: \(error)") }
        }
    }
}
