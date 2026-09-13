import SwiftData
import SwiftUI

struct ShowcaseView: View {
    @Query(sort: \Shelf.sortOrder) private var shelves: [Shelf]
    @Query(sort: \Collectible.addedAt, order: .reverse) private var allItems: [Collectible]

    let openLibrary: () -> Void

    @State private var showShelfManager = false
    @State private var showSettings = false

    init(openLibrary: @escaping () -> Void = {}) {
        self.openLibrary = openLibrary
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 34) {
                    editorialHeader

                    if let latest = allItems.first {
                        LatestFeatureCard(item: latest)
                            .padding(.horizontal, 14)

                        recentSection

                        ForEach(Array(visibleShelves.enumerated()), id: \.element.id) { index, shelf in
                            ShelfStripView(
                                shelf: shelf,
                                items: sortedItems(in: shelf),
                                index: index + 1
                            )
                        }
                    } else {
                        emptyCabinet
                    }
                }
                .padding(.top, 18)
                .padding(.bottom, 126)
            }
            .scrollIndicators(.hidden)
            .editorialScreenBackground()
            .navigationDestination(for: UUID.self) { id in
                if let item = allItems.first(where: { $0.id == id }) {
                    CollectibleDetailView(item: item)
                } else {
                    ContentUnavailableView("收藏品不存在", systemImage: "questionmark.folder")
                }
            }
            .sheet(isPresented: $showShelfManager) {
                ShelfManagementView()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private var visibleShelves: [Shelf] {
        shelves.filter { !($0.isSystem && ($0.items ?? []).isEmpty) }
    }

    private var editorialHeader: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                EditorialEyebrow("MY PRIVATE CABINET")
                Text("BagCollect")
                    .font(.editorialHero)
                    .tracking(-1.5)
                    .foregroundStyle(AppTheme.ink)
                Text("\(allItems.count) 件收藏 · \(visibleShelves.filter { !$0.isSystem }.count) 个展示架")
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedInk)
                    .padding(.top, 2)
            }

            Spacer(minLength: 4)

            HStack(spacing: 8) {
                Button {
                    showShelfManager = true
                } label: {
                    Image(systemName: "cabinet")
                }
                .buttonStyle(EditorialRoundButtonStyle())
                .accessibilityLabel("管理展示架")

                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(EditorialRoundButtonStyle())
                .accessibilityLabel("设置")
            }
        }
        .padding(.horizontal, AppTheme.pagePadding)
        .accessibilityElement(children: .contain)
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    EditorialEyebrow("RECENTLY ADDED")
                    Text("最近加入")
                        .font(.editorialSection)
                }
                Spacer()
                Button(action: openLibrary) {
                    HStack(spacing: 5) {
                        Text("查看全部")
                        Image(systemName: "arrow.right")
                    }
                    .font(.caption2)
                    .foregroundStyle(AppTheme.mutedInk)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, AppTheme.pagePadding)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 13) {
                    ForEach(Array(allItems.prefix(5))) { item in
                        NavigationLink(value: item.id) {
                            CollectibleCard(item: item, compact: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, AppTheme.pagePadding)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
        }
    }

    private var emptyCabinet: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles.rectangle.stack")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(AppTheme.mutedInk)
            Text("开始你的私人陈列柜")
                .font(.editorialSection)
            Text("点击下方的 ＋，从一张喜欢的照片开始。")
                .font(.subheadline)
                .foregroundStyle(AppTheme.mutedInk)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 74)
        .padding(.horizontal, 28)
        .background(AppTheme.paperGradient, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).stroke(AppTheme.hairline))
        .padding(.horizontal, 14)
    }

    private func sortedItems(in shelf: Shelf) -> [Collectible] {
        (shelf.items ?? []).sorted {
            if $0.shelfOrder == $1.shelfOrder { return $0.addedAt < $1.addedAt }
            return $0.shelfOrder < $1.shelfOrder
        }
    }
}

private struct LatestFeatureCard: View {
    let item: Collectible

    var body: some View {
        NavigationLink(value: item.id) {
            VStack(spacing: 0) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        EditorialEyebrow("JUST IN")
                        Text("最近上传")
                            .font(.editorialSection)
                    }
                    Spacer()
                    Text(Self.dateFormatter.string(from: item.addedAt))
                        .font(.system(size: 10, weight: .medium))
                        .tracking(1)
                        .foregroundStyle(AppTheme.mutedInk)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(.white.opacity(0.62), in: Capsule())
                }

                ZStack {
                    RadialGradient(
                        colors: [Color.orange.opacity(0.20), Color.orange.opacity(0)],
                        center: .center,
                        startRadius: 8,
                        endRadius: 128
                    )
                    .frame(width: 260, height: 260)

                    CollectibleArtwork(item: item, useThumbnail: false)
                        .frame(maxWidth: 210, maxHeight: 226)
                        .padding(.horizontal, 24)
                        .shadow(color: Color.black.opacity(0.16), radius: 14, y: 11)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 274)

                HStack(alignment: .bottom, spacing: 12) {
                    EditorialEyebrow("OBJECT · 001")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(item.displayName)
                            .font(.system(size: 20, weight: .semibold, design: .serif))
                            .lineLimit(1)
                        Text(item.shelf?.name ?? ShelfStore.unfiledName)
                            .font(.caption2)
                            .foregroundStyle(AppTheme.mutedInk)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 16)
            .background(AppTheme.paperGradient, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).stroke(AppTheme.hairline))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("最近上传，\(item.displayName)")
        .accessibilityIdentifier("latest-feature-card")
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MM.dd"
        return formatter
    }()
}

private struct ShelfStripView: View {
    @Environment(\.modelContext) private var modelContext

    let shelf: Shelf
    let items: [Collectible]
    let index: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    EditorialEyebrow(String(format: "SHELF %02d", index))
                    Text(shelf.name)
                        .font(.editorialSection)
                }
                Spacer()
                HStack(spacing: 7) {
                    Text("\(items.count) 件")
                    Image(systemName: "arrow.left.and.right")
                        .font(.caption)
                }
                .font(.caption2)
                .foregroundStyle(AppTheme.mutedInk)
                .accessibilityLabel("\(items.count) 件，可横向滑动")
            }
            .padding(.horizontal, AppTheme.pagePadding)

            if items.isEmpty {
                Text("这个展示架还是空的")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.mutedInk)
                    .frame(maxWidth: .infinity, minHeight: 116)
                    .background(shelfSurface)
                    .padding(.horizontal, 15)
            } else {
                ZStack(alignment: .bottom) {
                    shelfSurface
                        .padding(.leading, 15)

                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .bottom, spacing: 17) {
                            ForEach(items) { item in
                                NavigationLink(value: item.id) {
                                    CollectibleCard(item: item)
                                }
                                .buttonStyle(.plain)
                                .draggable(item.id.uuidString) {
                                    CollectibleCard(item: item)
                                        .padding(8)
                                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                                }
                                .dropDestination(for: String.self) { dropped, _ in
                                    guard let value = dropped.first,
                                          let sourceID = UUID(uuidString: value) else { return false }
                                    return reorder(sourceID: sourceID, before: item.id)
                                }
                                .accessibilityAction(named: "向左移动") { move(item, by: -1) }
                                .accessibilityAction(named: "向右移动") { move(item, by: 1) }
                            }
                        }
                        .padding(.horizontal, 28)
                        .padding(.top, 8)
                        .padding(.bottom, 14)
                        .scrollTargetLayout()
                    }
                    .scrollTargetBehavior(.viewAligned)
                }
                .frame(minHeight: 184)
            }
        }
    }

    private var shelfSurface: some View {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(AppTheme.shelfTint(shelf.theme).opacity(0.67))
            .frame(height: 56)
            .overlay {
                HStack {
                    screw
                    Spacer()
                    screw
                }
                .padding(.horizontal, 14)
            }
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(.white.opacity(0.48))
                    .frame(height: 1)
                    .padding(.horizontal, 9)
            }
            .shadow(color: Color.black.opacity(0.12), radius: 10, y: 7)
    }

    private var screw: some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [.white, Color.gray.opacity(0.9), AppTheme.ink.opacity(0.8)],
                    center: .topLeading,
                    startRadius: 0,
                    endRadius: 8
                )
            )
            .frame(width: 9, height: 9)
            .shadow(color: .black.opacity(0.25), radius: 1, y: 1)
    }

    private func reorder(sourceID: UUID, before targetID: UUID) -> Bool {
        guard sourceID != targetID,
              let sourceIndex = items.firstIndex(where: { $0.id == sourceID }),
              let targetIndex = items.firstIndex(where: { $0.id == targetID }) else { return false }
        var reordered = items
        let source = reordered.remove(at: sourceIndex)
        reordered.insert(source, at: targetIndex)
        ShelfStore.reorderItems(reordered)
        shelf.updatedAt = Date()
        try? modelContext.save()
        return true
    }

    private func move(_ item: Collectible, by delta: Int) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        let destination = max(0, min(items.count - 1, index + delta))
        guard destination != index else { return }
        var reordered = items
        reordered.swapAt(index, destination)
        ShelfStore.reorderItems(reordered)
        try? modelContext.save()
    }
}
