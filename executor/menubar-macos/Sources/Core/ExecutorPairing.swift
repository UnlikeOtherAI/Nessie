import Foundation

/// The shared runtime's JSON pairing boundary. Names are read live from Nessie,
/// retained only for display, and never written to another identity store.
public struct ExecutorPairing: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case waiting, confirmation, paired, alreadyPaired, expired, cancelled, idle
    }

    public let status: Status
    public let code: String?
    public let expiresAt: String?
    public let machineName: String?
    public let organizationName: String?
    public let teamName: String?
    public let fingerprint: String?
    public let apiBaseUrl: String?
    public let claimDigest: String?

    public static func decode(_ data: Data) throws -> ExecutorPairing {
        let pairing = try JSONDecoder().decode(ExecutorPairing.self, from: data)
        if pairing.status == .waiting {
            guard let code = pairing.code, code.utf8.count == 8,
                  code.utf8.allSatisfy({ (48...57).contains($0) }), pairing.expiration != nil else {
                throw ExecutorRefusal("Nessie could not provide a pairing code. Try again.")
            }
        }
        if pairing.status == .confirmation {
            guard let organization = pairing.organizationName, !organization.isEmpty,
                  let fingerprint = pairing.fingerprint, !fingerprint.isEmpty,
                  let claimDigest = pairing.claimDigest, !claimDigest.isEmpty,
                  pairing.expiration != nil else {
                throw ExecutorRefusal("Nessie could not identify this connection. Cancel and try again.")
            }
        }
        return pairing
    }

    public var expiration: Date? {
        guard let expiresAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }

    public var isPending: Bool { status == .waiting || status == .confirmation }
    public var isPaired: Bool { status == .paired || status == .alreadyPaired }

    public var connectionName: String? {
        guard let organizationName, !organizationName.isEmpty else { return nil }
        guard let teamName, !teamName.isEmpty else { return organizationName }
        return "\(organizationName), in the \(teamName) team"
    }
}
