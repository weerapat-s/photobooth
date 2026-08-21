import Foundation
import UIKit

@MainActor
protocol CameraBackend {
    var displayName: String { get }
    func connect() async throws
    func captureJPEG(slot: Int) async throws -> Data
    func disconnect() async
}

enum CameraError: LocalizedError {
    case sdkNotInstalled
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .sdkNotInstalled:
            return "ยังไม่ได้ใส่ CascableCore SDK และไลเซนส์สำหรับ Canon EOS R"
        case .invalidImage:
            return "กล้องส่งข้อมูลภาพที่เปิดไม่ได้"
        }
    }
}

struct MockCameraBackend: CameraBackend {
    let displayName = "กล้องจำลอง"

    func connect() async throws {
        try await Task.sleep(for: .milliseconds(350))
    }

    func captureJPEG(slot: Int) async throws -> Data {
        let colors: [UIColor] = [.systemPink, .systemTeal, .systemIndigo, .systemOrange]
        let size = CGSize(width: 1800, height: 1200)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.jpegData(withCompressionQuality: 0.92) { context in
            colors[(slot - 1) % colors.count].setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))

            let title = "PHOTO \(slot)"
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 160, weight: .black),
                .foregroundColor: UIColor.white,
            ]
            let textSize = title.size(withAttributes: attributes)
            title.draw(
                at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2),
                withAttributes: attributes
            )
        }
    }

    func disconnect() async {}
}

/// จุดเชื่อม CascableCore: โครงแอปเรียกผ่าน CameraBackend จึงเปลี่ยนเฉพาะคลาสนี้เมื่อได้รับ SDK/license
struct EOSRUSBCameraBackend: CameraBackend {
    let displayName = "Canon EOS R (USB)"

    func connect() async throws {
        throw CameraError.sdkNotInstalled
    }

    func captureJPEG(slot: Int) async throws -> Data {
        throw CameraError.sdkNotInstalled
    }

    func disconnect() async {}
}
