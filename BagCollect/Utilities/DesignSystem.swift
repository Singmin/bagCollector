import SwiftUI

enum AppTheme {
    static let pagePadding: CGFloat = 22
    static let cardCornerRadius: CGFloat = 28
    static let itemWidth: CGFloat = 108
    static let itemHeight: CGFloat = 168

    static let paper = Color("Paper")
    static let paperDeep = Color("PaperDeep")
    static let paperLight = Color("PaperLight")
    static let ink = Color("Ink")
    static let mutedInk = Color("MutedInk")
    static let hairline = ink.opacity(0.10)

    static var background: Color { paper }
    static var secondaryBackground: Color { paperLight.opacity(0.82) }

    static var paperGradient: LinearGradient {
        LinearGradient(
            colors: [paperDeep.opacity(0.88), paperLight],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static func shelfTint(_ theme: ShelfTheme) -> Color {
        switch theme {
        case .sage: Color("ShelfSage")
        case .amber: Color("ShelfAmber")
        case .sky: Color("ShelfBlue")
        case .rose: Color("ShelfRose")
        case .graphite: Color("ShelfGraphite")
        }
    }
}

extension Font {
    static var editorialHero: Font {
        .system(size: 45, weight: .bold, design: .serif)
    }

    static var editorialTitle: Font {
        .system(size: 34, weight: .bold, design: .serif)
    }

    static var editorialSection: Font {
        .system(size: 24, weight: .semibold, design: .serif)
    }

    static var editorialCardTitle: Font {
        .system(size: 16, weight: .semibold, design: .serif)
    }
}

struct EditorialEyebrow: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(1.7)
            .foregroundStyle(AppTheme.mutedInk)
    }
}

struct EditorialRoundButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(AppTheme.ink)
            .frame(width: 43, height: 43)
            .background(.white.opacity(configuration.isPressed ? 0.34 : 0.55), in: Circle())
            .overlay(Circle().stroke(AppTheme.hairline))
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}

struct EditorialPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.body, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(AppTheme.ink.opacity(configuration.isPressed ? 0.78 : 1), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

extension View {
    func editorialScreenBackground() -> some View {
        background(AppTheme.paper.ignoresSafeArea())
    }
}
