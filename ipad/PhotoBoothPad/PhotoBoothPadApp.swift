import SwiftUI

@main
struct PhotoBoothPadApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var store: BoothStore

    init() {
        let settings = AppSettings()
        _settings = StateObject(wrappedValue: settings)
        _store = StateObject(wrappedValue: BoothStore(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            BoothRootView()
                .environmentObject(settings)
                .environmentObject(store)
                .persistentSystemOverlays(.hidden)
                .statusBarHidden()
        }
    }
}
