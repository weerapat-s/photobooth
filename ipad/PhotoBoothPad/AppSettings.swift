import Foundation

@MainActor
final class AppSettings: ObservableObject {
    private enum Key {
        static let serverURL = "serverURL"
        static let apiToken = "apiToken"
        static let demoCamera = "demoCamera"
    }

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Key.serverURL) }
    }
    @Published var apiToken: String {
        didSet { UserDefaults.standard.set(apiToken, forKey: Key.apiToken) }
    }
    @Published var demoCamera: Bool {
        didSet { UserDefaults.standard.set(demoCamera, forKey: Key.demoCamera) }
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: Key.serverURL) ?? ""
        apiToken = UserDefaults.standard.string(forKey: Key.apiToken) ?? ""
        demoCamera = UserDefaults.standard.object(forKey: Key.demoCamera) as? Bool ?? true
    }

    var isConfigured: Bool {
        URL(string: serverURL)?.scheme != nil && apiToken.count >= 32
    }
}
