import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

struct EnhancementSettings: Equatable, Sendable {
    var isEnabled: Bool
    var intensity: Double

    static let `default` = EnhancementSettings(isEnabled: true, intensity: 0.55)
    static let disabled = EnhancementSettings(isEnabled: false, intensity: 0)

    var normalized: EnhancementSettings {
        EnhancementSettings(
            isEnabled: isEnabled,
            intensity: min(1, max(0, intensity))
        )
    }
}

protocol ImageEnhancing {
    func enhancedImage(_ image: UIImage, settings: EnhancementSettings) -> UIImage?
}

struct CoreImageEnhancer: ImageEnhancing {
    private static let context = CIContext(options: [.cacheIntermediates: true])
    private static let allowedFilterNames: Set<String> = [
        "CIColorControls",
        "CIExposureAdjust",
        "CIGammaAdjust",
        "CIHighlightShadowAdjust",
        "CITemperatureAndTint",
        "CIToneCurve",
        "CIVibrance",
        "CIWhitePointAdjust"
    ]

    func enhancedImage(_ image: UIImage, settings: EnhancementSettings) -> UIImage? {
        let settings = settings.normalized
        guard settings.isEnabled, settings.intensity > 0 else { return image }

        let source = image.normalizedOrientation()
        guard let input = CIImage(image: source) else { return nil }

        let options: [CIImageAutoAdjustmentOption: Any] = [
            .enhance: true,
            .redEye: false,
            .crop: false,
            .level: false
        ]
        let filters = input.autoAdjustmentFilters(options: options)
            .filter { Self.allowedFilterNames.contains($0.name) }

        guard !filters.isEmpty else { return source }

        var adjusted = input
        for filter in filters {
            filter.setValue(adjusted, forKey: kCIInputImageKey)
            if let output = filter.outputImage {
                adjusted = output.cropped(to: input.extent)
            }
        }

        let dissolve = CIFilter.dissolveTransition()
        dissolve.inputImage = input
        dissolve.targetImage = adjusted
        dissolve.time = Float(settings.intensity)
        guard let output = dissolve.outputImage?.cropped(to: input.extent),
              let cgImage = Self.context.createCGImage(output, from: input.extent) else {
            return nil
        }
        return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
    }
}
