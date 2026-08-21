import CoreImage.CIFilterBuiltins
import SwiftUI

struct BoothRootView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var store: BoothStore

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.04, green: 0.04, blue: 0.07), .black], startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()

            switch store.phase {
            case .setup:
                SetupView()
            case .idle:
                idle
            case .connecting:
                progress(title: "กำลังเชื่อมต่อกล้อง…", subtitle: store.cameraName)
            case .countdown(let value):
                countdown(value)
            case .review(let slot):
                review(slot)
            case .processing:
                progress(title: "กำลังจัดภาพและอัปโหลด…", subtitle: "อย่าปิดแอป")
            case .done:
                done
            case .error(let message):
                error(message)
            }
        }
        .foregroundStyle(.white)
    }

    private var idle: some View {
        VStack(spacing: 28) {
            Text(store.eventName).font(.system(size: 72, weight: .black, design: .rounded))
            Text("พร้อมถ่ายแล้ว").font(.title).foregroundStyle(.secondary)
            Button("แตะเพื่อเริ่ม") { Task { await store.start() } }
                .buttonStyle(PrimaryButtonStyle())
            Text(store.cameraName).font(.footnote).foregroundStyle(.secondary)
        }
        .onLongPressGesture(minimumDuration: 3) { store.openSetup() }
    }

    private func countdown(_ value: Int) -> some View {
        VStack(spacing: 22) {
            Text("เตรียมตัว").font(.largeTitle.bold())
            Text("\(value)")
                .font(.system(size: 280, weight: .black, design: .rounded))
                .contentTransition(.numericText())
            Text("รูปที่ \(min(store.shots.count + 1, store.totalShots)) / \(store.totalShots)")
                .font(.title2).foregroundStyle(.secondary)
        }
    }

    private func review(_ slot: Int) -> some View {
        HStack(spacing: 38) {
            if let shot = store.shots.first(where: { $0.slot == slot }) {
                Image(uiImage: shot.image)
                    .resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 24))
                    .shadow(radius: 30)
            }
            VStack(spacing: 22) {
                Text("รูปที่ \(slot)").font(.largeTitle.bold())
                Text("ชอบรูปนี้ไหม?").font(.title2).foregroundStyle(.secondary)
                Button(slot == store.totalShots ? "ยืนยันและรับรูป" : "ใช้รูปนี้") {
                    Task { await store.accept() }
                }.buttonStyle(PrimaryButtonStyle())
                Button("ถ่ายใหม่") { Task { await store.retake() } }
                    .buttonStyle(SecondaryButtonStyle())
                Button("ยกเลิก") { Task { await store.cancel() } }
                    .foregroundStyle(.secondary).padding(.top, 8)
            }
            .frame(width: 350)
        }
        .padding(38)
    }

    private var done: some View {
        HStack(spacing: 48) {
            if let url = store.shareURL {
                VStack(spacing: 14) {
                    Image(uiImage: qrImage(for: url.absoluteString))
                        .interpolation(.none).resizable().scaledToFit()
                        .frame(width: 360, height: 360)
                        .padding(22).background(.white).clipShape(RoundedRectangle(cornerRadius: 28))
                    Text("สแกนเพื่อรับรูป").font(.title2.bold())
                }
            }
            VStack(spacing: 24) {
                Text("เสร็จแล้ว!").font(.system(size: 64, weight: .black, design: .rounded))
                if let queue = store.queueNumber { Text("คิวปริ้น #\(queue)").font(.largeTitle.bold()).foregroundStyle(.yellow) }
                Button("กลับหน้าแรก") { Task { await store.reset() } }.buttonStyle(PrimaryButtonStyle())
            }
        }.padding(40)
    }

    private func progress(title: String, subtitle: String) -> some View {
        VStack(spacing: 24) {
            ProgressView().controlSize(.extraLarge).tint(.pink)
            Text(title).font(.largeTitle.bold())
            Text(subtitle).font(.title3).foregroundStyle(.secondary)
        }
    }

    private func error(_ message: String) -> some View {
        VStack(spacing: 24) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 78)).foregroundStyle(.yellow)
            Text("ระบบยังไม่พร้อม").font(.largeTitle.bold())
            Text(message).font(.title3).multilineTextAlignment(.center).frame(maxWidth: 700)
            Button("ลองใหม่") { Task { await store.prepare() } }.buttonStyle(PrimaryButtonStyle())
            Button("ตั้งค่า") { store.openSetup() }.buttonStyle(SecondaryButtonStyle())
        }
    }

    private func qrImage(for text: String) -> UIImage {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cgImage = context.createCGImage(output, from: output.extent) else { return UIImage() }
        return UIImage(cgImage: cgImage)
    }
}

private struct SetupView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var store: BoothStore

    var body: some View {
        Form {
            Section("เชื่อมต่อระบบ Photo Booth") {
                TextField("https://booth.example.com", text: $settings.serverURL)
                    .textInputAutocapitalization(.never).keyboardType(.URL)
                SecureField("IPAD_API_TOKEN", text: $settings.apiToken)
            }
            Section("กล้อง") {
                Toggle("ใช้กล้องจำลองสำหรับทดสอบ", isOn: $settings.demoCamera)
                if !settings.demoCamera {
                    Text("โหมด EOS R ต้องใส่ CascableCore SDK และไลเซนส์ก่อน")
                        .foregroundStyle(.orange)
                }
            }
            Button("บันทึกและตรวจระบบ") { Task { await store.prepare() } }
                .disabled(!settings.isConfigured)
        }
        .scrollContentBackground(.hidden)
        .frame(maxWidth: 720, maxHeight: 620)
        .padding(32)
    }
}

private struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title2.bold()).padding(.horizontal, 52).padding(.vertical, 20)
            .background(Color.pink.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(Capsule()).scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

private struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3.bold()).padding(.horizontal, 42).padding(.vertical, 17)
            .background(.white.opacity(configuration.isPressed ? 0.08 : 0.14))
            .clipShape(Capsule())
    }
}
