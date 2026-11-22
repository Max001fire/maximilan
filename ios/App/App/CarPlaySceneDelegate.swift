import UIKit
import CarPlay
import MapKit

/// CarPlay-Oberfläche von KurvenCrew (Kategorie "Driving Task").
/// Drei Tabs: Live-Werte, Gruppe, Kurvenspots.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPPointOfInterestTemplateDelegate {
    private var interfaceController: CPInterfaceController?
    private var scene: CPTemplateApplicationScene?
    private var liveTemplate: CPInformationTemplate?
    private var groupTemplate: CPListTemplate?
    private var spotsTemplate: CPPointOfInterestTemplate?
    private var timer: Timer?
    private var lastSpotIds: [String] = []
    private var lastGroupKey = ""

    // MARK: Verbinden / Trennen

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.scene = templateApplicationScene
        self.interfaceController = interfaceController
        NativeTelemetry.shared.start()

        let live = CPInformationTemplate(title: "Live", layout: .twoColumn, items: liveItems(), actions: liveActions())
        live.tabTitle = "Live"
        live.tabImage = UIImage(systemName: "speedometer")
        liveTemplate = live

        let group = CPListTemplate(title: "Gruppe", sections: groupSections())
        group.tabTitle = "Gruppe"
        group.tabImage = UIImage(systemName: "person.3.fill")
        group.emptyViewTitleVariants = ["Keine Gruppenfahrt"]
        group.emptyViewSubtitleVariants = ["Starte oder betritt eine Gruppenfahrt in der App."]
        groupTemplate = group

        let spots = CPPointOfInterestTemplate(title: "Kurvenspots", pointsOfInterest: [], selectedIndex: NSNotFound)
        spots.pointOfInterestDelegate = self
        spots.tabTitle = "Spots"
        spots.tabImage = UIImage(systemName: "point.topleft.down.curvedto.point.bottomright.up")
        spotsTemplate = spots
        refreshSpots(force: true)

        let tabs = CPTabBarTemplate(templates: [live, group, spots])
        interfaceController.setRootTemplate(tabs, animated: false, completion: nil)

        NotificationCenter.default.addObserver(self, selector: #selector(stateChanged), name: CarPlayState.didChange, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshLive() }
        KCCarPlayPlugin.send(action: "refresh")
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        timer?.invalidate()
        timer = nil
        NotificationCenter.default.removeObserver(self)
        self.interfaceController = nil
        NativeTelemetry.shared.stop()
    }

    @objc private func stateChanged() {
        refreshGroup()
        refreshSpots(force: false)
    }

    // MARK: Live-Tab

    private func fmt(_ v: Double, _ digits: Int = 0) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.minimumFractionDigits = digits
        f.maximumFractionDigits = digits
        return f.string(from: NSNumber(value: v)) ?? "\(v)"
    }

    private func time(_ sec: Double) -> String {
        let s = Int(sec)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    /// Werte aus der Web-App, solange sie aktiv ist – sonst aus der nativen Messung
    private func liveItems() -> [CPInformationItem] {
        let st = CarPlayState.shared
        let t = NativeTelemetry.shared
        let web = st.isFresh
        let moto = st.vehicle == "motorcycle"
        let speed = web ? st.number("speed") : t.speedKmh
        var items = [CPInformationItem(title: "Tempo", detail: "\(fmt(speed)) km/h")]
        if moto {
            let lean = web ? st.number("lean") : t.lean
            let side = lean < -1 ? "◀ " : lean > 1 ? " ▶" : ""
            items.append(CPInformationItem(title: "Schräglage", detail: lean < 0 ? "\(side)\(fmt(abs(lean)))°" : "\(fmt(abs(lean)))°\(side)"))
            let l = web ? st.number("maxLeanLeft") : t.stats.maxLeanLeft
            let r = web ? st.number("maxLeanRight") : t.stats.maxLeanRight
            items.append(CPInformationItem(title: "Max. Schräglage", detail: "◀ \(fmt(l))° | \(fmt(r))° ▶"))
        } else {
            let g = web ? st.number("totalG") : hypot(t.latG, t.lonG)
            items.append(CPInformationItem(title: "G-Kraft", detail: "\(fmt(g, 2)) g"))
            let mq = web ? st.number("maxLatG") : t.stats.maxLatG
            let mb = web ? st.number("maxBrakeG") : t.stats.maxBrakeG
            items.append(CPInformationItem(title: "Max. quer / Bremsen", detail: "\(fmt(mq, 2)) / \(fmt(mb, 2)) g"))
        }
        let maxS = web ? st.number("maxSpeed") : t.stats.maxSpeed
        let avg = web ? st.number("avgSpeed") : t.stats.avgSpeed
        items.append(CPInformationItem(title: "Max / Ø", detail: "\(fmt(maxS)) / \(fmt(avg)) km/h"))
        let dist = web ? st.number("distanceKm") : t.stats.distance / 1000
        let dur = web ? st.number("duration") : t.stats.duration
        let recording = web ? st.recording : t.recording
        items.append(CPInformationItem(title: recording ? "🔴 Aufzeichnung" : "Letzte Fahrt", detail: "\(fmt(dist, 1)) km · \(time(dur))"))
        return items
    }

    private func liveActions() -> [CPTextButton] {
        let st = CarPlayState.shared
        let recording = st.isFresh ? st.recording : NativeTelemetry.shared.recording
        var actions = [
            CPTextButton(title: recording ? "Fahrt beenden" : "Fahrt starten", textStyle: recording ? .cancel : .confirm) { [weak self] _ in
                let t = NativeTelemetry.shared
                // sofort nativ umschalten (falls das Handy gesperrt ist), Web-App folgt
                if t.recording { t.stopSession() } else { t.startSession() }
                KCCarPlayPlugin.send(action: "toggleRecording")
                self?.refreshLive()
            },
        ]
        if st.vehicle == "motorcycle" {
            actions.append(CPTextButton(title: "⊙ Nullpunkt", textStyle: .normal) { [weak self] _ in
                self?.showCentering()
            })
        }
        return actions
    }

    private func showCentering() {
        let ok = CPAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
        }
        let alert = CPAlertTemplate(titleVariants: ["Motorrad gerade halten …", "Gerade halten …"], actions: [ok])
        interfaceController?.presentTemplate(alert, animated: true, completion: nil)
        KCCarPlayPlugin.send(action: "center")
        NativeTelemetry.shared.center { [weak self] in
            if self?.interfaceController?.presentedTemplate != nil {
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
            }
            self?.refreshLive()
        }
    }

    private func refreshLive() {
        guard let live = liveTemplate else { return }
        live.items = liveItems()
        live.actions = liveActions()
    }

    // MARK: Gruppen-Tab

    private func groupSections() -> [CPListSection] {
        let st = CarPlayState.shared
        let members = st.list("members")
        guard !members.isEmpty else { return [] }
        let items: [CPListItem] = members.map { m in
            let name = m["name"] as? String ?? "?"
            let icon = (m["vehicle"] as? String) == "car" ? "🚗" : "🏍️"
            let speed = (m["speed"] as? NSNumber)?.doubleValue ?? 0
            let dist = (m["distanceKm"] as? NSNumber)?.doubleValue ?? -1
            let rec = (m["recording"] as? Bool) == true ? " · 🔴" : ""
            let detail = dist >= 0 ? "\(fmt(speed)) km/h · \(fmt(dist, 1)) km entfernt\(rec)" : "noch kein GPS"
            return CPListItem(text: "\(icon) \(name)", detailText: detail)
        }
        let title = st.string("rideName")
        return [CPListSection(items: items, header: title.isEmpty ? nil : title, sectionIndexTitle: nil)]
    }

    private func refreshGroup() {
        let key = CarPlayState.shared.list("members").map { "\($0["name"] ?? "")\($0["speed"] ?? "")\($0["distanceKm"] ?? "")" }.joined()
        guard key != lastGroupKey else { return }
        lastGroupKey = key
        groupTemplate?.updateSections(groupSections())
    }

    // MARK: Spots-Tab

    private func refreshSpots(force: Bool) {
        let spots = CarPlayState.shared.list("spots")
        let ids = spots.compactMap { $0["id"] as? String }
        guard force || ids != lastSpotIds, let template = spotsTemplate else { return }
        lastSpotIds = ids
        let pois: [CPPointOfInterest] = spots.prefix(12).compactMap { s in
            guard let lat = (s["lat"] as? NSNumber)?.doubleValue, let lng = (s["lng"] as? NSNumber)?.doubleValue else { return nil }
            let name = s["name"] as? String ?? "Kurvenspot"
            let diff = (s["difficulty"] as? NSNumber)?.intValue ?? 3
            let dist = (s["distanceKm"] as? NSNumber)?.doubleValue ?? -1
            let stars = String(repeating: "●", count: diff) + String(repeating: "○", count: max(0, 5 - diff))
            let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng)))
            item.name = name
            let poi = CPPointOfInterest(location: item, title: name,
                                        subtitle: dist >= 0 ? "\(fmt(dist, 1)) km" : nil,
                                        summary: stars,
                                        detailTitle: name,
                                        detailSubtitle: "Schwierigkeit \(stars)",
                                        detailSummary: s["description"] as? String,
                                        pinImage: nil)
            poi.primaryButton = CPTextButton(title: "Hinfahren", textStyle: .confirm) { [weak self] _ in
                self?.navigate(lat: lat, lng: lng)
            }
            return poi
        }
        template.setPointsOfInterest(pois, selectedIndex: NSNotFound)
    }

    /// Navigation an Apple Karten übergeben
    private func navigate(lat: Double, lng: Double) {
        guard let url = URL(string: "maps://?daddr=\(lat),\(lng)&dirflg=d") else { return }
        scene?.open(url, options: nil, completionHandler: nil)
    }

    func pointOfInterestTemplate(_ pointOfInterestTemplate: CPPointOfInterestTemplate, didChangeMapRegion region: MKCoordinateRegion) {
        // Spots kommen sortiert nach Entfernung aus der App – nichts nachzuladen
    }
}
