import Foundation
import UIKit
import Capacitor

/// Zustand, den die Web-App an CarPlay schickt (Gruppe, Spots, Fahrwerte).
final class CarPlayState {
    static let shared = CarPlayState()
    static let didChange = Notification.Name("KCCarPlayStateDidChange")

    private(set) var data: [String: Any] = [:]
    private(set) var updatedAt: Date = .distantPast

    /// true, wenn die Web-App in den letzten 3 s Daten geschickt hat (Handy entsperrt/aktiv)
    var isFresh: Bool { Date().timeIntervalSince(updatedAt) < 3 }

    func set(_ d: [String: Any]) {
        data = d
        updatedAt = Date()
        NotificationCenter.default.post(name: CarPlayState.didChange, object: nil)
    }

    func number(_ key: String) -> Double { (data[key] as? NSNumber)?.doubleValue ?? 0 }
    func string(_ key: String) -> String { data[key] as? String ?? "" }
    func list(_ key: String) -> [[String: Any]] { data[key] as? [[String: Any]] ?? [] }
    var vehicle: String { (data["vehicle"] as? String) ?? NativeTelemetry.shared.vehicle }
    var recording: Bool { (data["recording"] as? Bool) ?? NativeTelemetry.shared.recording }
}

/// Capacitor-Plugin "KCCarPlay" – Brücke zwischen Web-App (public/native.js) und CarPlay.
@objc(KCCarPlayPlugin)
public class KCCarPlayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KCCarPlayPlugin"
    public let jsName = "KCCarPlay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
    ]

    static weak var current: KCCarPlayPlugin?

    override public func load() {
        KCCarPlayPlugin.current = self
    }

    /// Web-App -> CarPlay: aktueller Zustand
    @objc func update(_ call: CAPPluginCall) {
        let d = call.options as? [String: Any] ?? [:]
        DispatchQueue.main.async {
            CarPlayState.shared.set(d)
            // Die Web-App ist führend: native Messung folgt ihrem Aufzeichnungs-Status
            let t = NativeTelemetry.shared
            if let v = d["vehicle"] as? String { t.setVehicle(v) }
            let rec = d["recording"] as? Bool ?? false
            if rec && !t.recording { t.startSession() }
            if !rec && t.recording { t.stopSession() }
        }
        call.resolve()
    }

    /// Bildschirm anlassen, solange eine Fahrt aufgezeichnet wird
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
        call.resolve()
    }

    /// CarPlay -> Web-App: Aktion auslösen ("toggleRecording", "center", "refresh")
    static func send(action: String) {
        current?.notifyListeners("action", data: ["action": action], retainUntilConsumed: true)
    }
}
