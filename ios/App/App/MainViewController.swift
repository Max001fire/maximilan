import UIKit
import Capacitor

/// Capacitor-Hauptansicht, registriert das eigene CarPlay-Plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(KCCarPlayPlugin())
    }
}
