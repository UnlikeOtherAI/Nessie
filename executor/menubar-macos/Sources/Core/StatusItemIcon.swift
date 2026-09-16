import AppKit

/// The mark in the menu bar.
///
/// It is Nessie's own `N` (`assets/logo/nessie-icon-*.svg`), not a system glyph:
/// the first version of this app drew `circle.dashed` and an
/// `exclamationmark.triangle`, and among fifteen other status items that read as
/// a loading spinner belonging to nobody — a person told us they could not find
/// the icon at all. Three rules came out of that, and all three are asserted
/// below:
///
/// 1. **Always the same letter, always filled.** Every state draws the same `N`
///    and every state fills it. The second version stroked it instead, and
///    `markPath` is a composite of two stems plus the diagonal, so stroking
///    outlined *every* subpath — including the interior edges where the stems
///    meet the diagonal. At 18pt the letter dissolved into hairline loops that
///    read as two hollow lozenges. A stroked composite path can never be the
///    union outline; only a fill is.
/// 2. **State is said by tint and by a badge, not by a different picture.**
///    Stopped is the same letter at a lower tint. Attention is the letter plus a
///    dot, and it is the one state that moves: the mark steps aside by about a
///    sixth so the badge gets a corner of its own, because a dot laid over the
///    letterform reads as part of the letter rather than as a badge.
/// 3. **Always a template image.** A template is masked and tinted by the system,
///    which is the only way an icon is legible on a light menu bar, a dark one,
///    a tinted desktop behind a translucent bar, and in Reduce Transparency.
public enum StatusItemIcon {
    /// The menu bar's usable height is 22pt; 18pt is Apple's guidance for the
    /// drawn mark, which leaves the item its own breathing room.
    public static let size = NSSize(width: 18, height: 18)

    public static func image(for icon: MenuIcon) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            draw(icon, in: rect)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = accessibilityDescription(for: icon)
        return image
    }

    public static func accessibilityDescription(for icon: MenuIcon) -> String {
        switch icon {
        case .stopped: return "Nessie Executor, stopped"
        case .running: return "Nessie Executor, running"
        case .needsAttention: return "Nessie Executor, needs attention"
        }
    }

    private static func draw(_ icon: MenuIcon, in rect: NSRect) {
        switch icon {
        case .running:
            NSColor.black.set()
            markPath(in: rect).fill()
        case .stopped:
            // The same silhouette at a lower tint. This was a stroked composite
            // path, which outlines every subpath — including the interior edges
            // where the stems meet the diagonal — so at 18pt the N dissolved
            // into hairline loops nobody could read as a letter.
            NSColor.black.withAlphaComponent(0.35).set()
            markPath(in: rect).fill()
        case .needsAttention:
            // The badge gets its own corner rather than sitting on the
            // letterform: the mark steps aside, the dot takes the space, and
            // the cleared ring is what makes it read as a badge in one tint.
            let diameter = rect.width * 0.30
            let markBox = NSRect(
                x: rect.minX,
                y: rect.minY + diameter * 0.55,
                width: rect.width - diameter * 0.55,
                height: rect.height - diameter * 0.55
            )
            NSColor.black.set()
            markPath(in: markBox).fill()
            let badge = NSRect(x: rect.maxX - diameter, y: rect.minY, width: diameter, height: diameter)
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: badge.insetBy(dx: -diameter * 0.28, dy: -diameter * 0.28)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.black.set()
            NSBezierPath(ovalIn: badge).fill()
        }
    }

    /// Nessie's `N`, as the two rounded stems and the diagonal that the brand
    /// mark is built from. The proportions are read off
    /// `assets/logo/nessie-icon-dark.svg`; the arcs there become the round caps
    /// of the stems, which is what they draw at any size a menu bar uses.
    private static let markBounds = NSRect(x: 152.6, y: 123.8, width: 948.7, height: 995.0)

    private static func markPath(in rect: NSRect) -> NSBezierPath {
        let inset = rect.insetBy(dx: 1.5, dy: 1.0)
        let scale = min(inset.width / markBounds.width, inset.height / markBounds.height)
        let drawn = NSSize(width: markBounds.width * scale, height: markBounds.height * scale)
        let origin = NSPoint(
            x: inset.midX - drawn.width / 2,
            y: inset.midY - drawn.height / 2
        )

        // The SVG's y grows downward; AppKit's grows upward, so every y is
        // mirrored inside the mark's own box rather than by flipping the context.
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(
                x: origin.x + (x - markBounds.minX) * scale,
                y: origin.y + (markBounds.maxY - y) * scale
            )
        }
        func stem(left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat) -> NSBezierPath {
            let topLeft = point(left, top)
            let bottomRight = point(right, bottom)
            let box = NSRect(
                x: topLeft.x,
                y: bottomRight.y,
                width: bottomRight.x - topLeft.x,
                height: topLeft.y - bottomRight.y
            )
            return NSBezierPath(roundedRect: box, xRadius: box.width / 2, yRadius: box.width / 2)
        }

        let path = NSBezierPath()
        path.windingRule = .nonZero
        path.append(stem(left: 152.6, right: 478.5, top: 194.6, bottom: 1118.8))
        path.append(stem(left: 734.5, right: 1101.3, top: 123.8, bottom: 1117.5))

        let diagonal = NSBezierPath()
        diagonal.move(to: point(478.5, 194.0))
        diagonal.line(to: point(734.5, 484.9))
        diagonal.line(to: point(734.5, 938.3))
        diagonal.line(to: point(478.5, 656.9))
        diagonal.close()
        path.append(diagonal)
        return path
    }
}
