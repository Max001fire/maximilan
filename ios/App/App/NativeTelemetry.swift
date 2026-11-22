import Foundation
import CoreLocation
import CoreMotion

/// Native Messung von Geschwindigkeit, Schräglage und G-Kräften.
/// Läuft auch, wenn das Handy gesperrt ist und nur CarPlay angezeigt wird
/// (die Web-Oberfläche wird von iOS im Hintergrund pausiert).
///
/// Gleiche Physik wie in public/telemetry.js:
///   Motorrad: sin(Schräglage) = v · ω / g   (ω = Drehrate um die Fahrzeug-Hochachse)
///   Auto:     Quer-G = v · ω / g,  Längs-G = Δv / Δt
final class NativeTelemetry: NSObject, CLLocationManagerDelegate {
    static let shared = NativeTelemetry()

    struct Stats {
        var startedAt: Date?
        var distance: Double = 0        // m
        var movingTime: Double = 0      // s
        var maxSpeed: Double = 0        // km/h
        var maxLeanLeft: Double = 0     // °
        var maxLeanRight: Double = 0    // °
        var maxLatG: Double = 0
        var maxBrakeG: Double = 0
        var maxTotalG: Double = 0
        var avgSpeed: Double { movingTime > 0 ? distance / movingTime * 3.6 : 0 }
        var duration: Double { startedAt.map { Date().timeIntervalSince($0) } ?? 0 }
    }

    private(set) var vehicle = "motorcycle"
    private(set) var recording = false
    private(set) var speedKmh: Double = 0
    private(set) var lean: Double = 0       // links negativ, rechts positiv
    private(set) var latG: Double = 0
    private(set) var lonG: Double = 0
    private(set) var stats = Stats()
    private(set) var lastLocation: CLLocation?
    /// Nullpunkt-Korrektur der Schräglage (Zentrierpunkt)
    private var leanOffset: Double = 0
    private var centerSamples: [Double]?

    private let location = CLLocationManager()
    private let motion = CMMotionManager()
    private let g = 9.81
    private var running = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        location.activityType = .automotiveNavigation
        location.pausesLocationUpdatesAutomatically = false
    }

    // MARK: Steuerung

    func start() {
        guard !running else { return }
        running = true
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
        location.startUpdatingLocation()
        startMotion()
    }

    func stop() {
        guard running, !recording else { return }
        running = false
        location.stopUpdatingLocation()
        motion.stopDeviceMotionUpdates()
    }

    func setVehicle(_ v: String) {
        if v == "motorcycle" || v == "car" { vehicle = v }
    }

    func startSession() {
        stats = Stats(startedAt: Date())
        recording = true
        start()
        // Im Hintergrund weiter messen (CarPlay bei gesperrtem Handy)
        if Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes").map({ ($0 as? [String])?.contains("location") ?? false }) == true {
            location.allowsBackgroundLocationUpdates = true
            location.showsBackgroundLocationIndicator = true
        }
    }

    func stopSession() {
        recording = false
        location.allowsBackgroundLocationUpdates = false
    }

    /// Zentrierpunkt: 2 s mitteln, während das Fahrzeug gerade steht/fährt.
    func center(completion: @escaping () -> Void) {
        centerSamples = []
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, let s = self.centerSamples else { return }
            self.centerSamples = nil
            if !s.isEmpty { self.leanOffset += s.reduce(0, +) / Double(s.count) }
            completion()
        }
    }

    var isCentered: Bool { leanOffset != 0 }

    // MARK: Sensoren

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 50.0
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: OperationQueue()) { [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            DispatchQueue.main.async { self.onMotion(dm) }
        }
    }

    private func onMotion(_ dm: CMDeviceMotion) {
        // Hochachse = Gegenrichtung der (gefilterten) Schwerkraft, im Geräte-Koordinatensystem
        let gx = -dm.gravity.x, gy = -dm.gravity.y, gz = -dm.gravity.z
        let n = max(1e-6, sqrt(gx * gx + gy * gy + gz * gz))
        // Drehrate (rad/s, bereits drift-korrigiert) um die Hochachse
        let omega = (dm.rotationRate.x * gx + dm.rotationRate.y * gy + dm.rotationRate.z * gz) / n
        let v = speedKmh / 3.6
        let dt = 1.0 / 50.0
        let k = 1 - exp(-dt / 0.25)

        if vehicle == "motorcycle" {
            let ratio = min(1, max(-1, v * omega / g))
            let raw = v > 4 ? -asin(ratio) * 180 / .pi : 0
            centerSamples?.append(raw)
            let target = v > 4 ? raw - leanOffset : 0
            lean += (target - lean) * k
            if recording && v > 4 {
                let l = min(65, abs(lean))
                if lean < 0 { stats.maxLeanLeft = max(stats.maxLeanLeft, l) } else { stats.maxLeanRight = max(stats.maxLeanRight, l) }
            }
        } else {
            let target = v > 2 ? -(v * omega) / g : 0
            latG += (target - latG) * k
            if recording && v > 2 {
                stats.maxLatG = max(stats.maxLatG, min(2.5, abs(latG)))
                stats.maxTotalG = max(stats.maxTotalG, min(3, hypot(latG, lonG)))
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for loc in locations { onLocation(loc) }
    }

    private func onLocation(_ loc: CLLocation) {
        guard loc.horizontalAccuracy >= 0 else { return }
        var speed = loc.speed >= 0 ? loc.speed : 0
        if let prev = lastLocation {
            let dt = loc.timestamp.timeIntervalSince(prev.timestamp)
            let d = loc.distance(from: prev)
            if loc.speed < 0, dt > 0 { speed = d / dt }
            if dt > 0 && dt < 10 {
                let target = (speed - max(0, prev.speed)) / dt / g
                lonG += (target - lonG) * (1 - exp(-dt / 1.0))
                if recording && vehicle == "car" && speed > 2 && lonG < 0 {
                    stats.maxBrakeG = max(stats.maxBrakeG, min(2.5, -lonG))
                }
            }
            if recording && loc.horizontalAccuracy < 35 && dt > 0 && dt < 30 && speed > 0.9 && d < 120 * dt {
                stats.distance += d
                stats.movingTime += dt
            }
        }
        speedKmh = speed * 3.6
        if recording && loc.horizontalAccuracy < 25 { stats.maxSpeed = max(stats.maxSpeed, speedKmh) }
        lastLocation = loc
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("KurvenCrew GPS: \(error.localizedDescription)")
    }
}
