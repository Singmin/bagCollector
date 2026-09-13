import SwiftData
import SwiftUI

struct ShelfManagementView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Shelf.sortOrder) private var shelves: [Shelf]

    @State private var editingShelf: Shelf?
    @State private var isAdding = false
    @State private var shelfToDelete: Shelf?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(shelves) { shelf in
                        Button {
                            editingShelf = shelf
                        } label: {
                            HStack(spacing: 14) {
                                Circle()
                                    .fill(AppTheme.shelfTint(shelf.theme))
                                    .frame(width: 18, height: 18)
                                VStack(alignment: .leading) {
                                    Text(shelf.name)
                                        .foregroundStyle(.primary)
                                    Text("\((shelf.items ?? []).count) 件收藏")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if shelf.isSystem {
                                    Text("系统")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .disabled(shelf.isSystem)
                        .swipeActions {
                            if !shelf.isSystem {
                                Button("删除", systemImage: "trash", role: .destructive) {
                                    shelfToDelete = shelf
                                }
                            }
                        }
                    }
                    .onMove(perform: move)
                } footer: {
                    Text("删除展示架不会删除收藏品，其中的内容会移到“未分类”。")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.paper)
            .navigationTitle("管理展示架")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.editMode, .constant(.active))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("新建展示架", systemImage: "plus") { isAdding = true }
                }
            }
            .sheet(isPresented: $isAdding) {
                ShelfEditorSheet(shelf: nil)
            }
            .sheet(item: $editingShelf) { shelf in
                ShelfEditorSheet(shelf: shelf)
            }
            .confirmationDialog("删除“\(shelfToDelete?.name ?? "")”？", isPresented: deleteDialogPresented) {
                Button("删除展示架", role: .destructive) {
                    if let shelfToDelete {
                        ShelfStore.delete(shelfToDelete, from: modelContext)
                    }
                    shelfToDelete = nil
                }
            } message: {
                Text("收藏品会移到“未分类”。")
            }
        }
    }

    private var deleteDialogPresented: Binding<Bool> {
        Binding(
            get: { shelfToDelete != nil },
            set: { if !$0 { shelfToDelete = nil } }
        )
    }

    private func move(from source: IndexSet, to destination: Int) {
        var reordered = shelves
        reordered.move(fromOffsets: source, toOffset: destination)
        for (index, shelf) in reordered.enumerated() {
            shelf.sortOrder = Double(index)
            shelf.updatedAt = Date()
        }
        try? modelContext.save()
    }
}

private struct ShelfEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Shelf.sortOrder) private var shelves: [Shelf]
    let shelf: Shelf?

    @State private var name: String
    @State private var theme: ShelfTheme

    init(shelf: Shelf?) {
        self.shelf = shelf
        _name = State(initialValue: shelf?.name ?? "")
        _theme = State(initialValue: shelf?.theme ?? .sage)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("名称") {
                    TextField("例如：旅行纸袋", text: $name)
                }
                Section("展示架颜色") {
                    Picker("颜色", selection: $theme) {
                        ForEach(ShelfTheme.allCases) { theme in
                            Label {
                                Text(theme.title)
                            } icon: {
                                Circle().fill(AppTheme.shelfTint(theme))
                            }
                            .tag(theme)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.paper)
            .navigationTitle(shelf == nil ? "新建展示架" : "编辑展示架")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", systemImage: "checkmark") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(trimmedName.isEmpty)
                }
            }
        }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() {
        if let shelf {
            shelf.name = trimmedName
            shelf.theme = theme
            shelf.updatedAt = Date()
        } else {
            modelContext.insert(
                Shelf(
                    name: trimmedName,
                    sortOrder: ShelfStore.nextShelfOrder(in: shelves),
                    theme: theme
                )
            )
        }
        try? modelContext.save()
        dismiss()
    }
}
