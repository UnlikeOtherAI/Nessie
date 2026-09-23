import CryptoKit
import Foundation

struct ResearchDraft {
    var query = ""
    var depth = "standard"
    var projectId = ""
    var isPublic = false
    var language = "en"
    var style = "standard"
    var chapterDepth = "standard"
    var quality = "standard"
    var recency = "any"
    var pillars: [String] = []

    var body: JSONValue {
        var fields: [String: JSONValue] = [
            "query": .string(query.trimmingCharacters(in: .whitespacesAndNewlines)),
            "depth": .string(depth), "public": .bool(isPublic),
            "output_tier": .string("full"), "report_on_demand": .bool(false),
            "output_language": .string(language), "writing_style": .string(style),
            "chapter_depth": .string(chapterDepth), "search_provider": .string("serper"),
            "search_quality": .string(quality), "recency": .string(recency),
            "source": .string("playground")
        ]
        if !projectId.isEmpty { fields["project_id"] = .string(projectId) }
        if !pillars.isEmpty { fields["pillars"] = .strings(pillars) }
        return .object(fields)
    }
}

struct ResearchLaunch: Codable, Equatable {
    let key: String
    let subject: String
    let organization: String
    let team: String
    let body: JSONValue

    init(identity: SessionIdentity, body: JSONValue) {
        key = UUID().uuidString.lowercased()
        subject = identity.subject
        organization = identity.organization
        team = identity.team
        self.body = body
    }

    func belongs(to identity: SessionIdentity) -> Bool {
        subject == identity.subject && organization == identity.organization && team == identity.team
    }
}

struct ResearchLaunchStore {
    let identity: SessionIdentity
    private var file: URL {
        let parts = [identity.subject, identity.organization, identity.team]
        // Length-delimited identity avoids ambiguous string concatenation; only stable references are retained.
        let key = parts.map { "\($0.utf8.count):\($0)" }.joined()
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.applicationSupportDirectory.appending(path: "DeepWater")
            .appending(path: "pending-\(digest).json")
    }
    func read() throws -> ResearchLaunch? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let launch = try JSONDecoder().decode(ResearchLaunch.self, from: Data(contentsOf: file))
        guard launch.belongs(to: identity) else { throw ServiceError.invalidResponse }
        return launch
    }
    func save(_ launch: ResearchLaunch) throws {
        guard launch.belongs(to: identity) else { throw ServiceError.invalidResponse }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(launch).write(
            to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var resource = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try resource.setResourceValues(values)
    }
    func clear() throws {
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}
