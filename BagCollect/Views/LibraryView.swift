import SwiftData
import SwiftUI

private enum LibrarySort: String, CaseIterable, Identifiable {
    case newest = "最新加入"
    case oldest = "最早加入"
    case name = "名称"

    var id: String { rawValue }
}

struct LibraryView: View {
    @Query private var items: [Collectible]
    @Query(sort: \Shelf.sortOrder) private var shelves: [Shelf]
    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var deletionCenter: DeletionCenter

    @State private var query = ""
    @State private var selectedShelfID: UUID?
    @State private var selectedTag: String?
    @State private var sort: LibrarySort = .newest

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    header
                    searchField
                        .padding(.top, 23)
                    shelfFilters
                        .padding(.top, 13)

                    Text("共 \(filteredItems.count) 件")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.mutedInk)
                        .padding(.horizontal, 21)
                        .padding(.top, 16)
                        .padding(.bottom, 12)

                    if filteredItems.isEmpty {
                        emptyState
                    } else {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(filteredItems) { item in
                                NavigationLink(value: item.id) {
                                    LibraryGridCard(item: item)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("删除", systemImage: "trash", role: .destructive) {
                                        deletionCenter.delete(item, in: modelContext)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 18)
                    }
                }
                .padding(.top, 22)
                .padding(.bottom, 126)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .editorialScreenBackground()
            .navigationDestination(for: UUID.self) { id in
                if let item = items.first(where: { $0.id == id }) {
                    CollectibleDetailView(item: item)
                } else {
                    ContentUnavailableView("收藏品不存在", systemImage: "questionmark.folder")
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                EditorialEyebrow("THE FULL ARCHIVE")
                Text("全部收藏")
                    .font(.editorialTitle)
                Text("把喜欢的东西，留在看得见的地方。")
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedInk)
                    .padding(.top, 2)
            }

            Spacer()

            Menu {
                Picker("排序", selection: $sort) {
                    ForEach(LibrarySort.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }

                if !availableTags.isEmpty {
                    Menu("标签") {
                        Button("全部标签") { selectedTag = nil }
                        ForEach(availableTags, id: \.self) { tag in
                            Button {
                                selectedTag = tag
                            } label: {
                                if selectedTag == tag {
                                    Label(tag, systemImage: "checkmark")
                                } else {
                                    Text(tag)
                                }
                            }
                        }
                    }
                }

                if activeFilter {
                    Divider()
                    Button("清除筛选", systemImage: "xmark.circle") {
                        selectedShelfID = nil
                        selectedTag = nil
                    }
                }
            } label: {
                Image(systemName: activeFilter ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
            }
            .buttonStyle(EditorialRoundButtonStyle())
            .accessibilityLabel("筛选与排序")
        }
        .padding(.horizontal, AppTheme.pagePadding)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .regular))
            TextField("搜索名称或标签", text: $query)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(AppTheme.mutedInk)
                }
                .accessibilityLabel("清空搜索")
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 50)
        .background(Color.white.opacity(0.56), in: Capsule())
        .overlay(Capsule().stroke(AppTheme.hairline))
        .padding(.horizontal, 18)
    }

    private var shelfFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(title: "全部", shelfID: nil)
                ForEach(shelves) { shelf in
                    filterChip(title: shelf.name, shelfID: shelf.id)
                }
            }
            .padding(.horizontal, 18)
        }
    }

    private func filterChip(title: String, shelfID: UUID?) -> some View {
        let selected = selectedShelfID == shelfID
        return Button {
            withAnimation(.easeOut(duration: 0.18)) { selectedShelfID = shelfID }
        } label: {
            Text(title)
                .font(.caption)
                .foregroundStyle(selected ? Color.white : AppTheme.mutedInk)
                .padding(.horizontal, 15)
                .frame(height: 35)
                .background(selected ? AppTheme.ink : Color.clear, in: Capsule())
                .overlay(Capsule().stroke(selected ? AppTheme.ink : AppTheme.hairline))
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 11) {
            Image(systemName: query.isEmpty ? "square.grid.2x2" : "magnifyingglass")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(AppTheme.mutedInk)
            Text(query.isEmpty ? "还没有收藏" : "没有找到收藏")
                .font(.editorialSection)
            Text(query.isEmpty ? "从中间的 ＋ 添加第一件收藏。" : "换一个名称、标签或展示架试试。")
                .font(.caption)
                .foregroundStyle(AppTheme.mutedInk)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 70)
    }

    private var activeFilter: Bool { selectedShelfID != nil || selectedTag != nil }

    private var availableTags: [String] {
        Array(Set(items.flatMap(\.tags))).sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    private var filteredItems: [Collectible] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = items.filter { item in
            let matchesQuery = normalizedQuery.isEmpty
                || item.displayName.localizedCaseInsensitiveContains(normalizedQuery)
                || item.tags.contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            let matchesShelf = selectedShelfID == nil || item.shelf?.id == selectedShelfID
            let matchesTag = selectedTag == nil || item.tags.contains(selectedTag ?? "")
            return matchesQuery && matchesShelf && matchesTag
        }
        switch sort {
        case .newest: return filtered.sorted { $0.addedAt > $1.addedAt }
        case .oldest: return filtered.sorted { $0.addedAt < $1.addedAt }
        case .name: return filtered.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        }
    }
}

private struct LibraryGridCard: View {
    let item: Collectible

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            CollectibleArtwork(item: item)
                .frame(maxWidth: .infinity)
                .frame(height: 176)
                .padding(14)
                .background(AppTheme.paperGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Text(item.displayName)
                .font(.editorialCardTitle)
                .lineLimit(1)

            Text("\(item.shelf?.name ?? ShelfStore.unfiledName) · \(item.addedAt.formatted(.dateTime.month(.twoDigits).day(.twoDigits)))")
                .font(.caption2)
                .foregroundStyle(AppTheme.mutedInk)
                .lineLimit(1)
        }
        .padding(11)
        .background(Color.white.opacity(0.49), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(AppTheme.hairline.opacity(0.58)))
    }
}
