import SwiftData
import Testing
import UIKit
@testable import BagCollect

struct BagCollectTests {
    @Test
    func tagNormalizationRemovesWhitespaceAndDuplicates() {
        let tags = Collectible.normalizedTags(from: " 纸袋，旅行,纸袋；蓝色\n")
        #expect(tags == ["纸袋", "旅行", "蓝色"])
    }

    @Test
    func resizeHonorsLongestEdge() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 600)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1200, height: 600))
        }
        let resized = image.resized(longestEdge: 300)
        #expect(abs(resized.size.width - 300) < 0.5)
        #expect(abs(resized.size.height - 150) < 0.5)
    }

    @Test
    func maskPainterChangesMask() {
        let blackMask = UIImage.solidMask(size: CGSize(width: 100, height: 100), white: false)
        let painted = MaskPainter.paint(
            points: [CGPoint(x: 0.5, y: 0.5)],
            normalizedRadius: 0.1,
            adding: true,
            on: blackMask
        )
        #expect(blackMask.pngData() != painted.pngData())
    }

    @Test
    func manualSeedIsBlockingUntilEdited() {
        let image = testImage(size: CGSize(width: 200, height: 200))
        let mask = UIImage.solidMask(size: image.size, white: true)
        let report = DefaultImageQualityValidator().validate(
            image: image,
            mask: mask,
            context: QualityValidationContext(maskSource: .manualSeed, candidateCount: 0)
        )

        #expect(report.status == .needsFix)
        #expect(report.issues.contains { $0.id == .manualMaskUnedited })
        #expect(report.issues.contains { $0.id == .fullMask })
    }

    @Test
    func centeredMaskPassesBlockingValidation() {
        let image = testImage(size: CGSize(width: 200, height: 200))
        let mask = UIGraphicsImageRenderer(size: image.size).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: image.size))
            UIColor.white.setFill()
            context.fill(CGRect(x: 40, y: 40, width: 120, height: 120))
        }
        let report = DefaultImageQualityValidator().validate(
            image: image,
            mask: mask,
            context: QualityValidationContext(maskSource: .vision, candidateCount: 1)
        )

        #expect(!report.hasBlockingIssue)
        #expect(!report.issues.contains { $0.id == .touchesEdge })
    }

    @Test
    func maskTouchingBorderProducesReviewWarning() {
        let image = testImage(size: CGSize(width: 200, height: 200))
        let mask = UIGraphicsImageRenderer(size: image.size).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: image.size))
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 30, width: 120, height: 140))
        }
        let report = DefaultImageQualityValidator().validate(
            image: image,
            mask: mask,
            context: QualityValidationContext(maskSource: .manualEdited, candidateCount: 1)
        )

        #expect(report.issues.contains { $0.id == .touchesEdge && $0.severity == .warning })
    }

    @Test
    func multipleSubjectsProducesInformation() {
        let image = testImage(size: CGSize(width: 200, height: 200))
        let mask = UIGraphicsImageRenderer(size: image.size).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: image.size))
            UIColor.white.setFill()
            context.fill(CGRect(x: 40, y: 40, width: 120, height: 120))
        }
        let report = DefaultImageQualityValidator().validate(
            image: image,
            mask: mask,
            context: QualityValidationContext(maskSource: .vision, candidateCount: 2)
        )

        #expect(report.issues.contains { $0.id == .multipleSubjects && $0.severity == .info })
    }

    @Test
    func enhancementSettingsClampIntensity() {
        #expect(EnhancementSettings(isEnabled: true, intensity: -1).normalized.intensity == 0)
        #expect(EnhancementSettings(isEnabled: true, intensity: 2).normalized.intensity == 1)
    }

    @Test
    func disabledEnhancementDoesNotChangePixels() {
        let image = testImage(size: CGSize(width: 80, height: 80))
        let result = CoreImageEnhancer().enhancedImage(image, settings: .disabled)
        #expect(result?.pngData() == image.pngData())
    }

    @Test
    func cutoutFailuresHaveChineseRecoveryMessages() {
        #expect(CutoutFailure.unsupportedEnvironment.localizedDescription.contains("实体 iPhone"))
        #expect(CutoutFailure.noSubject.localizedDescription.contains("手动"))
        #expect(CutoutFailure.inferenceFailed.localizedDescription.contains("重试"))
    }

    @Test
    @MainActor
    func deletingShelfMovesItemsToUnfiled() throws {
        let container = Persistence.makeContainer(inMemory: true)
        let context = container.mainContext
        let customShelf = Shelf(name: "旅行", sortOrder: 1)
        let item = Collectible(name: "纸袋", shelf: customShelf)
        context.insert(customShelf)
        context.insert(item)
        try context.save()

        ShelfStore.delete(customShelf, from: context)

        #expect(item.shelf?.name == ShelfStore.unfiledName)
        #expect(item.shelf?.isSystem == true)
    }

    private func testImage(size: CGSize) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            let cell: CGFloat = 10
            for row in 0..<Int(size.height / cell) {
                for column in 0..<Int(size.width / cell) {
                    ((row + column).isMultiple(of: 2) ? UIColor.systemBlue : UIColor.systemYellow).setFill()
                    context.fill(CGRect(
                        x: CGFloat(column) * cell,
                        y: CGFloat(row) * cell,
                        width: cell,
                        height: cell
                    ))
                }
            }
        }
    }
}
