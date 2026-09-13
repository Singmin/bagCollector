import Foundation
import SwiftData

enum ShelfTheme: String, CaseIterable, Identifiable {
    case sage
    case amber
    case sky
    case rose
    case graphite

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sage: "鼠尾草"
        case .amber: "琥珀"
        case .sky: "雾蓝"
        case .rose: "浅粉"
        case .graphite: "石墨"
        }
    }
}

@Model
final class Shelf {
    var id: UUID = UUID()
    var name: String = ""
    var sortOrder: Double = 0
    var themeRawValue: String = ShelfTheme.sage.rawValue
    var isSystem: Bool = false
    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    @Relationship(deleteRule: .nullify, inverse: \Collectible.shelf)
    var items: [Collectible]? = []

    init(
        id: UUID = UUID(),
        name: String,
        sortOrder: Double,
        theme: ShelfTheme = .sage,
        isSystem: Bool = false,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.themeRawValue = theme.rawValue
        self.isSystem = isSystem
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var theme: ShelfTheme {
        get { ShelfTheme(rawValue: themeRawValue) ?? .sage }
        set { themeRawValue = newValue.rawValue }
    }
}

@Model
final class Collectible {
    var id: UUID = UUID()
    var name: String = "未命名收藏"
    var notes: String = ""
    var tagsStorage: String = ""
    var addedAt: Date = Date()
    var updatedAt: Date = Date()
    var shelfOrder: Double = 0

    @Attribute(.externalStorage) var originalImageData: Data?
    @Attribute(.externalStorage) var cutoutImageData: Data?
    @Attribute(.externalStorage) var maskImageData: Data?
    @Attribute(.externalStorage) var thumbnailImageData: Data?
    var enhancementEnabled: Bool = false
    var enhancementIntensity: Double = 0.55

    var shelf: Shelf?

    init(
        id: UUID = UUID(),
        name: String = "未命名收藏",
        notes: String = "",
        tags: [String] = [],
        addedAt: Date = Date(),
        updatedAt: Date = Date(),
        shelfOrder: Double = 0,
        originalImageData: Data? = nil,
        cutoutImageData: Data? = nil,
        maskImageData: Data? = nil,
        thumbnailImageData: Data? = nil,
        enhancementEnabled: Bool = false,
        enhancementIntensity: Double = 0.55,
        shelf: Shelf? = nil
    ) {
        self.id = id
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "未命名收藏"
        self.notes = notes
        self.tagsStorage = Self.encodeTags(tags)
        self.addedAt = addedAt
        self.updatedAt = updatedAt
        self.shelfOrder = shelfOrder
        self.originalImageData = originalImageData
        self.cutoutImageData = cutoutImageData
        self.maskImageData = maskImageData
        self.thumbnailImageData = thumbnailImageData
        self.enhancementEnabled = enhancementEnabled
        self.enhancementIntensity = min(1, max(0, enhancementIntensity))
        self.shelf = shelf
    }

    var tags: [String] {
        get {
            tagsStorage
                .split(separator: "\n")
                .map(String.init)
                .filter { !$0.isEmpty }
        }
        set { tagsStorage = Self.encodeTags(newValue) }
    }

    var displayName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "未命名收藏"
    }

    static func normalizedTags(from input: String) -> [String] {
        let separators = CharacterSet(charactersIn: ",，、;；\n")
        let values = input.components(separatedBy: separators)
        var seen = Set<String>()
        return values.compactMap { value in
            let tag = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !tag.isEmpty else { return nil }
            let key = tag.localizedLowercase
            guard seen.insert(key).inserted else { return nil }
            return tag
        }
    }

    private static func encodeTags(_ tags: [String]) -> String {
        normalizedTags(from: tags.joined(separator: "\n")).joined(separator: "\n")
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
