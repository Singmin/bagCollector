import Foundation
import SwiftData

enum Persistence {
    static func makeContainer(inMemory: Bool = false) -> ModelContainer {
        let schema = Schema([Shelf.self, Collectible.self])

        #if CLOUDKIT_ENABLED
        let configuration = ModelConfiguration(
            "BagCollect",
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            cloudKitDatabase: .automatic
        )
        #else
        let configuration = ModelConfiguration(
            "BagCollect",
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            cloudKitDatabase: .none
        )
        #endif

        do {
            return try ModelContainer(for: schema, configurations: configuration)
        } catch {
            fatalError("无法创建数据容器：\(error.localizedDescription)")
        }
    }
}

@MainActor
enum ShelfStore {
    static let unfiledName = "未分类"

    static func ensureUnfiledShelf(in context: ModelContext) -> Shelf {
        let descriptor = FetchDescriptor<Shelf>(
            predicate: #Predicate { $0.isSystem == true }
        )
        if let shelf = try? context.fetch(descriptor).first {
            return shelf
        }

        let shelf = Shelf(
            name: unfiledName,
            sortOrder: -1,
            theme: .graphite,
            isSystem: true
        )
        context.insert(shelf)
        try? context.save()
        return shelf
    }

    static func nextShelfOrder(in shelves: [Shelf]) -> Double {
        (shelves.map(\.sortOrder).max() ?? 0) + 1
    }

    static func nextItemOrder(in shelf: Shelf) -> Double {
        (shelf.items ?? []).map(\.shelfOrder).max().map { $0 + 1 } ?? 0
    }

    static func delete(_ shelf: Shelf, from context: ModelContext) {
        guard !shelf.isSystem else { return }
        let unfiled = ensureUnfiledShelf(in: context)
        let movingItems = shelf.items ?? []
        var nextOrder = nextItemOrder(in: unfiled)
        for item in movingItems {
            item.shelf = unfiled
            item.shelfOrder = nextOrder
            item.updatedAt = Date()
            nextOrder += 1
        }
        context.delete(shelf)
        try? context.save()
    }

    static func reorderItems(_ items: [Collectible]) {
        for (index, item) in items.enumerated() {
            item.shelfOrder = Double(index)
            item.updatedAt = Date()
        }
    }
}
