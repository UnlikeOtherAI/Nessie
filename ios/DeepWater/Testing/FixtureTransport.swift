#if DEBUG
    import Foundation

    /// Compiled out of Release. Explicit UI-test launches intercept every request; nothing reaches a service.
    class FixtureTransport: URLProtocol {
        private static let lock = NSLock()
        private static var launches: [String: JSONValue] = [:]
        private static var projects: [JSONValue] = [
            .object([
                "id": .string("44444444-4444-4444-8444-444444444444"),
                "title": .string("Climate and energy"), "run_count": .number(2)
            ])
        ]

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func stopLoading() {}

        override func startLoading() {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            do {
                let (status, payload) = try response()
                guard let url = request.url,
                    let response = HTTPURLResponse(
                        url: url, statusCode: status, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"])
                else {
                    throw ServiceError.invalidResponse
                }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: try JSONEncoder().encode(payload))
                client?.urlProtocolDidFinishLoading(self)
            } catch { client?.urlProtocol(self, didFailWithError: error) }
        }

        private func response() throws -> (Int, JSONValue) {
            guard let requestURL = request.url else { throw ServiceError.invalidResponse }
            let path = requestURL.path
            let method = request.httpMethod ?? "GET"
            let arguments = ProcessInfo.processInfo.arguments
            if path == "/v1/auth/refresh" {
                if arguments.contains("--signed-out") { return (401, .object([:])) }
                return (200, .object(["access_token": .string(Self.token)]))
            }
            if path == "/v1/auth/logout" { return (200, .object(["ok": .bool(true)])) }
            if let result = try researchResponse(path: path, method: method, arguments: arguments) { return result }
            if path == "/v1/billing/account" { return (200, .object(["can_be_private": .bool(true)])) }
            if path == "/v1/billing/credits" {
                return (
                    200,
                    .object([
                        "credit_balance": .object([
                            "display": .string("1,240 credits"),
                            "description": .string("Available for this team’s research.")
                        ])
                    ])
                )
            }
            if path == "/v1/billing/statement" { return (200, Self.statement) }
            if path == "/v1/admin/profile" { return (200, .object(["webhook_url": .null])) }
            if path == "/v1/admin/keys" { return (200, .object(["keys": .array([])])) }
            if path == "/v1/admin/workspace/members" {
                return (
                    200,
                    .object([
                        "members": .array([
                            .object([
                                "uoa_sub": .string("fixture-user"),
                                "name": .string("Alex Morgan"), "email": .string("alex@example.test"),
                                "team_role": .string("owner")
                            ])
                        ])
                    ])
                )
            }
            if path == "/v1/admin/workspace/invitations" { return (200, .object(["invitations": .array([])])) }
            if path == "/v1/auth/workspaces" { return (200, Self.directory) }
            return (404, .object(["detail": .string("No fixture for this request.")]))
        }

        private func researchResponse(path: String, method: String, arguments: [String]) throws -> (Int, JSONValue)? {
            guard let requestURL = request.url else { throw ServiceError.invalidResponse }
            if path == "/v1/admin/runs" {
                if arguments.contains("--offline") { throw URLError(.notConnectedToInternet) }
                let query = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let search = query.first { $0.name == "q" }?.value ?? ""
                let status = query.first { $0.name == "status" }?.value
                var runs = arguments.contains("--empty") ? [] : Self.runs
                runs += Array(Self.launches.values)
                runs = runs.filter { run in
                    (search.isEmpty || run["query"].text.localizedCaseInsensitiveContains(search))
                        && (status == nil || run["status"].text == status)
                }
                return (200, .object(["runs": .array(runs), "total": .number(Double(runs.count))]))
            }
            if path == "/v1/admin/projects" {
                if method == "POST" {
                    let project: JSONValue = .object([
                        "id": .string(UUID().uuidString.lowercased()),
                        "title": body["title"], "run_count": .number(0)
                    ])
                    Self.projects.append(project)
                    return (201, project)
                }
                return (
                    200, .object(["projects": .array(Self.projects), "total": .number(Double(Self.projects.count))])
                )
            }
            if path == "/v1/admin/research", method == "POST" { return try launch(arguments: arguments) }
            if path.hasPrefix("/v1/admin/runs/") {
                let parts = path.split(separator: "/")
                if parts.last == "events" {
                    return (
                        200,
                        .object([
                            "events": .array([
                                .object([
                                    "at": .string("2026-09-23T10:42:00Z"), "kind": .string("terminal"),
                                    "message": .string("Report ready. Sources checked.")
                                ])
                            ])
                        ])
                    )
                }
                if parts.count == 4 {
                    let run = (Self.runs + Array(Self.launches.values)).first { $0["id"].text == String(parts[3]) }
                    return run.map { (200, $0) } ?? (404, .object([:]))
                }
                return (200, .object(["id": .string(String(parts[3])), "status": .string("cancelled")]))
            }
            if path.hasSuffix("/sources") { return (200, .object(["sources": .array(Self.sources)])) }
            return nil
        }

        private func launch(arguments: [String]) throws -> (Int, JSONValue) {
            guard let key = request.value(forHTTPHeaderField: "Idempotency-Key"), UUID(uuidString: key) != nil,
                body["query"].string != nil, body["output_tier"].text == "full"
            else {
                return (400, .object(["detail": .string("Launch contract mismatch.")]))
            }
            if let existing = Self.launches[key] { return (202, existing) }
            let value = Self.run(
                id: "33333333-3333-4333-8333-333333333333", title: body["query"].text, status: "queued")
            Self.launches[key] = value
            if arguments.contains("--launch-uncertain") { throw URLError(.timedOut) }
            return (202, value)
        }

        private var body: JSONValue {
            if let data = request.httpBody { return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null }
            guard let stream = request.httpBodyStream else { return .null }
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        }

        static var token: String {
            let claims = """
                {"sub":"fixture-user","name":"Alex Morgan","email":"alex@example.test",
                 "active":{"orgId":"fixture-org","teamId":"fixture-team","teamRole":"owner"},"tv":1}
                """
            let data = Data(claims.utf8)
            let payload = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            return "fixture.\(payload).fixture"
        }

        static var runs: [JSONValue] {
            [
                run(
                    id: "11111111-1111-4111-8111-111111111111", title: "The future of clean energy storage",
                    status: "complete"),
                run(
                    id: "22222222-2222-4222-8222-222222222222", title: "How cities adapt to extreme heat",
                    status: "gathering")
            ]
        }

        static func run(id: String, title: String, status: String) -> JSONValue {
            .object([
                "id": .string(id), "query": .string(title), "title": .string(title), "status": .string(status),
                "depth": .string("standard"), "urls_fetched": .number(status == "complete" ? 24 : 8),
                "created_at": .string("2026-09-23T10:00:00Z"), "is_public": .bool(false),
                "full_report_md": status == "complete" ? .string(report) : .null,
                "mutation_capabilities": .object([
                    "extend": .bool(status == "complete"),
                    "publish": .bool(status == "complete"), "pause": .bool(status == "gathering"),
                    "cancel": .bool(status == "gathering")
                ])
            ])
        }

        static let report = """
            # The future of clean energy storage

            Sample content for checking the native reading experience. This is not a live research result.

            ## What matters most

            Energy storage matches renewable supply to demand. Technologies suit different durations.

            **Lithium-ion batteries** serve short-duration needs. Longer-duration storage has other trade-offs.

            ## Evidence and open questions

            Compare lifetime cost, energy losses, and the conditions of each deployment before drawing conclusions.

            Read the original material from the [International Energy Agency](https://www.iea.org).
            """

        static let sources: [JSONValue] = [
            .object([
                "title": .string("Energy storage — IEA"),
                "url": .string("https://www.iea.org/energy-system/electricity/grid-scale-storage")
            ]),
            .object(["title": .string("Renewable energy research"), "url": .string("https://www.nrel.gov/research/")])
        ]
        static let statement: JSONValue = .object([
            "plan": .object([
                "display_name": .string("Research team"),
                "monthly_subscription": .object(["display": .string("Sample plan")])
            ]),
            "commercial_lines": .array([]), "totals": .array([]), "actions": .array([])
        ])
        static let directory: JSONValue = .object([
            "source": .string("uoa"),
            "organizations": .array([
                .object([
                    "orgId": .string("fixture-org"), "name": .string("Example organization"),
                    "teams": .array([
                        .object([
                            "teamId": .string("fixture-team"), "name": .string("Research team"), "active": .bool(true)
                        ])
                    ])
                ])
            ])
        ])
    }
#endif
