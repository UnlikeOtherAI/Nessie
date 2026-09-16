import Foundation

/// The three surfaces this app exists for, as one list.
///
/// They live in a single window behind one selector rather than in three
/// windows a person has to find separately: the first version opened a window
/// per surface from the menu, and there was no way to get from one to another —
/// a person could not tell they were three views of the same thing. The menu
/// lines still exist as doorways, and each one selects a section in that window.
public enum ConsoleSection: String, CaseIterable, Identifiable, Sendable {
    case settings
    case reach
    case tools

    public var id: String { rawValue }

    /// The selector's label. Short, because a segmented control has to fit
    /// three of them side by side.
    public var title: String {
        switch self {
        case .settings: return "Settings"
        case .reach: return "Where it can reach"
        case .tools: return "Tools it can run"
        }
    }

    /// The line in the status menu, which says the same thing in the same words.
    public var menuTitle: String { "\(title)…" }

    public var symbolName: String {
        switch self {
        case .settings: return "gearshape"
        case .reach: return "globe.badge.chevron.backward"
        case .tools: return "terminal"
        }
    }

    public var subtitle: String {
        switch self {
        case .settings:
            return "Pair this Mac, choose the folder it may read, and decide whether it starts at login."
        case .reach:
            return "Everything outside this list is outside the executor's reach."
        case .tools:
            return "The commands the guest may start. Anything that does not match this list is refused before a guest starts."
        }
    }
}
