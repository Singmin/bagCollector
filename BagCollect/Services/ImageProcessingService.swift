import CoreImage
import Foundation
import OSLog
import UIKit
import Vision

struct ForegroundCandidate: Identifiable {
    let id: Int
    let mask: UIImage
    let preview: UIImage
}

enum MaskSource: String, Equatable, Sendable {
    case vision
    case manualSeed
    case manualEdited
}

struct CutoutExtractionResult {
    let candidates: [ForegroundCandidate]
    let maskSource: MaskSource
}

protocol SubjectCutoutEngine {
    func extractSubjects(from image: UIImage) async throws -> CutoutExtractionResult
}

enum CutoutFailure: LocalizedError, Equatable {
    case unsupportedEnvironment
    case invalidImage
    case noSubject
    case inferenceFailed
    case maskGenerationFailed

    var errorDescription: String? {
        switch self {
        case .unsupportedEnvironment:
            "自动抠图需要在 iOS 17 或更高版本的实体 iPhone 上运行。"
        case .invalidImage:
            "无法读取这张图片，请换一张重试。"
        case .noSubject:
            "没有识别到清晰主体。你可以重新裁剪，或改用手动擦除背景。"
        case .inferenceFailed:
            "自动抠图暂时失败。请重试，或改用手动擦除背景。"
        case .maskGenerationFailed:
            "主体已经识别，但无法生成有效蒙版。请重试或手动处理。"
        }
    }
}

struct AppleVisionCutoutEngine: SubjectCutoutEngine {
    static var supportsAutomaticCutout: Bool {
#if targetEnvironment(simulator)
        false
#else
        true
#endif
    }

    func extractSubjects(from image: UIImage) async throws -> CutoutExtractionResult {
        guard Self.supportsAutomaticCutout else {
            throw CutoutFailure.unsupportedEnvironment
        }
        let candidates = try await ImageProcessingService.appleForegroundCandidates(for: image)
        return CutoutExtractionResult(candidates: candidates, maskSource: .vision)
    }
}

enum ImageProcessingError: LocalizedError {
    case invalidImage
    case noForeground
    case renderFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage: "无法读取这张图片，请换一张重试。"
        case .noForeground: "没有识别到清晰主体，你仍可手动擦除背景。"
        case .renderFailed: "图片处理失败，请稍后重试。"
        }
    }
}

enum ImageProcessingService {
    private static let logger = Logger(subsystem: "BagCollect", category: "ImageProcessing")

    static func foregroundCandidates(for image: UIImage) async throws -> [ForegroundCandidate] {
        try await AppleVisionCutoutEngine().extractSubjects(from: image).candidates
    }

    fileprivate static func appleForegroundCandidates(for image: UIImage) async throws -> [ForegroundCandidate] {
        let source = image.normalizedOrientation().resized(longestEdge: 2048)
        guard let cgImage = source.cgImage else { throw CutoutFailure.invalidImage }

        return try await Task.detached(priority: .userInitiated) {
            let request = VNGenerateForegroundInstanceMaskRequest()
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
            do {
                try handler.perform([request])
            } catch {
                logger.error("Vision foreground inference failed: \(String(describing: error), privacy: .public)")
                throw CutoutFailure.inferenceFailed
            }

            guard let observation = request.results?.first,
                  !observation.allInstances.isEmpty else {
                throw CutoutFailure.noSubject
            }

            var candidates: [ForegroundCandidate] = []
            for index in observation.allInstances {
                let selection = IndexSet(integer: index)
                guard let pixelBuffer = try? observation.generateScaledMaskForImage(
                    forInstances: selection, from: handler
                ) else { continue }
                guard let mask = imageFromMaskBuffer(pixelBuffer),
                      let preview = ImageCompositor.apply(mask: mask, to: source) else { continue }
                candidates.append(ForegroundCandidate(id: index, mask: mask, preview: preview))
            }

            candidates.sort { candidateScore(for: $0.mask) > candidateScore(for: $1.mask) }

            if observation.allInstances.count > 1 {
                if let pixelBuffer = try? observation.generateScaledMaskForImage(
                    forInstances: observation.allInstances,
                    from: handler
                ), let mask = imageFromMaskBuffer(pixelBuffer),
                   let preview = ImageCompositor.apply(mask: mask, to: source) {
                    candidates.append(ForegroundCandidate(id: -1, mask: mask, preview: preview))
                }
            }

            guard !candidates.isEmpty else { throw CutoutFailure.maskGenerationFailed }
            return candidates
        }.value
    }

    static func export(
        original image: UIImage,
        mask: UIImage,
        enhancement: EnhancementSettings = .disabled
    ) throws -> (original: Data, cutout: Data, mask: Data, thumbnail: Data) {
        let working = image.normalizedOrientation().resized(longestEdge: 4096)
        let outputSource = working.resized(longestEdge: 2048)
        let renderedSource = CoreImageEnhancer().enhancedImage(outputSource, settings: enhancement) ?? outputSource
        guard let cutout = ImageCompositor.apply(mask: mask, to: renderedSource),
              let originalData = working.jpegData(compressionQuality: 0.9),
              let cutoutData = cutout.pngData(),
              let maskData = mask.resized(longestEdge: 2048).pngData(),
              let thumbnailData = cutout.resized(longestEdge: 512).pngData() else {
            throw ImageProcessingError.renderFailed
        }
        return (originalData, cutoutData, maskData, thumbnailData)
    }

    private static func imageFromMaskBuffer(_ pixelBuffer: CVPixelBuffer) -> UIImage? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext(options: [.cacheIntermediates: false])
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return nil }
        return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
    }

    /// Prefers a large foreground region whose visual center is near the photograph center.
    private static func candidateScore(for mask: UIImage) -> Double {
        guard let cgImage = mask.cgImage else { return 0 }
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return 0 }

        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        let stride = max(1, max(width, height) / 256)
        var count = 0
        var sumX = 0
        var sumY = 0
        var sampleCount = 0
        for y in Swift.stride(from: 0, to: height, by: stride) {
            for x in Swift.stride(from: 0, to: width, by: stride) {
                sampleCount += 1
                if pixels[y * width + x] > 127 {
                    count += 1
                    sumX += x
                    sumY += y
                }
            }
        }
        guard count > 0 else { return 0 }
        let area = Double(count) / Double(max(sampleCount, 1))
        let centerX = Double(sumX) / Double(count) / Double(width)
        let centerY = Double(sumY) / Double(count) / Double(height)
        let distance = hypot(centerX - 0.5, centerY - 0.5)
        return area * 4 - distance
    }
}

enum MaskPainter {
    static func paint(
        points: [CGPoint],
        normalizedRadius: CGFloat,
        adding: Bool,
        on mask: UIImage
    ) -> UIImage {
        guard !points.isEmpty else { return mask }
        let source = mask.normalizedOrientation()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: source.size, format: format)
        return renderer.image { context in
            source.draw(in: CGRect(origin: .zero, size: source.size))
            let cg = context.cgContext
            cg.setBlendMode(.copy)
            cg.setStrokeColor((adding ? UIColor.white : UIColor.black).cgColor)
            cg.setFillColor((adding ? UIColor.white : UIColor.black).cgColor)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            cg.setLineWidth(max(2, normalizedRadius * 2 * min(source.size.width, source.size.height)))

            let mapped = points.map {
                CGPoint(x: $0.x * source.size.width, y: $0.y * source.size.height)
            }
            if mapped.count == 1, let point = mapped.first {
                let radius = max(1, normalizedRadius * min(source.size.width, source.size.height))
                cg.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            } else {
                cg.beginPath()
                cg.move(to: mapped[0])
                mapped.dropFirst().forEach { cg.addLine(to: $0) }
                cg.strokePath()
            }
        }
    }
}
