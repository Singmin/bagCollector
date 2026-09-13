import SwiftData
import SwiftUI
import UIKit

struct CollectibleArtwork: View {
    let item: Collectible
    var useThumbnail = true

    var body: some View {
        Group {
            if let data = useThumbnail ? (item.thumbnailImageData ?? item.cutoutImageData) : item.cutoutImageData,
               let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "photo.on.rectangle.angled")
                    .resizable()
                    .scaledToFit()
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(AppTheme.mutedInk)
                    .padding(30)
            }
        }
        .accessibilityHidden(true)
    }
}

struct CollectibleCard: View {
    let item: Collectible
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 6) {
            CollectibleArtwork(item: item)
                .frame(maxWidth: .infinity)
                .frame(height: compact ? 132 : 137, alignment: .bottom)
                .padding(compact ? 9 : 0)
                .background(
                    compact ? Color.white.opacity(0.50) : Color.clear,
                    in: RoundedRectangle(cornerRadius: compact ? 4 : 0)
                )
                .overlay {
                    if compact {
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(AppTheme.hairline.opacity(0.65))
                    }
                }
                .shadow(color: .black.opacity(compact ? 0 : 0.13), radius: 8, y: 7)

            Text(item.displayName)
                .font(compact ? .editorialCardTitle : .system(size: 13, weight: .medium, design: .serif))
                .lineLimit(1)

            if compact {
                Text(item.shelf?.name ?? ShelfStore.unfiledName)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.mutedInk)
                    .lineLimit(1)
            }
        }
        .frame(width: compact ? 116 : AppTheme.itemWidth)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.displayName)
        .accessibilityValue(item.shelf?.name ?? ShelfStore.unfiledName)
    }
}

struct CollectibleDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var deletionCenter: DeletionCenter

    let item: Collectible

    @State private var isEditing = false
    @State private var confirmDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                CollectibleArtwork(item: item, useThumbnail: false)
                    .frame(maxWidth: .infinity)
                    .frame(height: 330)
                    .padding(22)
                    .background(AppTheme.paperGradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(AppTheme.hairline))
                    .shadow(color: .black.opacity(0.08), radius: 18, y: 10)

                VStack(alignment: .leading, spacing: 7) {
                    EditorialEyebrow("PRIVATE OBJECT")
                    Text(item.displayName)
                        .font(.editorialTitle)
                    Text("\(item.shelf?.name ?? ShelfStore.unfiledName) · 加入于 \(item.addedAt.formatted(date: .long, time: .omitted))")
                        .font(.caption)
                        .foregroundStyle(AppTheme.mutedInk)
                }

                if !item.tags.isEmpty {
                    FlowLayout(spacing: 7) {
                        ForEach(item.tags, id: \.self) { tag in
                            Text("# \(tag)")
                                .font(.caption2)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 7)
                                .background(AppTheme.paperDeep, in: Capsule())
                        }
                    }
                }

                if !item.notes.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        EditorialEyebrow("COLLECTION NOTE")
                        Text(item.notes)
                            .font(.body)
                            .foregroundStyle(AppTheme.mutedInk)
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.48), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }

                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("删除收藏品", systemImage: "trash")
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(.red)
            }
            .padding(.horizontal, AppTheme.pagePadding)
            .padding(.top, 14)
            .padding(.bottom, 44)
        }
        .editorialScreenBackground()
        .preference(key: BottomBarVisibilityPreferenceKey.self, value: false)
        .navigationTitle("收藏详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑", systemImage: "slider.horizontal.3") {
                    isEditing = true
                }
            }
        }
        .fullScreenCover(isPresented: $isEditing) {
            AddCollectibleFlow(existingItem: item)
        }
        .confirmationDialog("确定删除这件收藏品？", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) {
                deletionCenter.delete(item, in: modelContext)
                dismiss()
            }
        } message: {
            Text("删除后可在页面底部短暂撤销。")
        }
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: .unspecified
            )
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var points: [CGPoint] = []

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }

        return (CGSize(width: maxWidth.isFinite ? maxWidth : x, height: y + lineHeight), points)
    }
}
