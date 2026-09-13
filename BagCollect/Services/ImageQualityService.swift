import CoreGraphics
import UIKit

enum QualitySeverity: Int, Comparable, Sendable {
    case info
    case warning
    case blocking

    static func < (lhs: QualitySeverity, rhs: QualitySeverity) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

enum QualityStatus: Equatable, Sendable {
    case ready
    case needsReview
    case needsFix

    var title: String {
        switch self {
        case .ready: "可直接收藏"
        case .needsReview: "建议调整"
        case .needsFix: "需要修正"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "checkmark.circle.fill"
        case .needsReview: "exclamationmark.triangle.fill"
        case .needsFix: "xmark.octagon.fill"
        }
    }
}

struct QualityIssue: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case invalidImage
        case invalidMask
        case manualMaskUnedited
        case emptyMask
        case fullMask
        case renderFailed
        case subjectTooSmall
        case subjectTooLarge
        case touchesEdge
        case underexposed
        case overexposed
        case blurry
        case multipleSubjects
    }

    let id: Kind
    let severity: QualitySeverity
    let title: String
    let guidance: String
}

struct QualityReport: Equatable, Sendable {
    let issues: [QualityIssue]

    var status: QualityStatus {
        if issues.contains(where: { $0.severity == .blocking }) { return .needsFix }
        if issues.contains(where: { $0.severity == .warning }) { return .needsReview }
        return .ready
    }

    var hasBlockingIssue: Bool {
        issues.contains { $0.severity == .blocking }
    }
}

struct QualityValidationContext: Equatable, Sendable {
    let maskSource: MaskSource
    let candidateCount: Int
}

protocol ImageQualityValidating {
    func validate(image: UIImage, mask: UIImage, context: QualityValidationContext) -> QualityReport
}

struct DefaultImageQualityValidator: ImageQualityValidating {
    func validate(image: UIImage, mask: UIImage, context: QualityValidationContext) -> QualityReport {
        guard let imageCG = image.normalizedOrientation().cgImage else {
            return QualityReport(issues: [blocking(.invalidImage, "图片无法读取", "请返回并重新选择照片。")])
        }
        guard let maskCG = mask.normalizedOrientation().cgImage else {
            return QualityReport(issues: [blocking(.invalidMask, "蒙版无法读取", "请重新识别主体或返回精修。")])
        }

        let imageRatio = Double(imageCG.width) / Double(max(imageCG.height, 1))
        let maskRatio = Double(maskCG.width) / Double(max(maskCG.height, 1))
        guard abs(imageRatio - maskRatio) <= 0.02 else {
            return QualityReport(issues: [blocking(.invalidMask, "蒙版尺寸不匹配", "请重新识别主体。")])
        }

        var issues: [QualityIssue] = []
        if context.maskSource == .manualSeed {
            issues.append(blocking(.manualMaskUnedited, "还没有完成手动抠图", "请返回精修并擦除主体之外的背景。"))
        }

        guard let maskSample = grayscaleSample(from: maskCG) else {
            issues.append(blocking(.invalidMask, "蒙版分析失败", "请重新识别主体。"))
            return QualityReport(issues: issues)
        }

        let foregroundCount = maskSample.pixels.reduce(into: 0) { count, value in
            if value > 127 { count += 1 }
        }
        let total = max(maskSample.pixels.count, 1)
        let foregroundRatio = Double(foregroundCount) / Double(total)

        if foregroundCount == 0 {
            issues.append(blocking(.emptyMask, "没有保留任何主体", "请返回精修并恢复需要保留的区域。"))
        } else if maskSample.pixels.allSatisfy({ $0 > 250 }) {
            issues.append(blocking(.fullMask, "背景尚未移除", "请返回精修，擦除主体之外的背景。"))
        } else {
            if foregroundRatio < 0.05 {
                issues.append(warning(.subjectTooSmall, "主体在画面中偏小", "建议返回重新裁剪，让收藏品更突出。"))
            } else if foregroundRatio > 0.90 {
                issues.append(warning(.subjectTooLarge, "主体几乎占满画面", "请检查边缘是否被裁断。"))
            }

            if borderForegroundRatio(maskSample) > 0.05 {
                issues.append(warning(.touchesEdge, "主体接触画面边缘", "建议检查是否有部分收藏品被裁断。"))
            }
        }

        if let imageSample = grayscaleSample(from: imageCG) {
            let darkRatio = ratio(in: imageSample.pixels) { $0 <= 8 }
            let brightRatio = ratio(in: imageSample.pixels) { $0 >= 247 }
            if darkRatio > 0.25 {
                issues.append(warning(.underexposed, "画面暗部较多", "可以保留自动增强，或重新拍摄一张更明亮的照片。"))
            }
            if brightRatio > 0.25 {
                issues.append(warning(.overexposed, "画面高光较多", "建议降低增强强度，并检查浅色区域细节。"))
            }
            if laplacianVariance(imageSample) < 0.0025 {
                issues.append(warning(.blurry, "照片可能不够清晰", "建议放大检查边缘，必要时重新选择照片。"))
            }
        }

        if context.candidateCount > 1 {
            issues.append(QualityIssue(
                id: .multipleSubjects,
                severity: .info,
                title: "检测到多个主体",
                guidance: "请确认当前选择包含你想收藏的物品。"
            ))
        }

        if foregroundCount > 0, ImageCompositor.apply(mask: mask, to: image) == nil {
            issues.append(blocking(.renderFailed, "透明成品生成失败", "请重新识别主体后再试。"))
        }

        issues.sort { lhs, rhs in
            if lhs.severity == rhs.severity { return lhs.id.rawValue < rhs.id.rawValue }
            return lhs.severity > rhs.severity
        }
        return QualityReport(issues: issues)
    }

    private func blocking(_ id: QualityIssue.Kind, _ title: String, _ guidance: String) -> QualityIssue {
        QualityIssue(id: id, severity: .blocking, title: title, guidance: guidance)
    }

    private func warning(_ id: QualityIssue.Kind, _ title: String, _ guidance: String) -> QualityIssue {
        QualityIssue(id: id, severity: .warning, title: title, guidance: guidance)
    }

    private func ratio(in pixels: [UInt8], matching predicate: (UInt8) -> Bool) -> Double {
        guard !pixels.isEmpty else { return 0 }
        return Double(pixels.count(where: predicate)) / Double(pixels.count)
    }

    private func borderForegroundRatio(_ sample: GraySample) -> Double {
        guard sample.width > 1, sample.height > 1 else { return 1 }
        var foreground = 0
        var count = 0
        for x in 0..<sample.width {
            count += 2
            if sample.pixels[x] > 127 { foreground += 1 }
            if sample.pixels[(sample.height - 1) * sample.width + x] > 127 { foreground += 1 }
        }
        for y in 1..<(sample.height - 1) {
            count += 2
            if sample.pixels[y * sample.width] > 127 { foreground += 1 }
            if sample.pixels[y * sample.width + sample.width - 1] > 127 { foreground += 1 }
        }
        return Double(foreground) / Double(max(count, 1))
    }

    private func laplacianVariance(_ sample: GraySample) -> Double {
        guard sample.width > 2, sample.height > 2 else { return 0 }
        var values: [Double] = []
        values.reserveCapacity((sample.width - 2) * (sample.height - 2))
        for y in 1..<(sample.height - 1) {
            for x in 1..<(sample.width - 1) {
                let center = Double(sample.pixels[y * sample.width + x])
                let left = Double(sample.pixels[y * sample.width + x - 1])
                let right = Double(sample.pixels[y * sample.width + x + 1])
                let up = Double(sample.pixels[(y - 1) * sample.width + x])
                let down = Double(sample.pixels[(y + 1) * sample.width + x])
                values.append((4 * center - left - right - up - down) / 255)
            }
        }
        let mean = values.reduce(0, +) / Double(max(values.count, 1))
        return values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(max(values.count, 1))
    }

    private func grayscaleSample(from image: CGImage, longestEdge: Int = 256) -> GraySample? {
        let scale = min(1, Double(longestEdge) / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return GraySample(pixels: pixels, width: width, height: height)
    }
}

private struct GraySample {
    let pixels: [UInt8]
    let width: Int
    let height: Int
}
