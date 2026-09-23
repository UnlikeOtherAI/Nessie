import Foundation
import SwiftUI

struct ResearchRun: Identifiable, Hashable {
    let id: String
    let query: String
    let title: String
    let status: String
    let reportStatus: String
    let depth: String
    let sourceCount: Int
    let createdAt: String
    let report: String
    let fullReport: String
    let summaryStatus: String
    let summary: String
    let failure: String?
    let isPublic: Bool
    let capabilities: Set<String>

    init(_ value: JSONValue) throws {
        guard let id = value["id"].string, !id.isEmpty,
            let query = value["query"].string, let status = value["status"].string
        else {
            throw ServiceError.invalidResponse
        }
        self.id = id
        self.query = query
        self.status = status
        reportStatus = value["full_report_status"].text
        title = value["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? query
        depth = value["depth"].text
        sourceCount = value["urls_fetched"].int
        createdAt = value["created_at"].text
        fullReport = value["full_report_md"].text
        summary = value["report_md"].string ?? value["report"].text
        summaryStatus = value["report_status"].text
        report = fullReport.isEmpty ? summary : fullReport
        failure = value["failure_reason"].string
        isPublic = value["is_public"].bool
        capabilities = Set(value["mutation_capabilities"].object.filter { $0.value.bool }.map(\.key))
    }

    var reportIsActive: Bool {
        status == "complete"
            && ["pending", "assigning_cards", "generating_toc", "synthesising", "compiling"].contains(reportStatus)
    }
    var isActive: Bool {
        ["queued", "scoping", "gathering", "synthesising", "verifying"].contains(status)
            || reportIsActive || (status == "complete" && summaryStatus == "pending")
    }
    var statusLabel: String {
        if reportIsActive { return "Writing full report" }
        if status == "complete" && summaryStatus == "pending" { return "Writing summary" }
        if status == "complete" && reportStatus == "failed" { return "Summary available; full report failed" }
        switch status {
        case "complete": return "Ready to read"
        case "queued": return "Getting ready"
        case "scoping": return "Planning research"
        case "gathering": return "Finding sources"
        case "synthesising": return "Writing report"
        case "verifying": return "Checking evidence"
        case "paused": return "Paused"
        case "failed": return "Needs attention"
        case "cancelled": return "Cancelled"
        default: return status.capitalized
        }
    }
    var color: Color {
        if reportIsActive { return .blue }
        if status == "complete" && reportStatus == "failed" { return .orange }
        switch status {
        case "complete": return .green
        case "failed": return .orange
        case "cancelled", "paused": return .secondary
        default: return .blue
        }
    }
}

struct Project: Identifiable {
    let id: String
    let title: String
    let count: Int
    init(_ value: JSONValue) throws {
        guard let id = value["id"].string, let title = value["title"].string else {
            throw ServiceError.invalidResponse
        }
        self.id = id
        self.title = title
        count = value["run_count"].int
    }
}

struct SessionIdentity: Equatable {
    let subject: String
    let organization: String
    let team: String
    let name: String
    let email: String
    let role: String
    var canManage: Bool { ["admin", "owner"].contains(role) }

    /// Display only. Every read and mutation is authorized by the service.
    init(token: String) throws {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { throw ServiceError.invalidResponse }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload) else { throw ServiceError.invalidResponse }
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let subject = value["sub"].string, !subject.isEmpty,
            let org = value["active"]["orgId"].string, !org.isEmpty,
            let team = value["active"]["teamId"].string, !team.isEmpty
        else {
            throw ServiceError(status: 401, message: "Sign in and choose a team to continue.")
        }
        self.subject = subject
        organization = org
        self.team = team
        name = value["name"].text
        email = value["email"].text
        role = value["active"]["teamRole"].text
    }
}
