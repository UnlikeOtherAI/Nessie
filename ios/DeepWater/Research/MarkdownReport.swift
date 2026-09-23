import SwiftUI

/// Native selectable text. Parsing is limited to Markdown structure, never research meaning.
struct MarkdownReport: View {
    let text: String
    var title = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(ReportBlock.parse(text, title: title).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let content):
                    Text(inline(content)).font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                case .paragraph(let content):
                    Text(inline(content)).frame(maxWidth: .infinity, alignment: .leading)
                case .code(let content):
                    ScrollView(.horizontal) {
                        Text(content).font(.system(.callout, design: .monospaced)).padding(12)
                    }.background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                case .table(let rows):
                    ScrollView(.horizontal) {
                        Grid(alignment: .topLeading, horizontalSpacing: 20, verticalSpacing: 12) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        Text(inline(cell)).fontWeight(index == 0 ? .semibold : .regular)
                                            .frame(minWidth: 100, maxWidth: 240, alignment: .leading)
                                    }
                                }
                                if index == 0 { Divider() }
                            }
                        }.padding(.vertical, 4)
                    }.accessibilityLabel("Report table")
                }
            }
        }
        .frame(maxWidth: 760, alignment: .leading)
        .textSelection(.enabled)
        .padding(.vertical, 8)
        .accessibilityIdentifier("reportContent")
    }

    private func inline(_ content: String) -> AttributedString {
        (try? AttributedString(markdown: content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(content)
    }
}

enum ReportBlock: Equatable {
    case heading(Int, String)
    case paragraph(String)
    case code(String)
    case table([[String]])

    static func parse(_ text: String, title: String = "") -> [ReportBlock] {
        let lines = text.components(separatedBy: .newlines)
        var result: [ReportBlock] = []
        var paragraph: [String] = []
        var index = 0
        func flush() {
            if !paragraph.isEmpty {
                result.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }
        while index < lines.count {
            let line = lines[index]
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                flush()
                let fence = String(line.prefix(3))
                var code: [String] = []
                index += 1
                while index < lines.count && !lines[index].hasPrefix(fence) {
                    code.append(lines[index])
                    index += 1
                }
                result.append(.code(code.joined(separator: "\n")))
            } else if let heading = heading(line) {
                flush()
                if !(result.isEmpty && heading.0 == 1 && heading.1 == title) {
                    result.append(.heading(heading.0, heading.1))
                }
            } else if index + 1 < lines.count, line.contains("|"), isTableDivider(lines[index + 1]) {
                flush()
                var rows = [cells(line)]
                index += 2
                while index < lines.count && lines[index].contains("|") && !lines[index].isEmpty {
                    rows.append(cells(lines[index]))
                    index += 1
                }
                result.append(.table(rows))
                continue
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
            } else {
                paragraph.append(line)
            }
            index += 1
        }
        flush()
        return result
    }

    private static func heading(_ line: String) -> (Int, String)? {
        let count = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(count), line.dropFirst(count).first == " " else { return nil }
        return (count, String(line.dropFirst(count + 1)))
    }

    private static func cells(_ line: String) -> [String] {
        var content = line.trimmingCharacters(in: .whitespaces)
        if content.hasPrefix("|") { content.removeFirst() }
        if content.hasSuffix("|") { content.removeLast() }
        return content.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableDivider(_ line: String) -> Bool {
        guard line.contains("|") else { return false }
        return cells(line).allSatisfy { cell in
            let dashes = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return dashes.count >= 3 && dashes.allSatisfy { $0 == "-" }
        }
    }
}
