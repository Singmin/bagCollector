import Foundation
import SwiftData

struct CollectibleSnapshot {
    let id: UUID
    let name: String
    let notes: String
    let tags: [String]
    let addedAt: Date
    let updatedAt: Date
    let shelfOrder: Double
    let originalImageData: Data?
    let cutoutImageData: Data?
    let maskImageData: Data?
    let thumbnailImageData: Data?
    let enhancementEnabled: Bool
    let enhancementIntensity: Double
    let shelfID: UUID?

    init(_ item: Collectible) {
        id = item.id
        name = item.name
        notes = item.notes
        tags = item.tags
        addedAt = item.addedAt
        updatedAt = item.updatedAt
        shelfOrder = item.shelfOrder
        originalImageData = item.originalImageData
        cutoutImageData = item.cutoutImageData
        maskImageData = item.maskImageData
        thumbnailImageData = item.thumbnailImageData
        enhancementEnabled = item.enhancementEnabled
        enhancementIntensity = item.enhancementIntensity
        shelfID = item.shelf?.id
    }
}

@MainActor
final class DeletionCenter: ObservableObject {
    @Published private(set) var pendingSnapshot: CollectibleSnapshot?
    private var clearTask: Task<Void, Never>?

    func delete(_ item: Collectible, in context: ModelContext) {
        pendingSnapshot = CollectibleSnapshot(item)
        context.delete(item)
        try? context.save()
        clearTask?.cancel()
        clearTask = Task {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            pendingSnapshot = nil
        }
    }

    func undo(in context: ModelContext) {
        guard let snapshot = pendingSnapshot else { return }
        let descriptor = FetchDescriptor<Shelf>()
        let shelves = (try? context.fetch(descriptor)) ?? []
        let shelf = shelves.first { $0.id == snapshot.shelfID }
            ?? ShelfStore.ensureUnfiledShelf(in: context)
        let item = Collectible(
            id: snapshot.id,
            name: snapshot.name,
            notes: snapshot.notes,
            tags: snapshot.tags,
            addedAt: snapshot.addedAt,
            updatedAt: Date(),
            shelfOrder: snapshot.shelfOrder,
            originalImageData: snapshot.originalImageData,
            cutoutImageData: snapshot.cutoutImageData,
            maskImageData: snapshot.maskImageData,
            thumbnailImageData: snapshot.thumbnailImageData,
            enhancementEnabled: snapshot.enhancementEnabled,
            enhancementIntensity: snapshot.enhancementIntensity,
            shelf: shelf
        )
        context.insert(item)
        try? context.save()
        clearTask?.cancel()
        pendingSnapshot = nil
    }
}
