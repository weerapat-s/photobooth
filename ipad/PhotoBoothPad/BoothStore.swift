import Foundation
import UIKit

@MainActor
final class BoothStore: ObservableObject {
    @Published var phase: BoothPhase = .setup
    @Published var eventName = "Photo Booth"
    @Published var shots: [CapturedShot] = []
    @Published var totalShots = 4
    @Published var countdownSeconds = 3
    @Published var shareURL: URL?
    @Published var queueNumber: Int?
    @Published var cameraName = ""

    private let settings: AppSettings
    private var camera: CameraBackend?
    private var api: BoothAPIClient?
    private var activeSlot = 1

    init(settings: AppSettings) {
        self.settings = settings
    }

    func prepare() async {
        guard settings.isConfigured, let url = URL(string: settings.serverURL) else {
            phase = .setup
            return
        }

        do {
            api = BoothAPIClient(baseURL: url, token: settings.apiToken)
            let bootstrap = try await api!.bootstrap()
            eventName = bootstrap.config.eventName
            totalShots = bootstrap.config.shots
            countdownSeconds = bootstrap.config.countdown
            camera = settings.demoCamera ? MockCameraBackend() : EOSRUSBCameraBackend()
            cameraName = camera?.displayName ?? ""
            phase = .idle
        } catch {
            phase = .error(error.localizedDescription)
        }
    }

    func start() async {
        guard let api, let camera else { phase = .setup; return }
        phase = .connecting
        shots = []
        shareURL = nil
        queueNumber = nil
        activeSlot = 1
        do {
            try await camera.connect()
            _ = try await api.startSession()
            await take(slot: 1)
        } catch {
            phase = .error(error.localizedDescription)
        }
    }

    func take(slot: Int) async {
        guard let camera, let api else { return }
        activeSlot = slot
        do {
            if countdownSeconds > 0 {
                for value in stride(from: countdownSeconds, through: 1, by: -1) {
                    phase = .countdown(value)
                    try await Task.sleep(for: .seconds(1))
                }
            }
            let jpeg = try await camera.captureJPEG(slot: slot)
            guard let image = UIImage(data: jpeg) else { throw CameraError.invalidImage }
            _ = try await api.upload(slot: slot, jpeg: jpeg)
            shots.removeAll { $0.slot == slot }
            shots.append(CapturedShot(slot: slot, image: image, jpeg: jpeg))
            shots.sort { $0.slot < $1.slot }
            phase = .review(slot)
        } catch {
            phase = .error(error.localizedDescription)
        }
    }

    func accept() async {
        if activeSlot < totalShots {
            await take(slot: activeSlot + 1)
            return
        }
        await finish()
    }

    func retake() async {
        await take(slot: activeSlot)
    }

    func finish() async {
        guard let api else { return }
        phase = .processing
        do {
            let response = try await api.finish()
            if let value = response.state?.session?.shareUrl { shareURL = URL(string: value) }
            queueNumber = response.state?.session?.queueNumber
            phase = .done
        } catch {
            phase = .error(error.localizedDescription)
        }
    }

    func cancel() async {
        do { try await api?.discard() } catch {}
        await camera?.disconnect()
        phase = .idle
    }

    func reset() async {
        do { try await api?.reset() } catch {}
        await camera?.disconnect()
        shots = []
        shareURL = nil
        phase = .idle
    }

    func openSetup() {
        phase = .setup
    }
}
