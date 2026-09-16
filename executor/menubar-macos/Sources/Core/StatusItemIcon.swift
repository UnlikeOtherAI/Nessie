import AppKit

/// The mark in the menu bar.
///
/// It is Nessie's own `N` (`assets/logo/nessie-icon-*.svg`), not a system glyph:
/// the first version of this app drew `circle.dashed` and an
/// `exclamationmark.triangle`, and among fifteen other status items that read as
/// a loading spinner belonging to nobody — a person told us they could not find
/// the icon at all. Two rules came out of that, and both are asserted below:
///
/// 1. **One silhouette, always.** The footprint never changes between states, so
///    a person learns where it is once. State is said by how the mark is
///    *filled*, not by swapping in a different picture.
/// 2. **Always a template image.** A template is masked and tinted by the system,
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
        NSColor.black.set()
        switch icon {
        case .running:
            // Solid: the executor is working for you.
            markPath(in: rect).fill()
        case .stopped:
            // Outlined: the same mark, hollow. Legible at 18pt because the stroke
            // is a full point wide, unlike the hairline dashed circle it replaces.
            let path = markPath(in: rect)
            path.lineWidth = 1.2
            path.stroke()
        case .needsAttention:
            // Solid, with a badge punched out and re-filled at the corner. The
            // gap around the badge is what makes it read as a badge rather than
            // as part of the mark, in a single tint.
            let path = markPath(in: rect)
            path.fill()
            let badge = NSRect(
                x: rect.maxX - 7.5, y: rect.minY - 0.5, width: 7, height: 7
            )
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: badge.insetBy(dx: -1.4, dy: -1.4)).fill()
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
