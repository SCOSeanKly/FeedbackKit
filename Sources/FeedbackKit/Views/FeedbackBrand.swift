//
//  FeedbackBrand.swift
//  FeedbackKit
//
//  The feedback suite's own identity: a "Powered by" badge with the mark the
//  web board shows in its footer (a speech bubble holding three rising bars).
//  Mirrors `BRAND` in worker/src/html.ts; rename in both places together.
//

import SwiftUI

public enum FeedbackBrand {
    /// Product name shown after "Powered by".
    public static let name = "Nuke"
}

/// The mark alone, drawn with shapes so it scales crisply at any size and
/// follows light/dark without separate assets.
public struct FeedbackBrandMark: View {
    @Environment(\.colorScheme) private var colorScheme
    private let size: CGFloat

    public init(size: CGFloat = 28) {
        self.size = size
    }

    public var body: some View {
        let ink: Color = colorScheme == .dark ? .white : Color(white: 0.11)
        let paper: Color = colorScheme == .dark ? .black : .white
        ZStack {
            RoundedRectangle(cornerRadius: size / 4, style: .continuous)
                .fill(ink)
            BrandBubble().fill(paper)
            BrandBars().fill(ink)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// "Powered by <name>" with the mark, for footers of feedback surfaces.
public struct FeedbackBrandBadge: View {
    public init() {}

    public var body: some View {
        HStack(spacing: 8) {
            FeedbackBrandMark(size: 28)
            VStack(alignment: .leading, spacing: 0) {
                Text("Powered by", bundle: .module)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(verbatim: FeedbackBrand.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Shapes (coordinates match the 32-unit SVG in html.ts)

private struct BrandBubble: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 32
        let body = Path(
            roundedRect: CGRect(x: 6 * s, y: 7 * s, width: 20 * s, height: 15 * s),
            cornerSize: CGSize(width: 3 * s, height: 3 * s),
            style: .continuous
        )
        var tail = Path()
        tail.move(to: CGPoint(x: 9 * s, y: 20 * s))
        tail.addLine(to: CGPoint(x: 9 * s, y: 26 * s))
        tail.addLine(to: CGPoint(x: 14 * s, y: 22 * s))
        tail.closeSubpath()
        // Union rather than two subpaths so winding never punches a hole.
        return body.union(tail)
    }
}

private struct BrandBars: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 32
        var path = Path()
        for (x, y, h) in [(11.0, 15.0, 4.5), (14.7, 12.5, 7.0), (18.4, 10.0, 9.5)] {
            path.addRoundedRect(
                in: CGRect(x: x * s, y: y * s, width: 2.6 * s, height: h * s),
                cornerSize: CGSize(width: 1.3 * s, height: 1.3 * s),
                style: .continuous
            )
        }
        return path
    }
}

#Preview("Badge") {
    VStack(spacing: 24) {
        FeedbackBrandBadge()
        FeedbackBrandMark(size: 64)
    }
    .padding()
}
