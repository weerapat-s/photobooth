import Foundation

struct BoothAPIClient {
    let baseURL: URL
    let token: String

    private func request(path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 300
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIEnvelope.self, from: data).error) ?? "HTTP \(http.statusCode)"
            throw APIError.server(message)
        }
        return data
    }

    func bootstrap() async throws -> BootstrapResponse {
        let data = try await request(path: "/api/ipad/bootstrap")
        return try JSONDecoder().decode(BootstrapResponse.self, from: data)
    }

    func startSession() async throws -> APIEnvelope {
        let data = try await request(path: "/api/ipad/session", method: "POST")
        return try JSONDecoder().decode(APIEnvelope.self, from: data)
    }

    func upload(slot: Int, jpeg: Data) async throws -> APIEnvelope {
        let data = try await request(
            path: "/api/ipad/session/photo/\(slot)",
            method: "PUT",
            body: jpeg,
            contentType: "image/jpeg"
        )
        return try JSONDecoder().decode(APIEnvelope.self, from: data)
    }

    func finish() async throws -> APIEnvelope {
        let data = try await request(path: "/api/ipad/session/finish", method: "POST")
        return try JSONDecoder().decode(APIEnvelope.self, from: data)
    }

    func discard() async throws {
        _ = try await request(path: "/api/ipad/session", method: "DELETE")
    }

    func reset() async throws {
        _ = try await request(path: "/api/ipad/session/reset", method: "POST")
    }
}

enum APIError: LocalizedError {
    case server(String)

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        }
    }
}
