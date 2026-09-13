import CoreImage
import UIKit

extension UIImage {
    var pixelSize: CGSize {
        CGSize(width: cgImage?.width ?? Int(size.width), height: cgImage?.height ?? Int(size.height))
    }

    func normalizedOrientation() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }

    func rotatedClockwise() -> UIImage {
        let source = normalizedOrientation()
        let outputSize = CGSize(width: source.size.height, height: source.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
        return renderer.image { context in
            context.cgContext.translateBy(x: outputSize.width / 2, y: outputSize.height / 2)
            context.cgContext.rotate(by: .pi / 2)
            source.draw(
                in: CGRect(
                    x: -source.size.width / 2,
                    y: -source.size.height / 2,
                    width: source.size.width,
                    height: source.size.height
                )
            )
        }
    }

    func resized(longestEdge: CGFloat) -> UIImage {
        let source = normalizedOrientation()
        let longest = max(source.size.width, source.size.height)
        guard longest > longestEdge else { return source }
        let scale = longestEdge / longest
        let outputSize = CGSize(
            width: max(1, floor(source.size.width * scale)),
            height: max(1, floor(source.size.height * scale))
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
        return renderer.image { _ in
            source.draw(in: CGRect(origin: .zero, size: outputSize))
        }
    }

    func cropped(to rect: CGRect) -> UIImage? {
        let source = normalizedOrientation()
        guard let cgImage = source.cgImage else { return nil }
        let scaleX = CGFloat(cgImage.width) / source.size.width
        let scaleY = CGFloat(cgImage.height) / source.size.height
        let pixelRect = CGRect(
            x: rect.origin.x * scaleX,
            y: rect.origin.y * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY
        ).integral.intersection(CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        guard pixelRect.width > 1, pixelRect.height > 1,
              let cropped = cgImage.cropping(to: pixelRect) else { return nil }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    static func solidMask(size: CGSize, white: Bool) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            (white ? UIColor.white : UIColor.black).setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }
}

enum ImageCompositor {
    private static let context = CIContext(options: [.cacheIntermediates: true])

    static func apply(mask: UIImage, to image: UIImage) -> UIImage? {
        let source = image.normalizedOrientation()
        guard let input = CIImage(image: source),
              var maskImage = CIImage(image: mask.normalizedOrientation()) else { return nil }

        let scaleX = input.extent.width / max(maskImage.extent.width, 1)
        let scaleY = input.extent.height / max(maskImage.extent.height, 1)
        maskImage = maskImage.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))

        let transparent = CIImage(color: .clear).cropped(to: input.extent)
        guard let filter = CIFilter(name: "CIBlendWithMask") else { return nil }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(transparent, forKey: kCIInputBackgroundImageKey)
        filter.setValue(maskImage, forKey: kCIInputMaskImageKey)
        guard let output = filter.outputImage,
              let cgImage = context.createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
    }
}

struct AspectFitMapper {
    let imageSize: CGSize
    let containerSize: CGSize

    var fittedRect: CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let scale = min(containerSize.width / imageSize.width, containerSize.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(
            x: (containerSize.width - size.width) / 2,
            y: (containerSize.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }
}
