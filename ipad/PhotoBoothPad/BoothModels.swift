import Foundation
import UIKit

enum BoothPhase: Equatable {
    case setup
    case idle
    case connecting
    case countdown(Int)
    case review(Int)
    case processing
    case done
    case error(String)
}

struct CapturedShot: Identifiable {
    let slot: Int
    let image: UIImage
    let jpeg: Data
    var id: Int { slot }
}

struct BootstrapResponse: Decodable {
    let config: RemoteConfig
    let state: RemoteState
}

struct RemoteConfig: Decodable {
    let shots: Int
    let countdown: Int
    let eventName: String
    let printOnDone: Bool
    let reviewSeconds: Int
}

struct RemoteState: Decodable {
    let phase: String
    let message: String?
    let session: RemoteSession?
}

struct RemoteSession: Decodable {
    let id: String
    let shareUrl: String?
    let queueNumber: Int?
}

struct APIEnvelope: Decodable {
    let ok: Bool
    let id: String?
    let state: RemoteState?
    let error: String?
}
