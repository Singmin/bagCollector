import SwiftUI
import UIKit

private enum CropAspect: String, CaseIterable, Identifiable {
    case original = "原比例"
    case square = "方形"
    case portrait = "竖版"
    case landscape = "横版"

    var id: String { rawValue }

    func ratio(for image: UIImage) -> CGFloat {
        switch self {
        case .original: image.size.width / max(image.size.height, 1)
        case .square: 1
        case .portrait: 4 / 5
        case .landscape: 5 / 4
        }
    }
}

struct CropEditorView: View {
    let cancel: () -> Void
    let back: () -> Void
    let completion: (UIImage) -> Void

    @State private var image: UIImage
    @State private var aspect: CropAspect = .original
    @State private var zoom: CGFloat = 1
    @State private var lastZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var viewportSize: CGSize = .zero

    init(image: UIImage, cancel: @escaping () -> Void, back: @escaping () -> Void, completion: @escaping (UIImage) -> Void) {
        self.cancel = cancel
        self.back = back
        self.completion = completion
        _image = State(initialValue: image.normalizedOrientation())
    }

    var body: some View {
        VStack(spacing: 18) {
            GeometryReader { proxy in
                let availableWidth = max(1, proxy.size.width - 32)
                let ratio = aspect.ratio(for: image)
                let height = min(proxy.size.height, availableWidth / max(ratio, 0.2))
                let size = CGSize(width: min(availableWidth, height * ratio), height: height)
                cropCanvas(size: size)
                    .frame(width: size.width, height: size.height)
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
                    .onAppear { viewportSize = size }
                    .onChange(of: size) { _, newValue in viewportSize = newValue }
            }

            Picker("裁剪比例", selection: $aspect) {
                ForEach(CropAspect.allCases) { option in
                    Text(option.rawValue).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: aspect) { _, _ in resetTransform() }

            HStack {
                Button("旋转", systemImage: "rotate.right") {
                    image = image.rotatedClockwise()
                    resetTransform()
                }
                Spacer()
                Button("复原", systemImage: "arrow.counterclockwise") {
                    resetTransform()
                }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .navigationTitle("裁剪照片")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark", action: cancel)
            }
            ToolbarItem(placement: .topBarLeading) {
                Button("返回", systemImage: "chevron.left", action: back)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("下一步", systemImage: "arrow.right") {
                    if let cropped = renderCrop() { completion(cropped) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewportSize == .zero)
            }
        }
    }

    private func cropCanvas(size: CGSize) -> some View {
        let scale = coverScale(for: size)
        let renderedSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return ZStack {
            Color(uiColor: .secondarySystemBackground)
            Image(uiImage: image)
                .resizable()
                .frame(width: renderedSize.width, height: renderedSize.height)
                .scaleEffect(zoom)
                .offset(offset)
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.primary.opacity(0.28), lineWidth: 1)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture(in: size))
        .simultaneousGesture(magnificationGesture(in: size))
        .accessibilityLabel("照片裁剪区域")
        .accessibilityHint("单指移动，双指缩放")
    }

    private func dragGesture(in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                offset = clamp(
                    CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height),
                    in: size
                )
            }
            .onEnded { _ in lastOffset = offset }
    }

    private func magnificationGesture(in size: CGSize) -> some Gesture {
        MagnificationGesture()
            .onChanged { value in
                zoom = min(8, max(1, lastZoom * value))
                offset = clamp(offset, in: size)
            }
            .onEnded { _ in
                lastZoom = zoom
                offset = clamp(offset, in: size)
                lastOffset = offset
            }
    }

    private func coverScale(for size: CGSize) -> CGFloat {
        max(size.width / max(image.size.width, 1), size.height / max(image.size.height, 1))
    }

    private func clamp(_ proposed: CGSize, in size: CGSize) -> CGSize {
        let scale = coverScale(for: size) * zoom
        let maxX = max(0, (image.size.width * scale - size.width) / 2)
        let maxY = max(0, (image.size.height * scale - size.height) / 2)
        return CGSize(
            width: min(max(proposed.width, -maxX), maxX),
            height: min(max(proposed.height, -maxY), maxY)
        )
    }

    private func renderCrop() -> UIImage? {
        let totalScale = coverScale(for: viewportSize) * zoom
        let renderedWidth = image.size.width * totalScale
        let renderedHeight = image.size.height * totalScale
        let rect = CGRect(
            x: ((renderedWidth - viewportSize.width) / 2 - offset.width) / totalScale,
            y: ((renderedHeight - viewportSize.height) / 2 - offset.height) / totalScale,
            width: viewportSize.width / totalScale,
            height: viewportSize.height / totalScale
        )
        return image.cropped(to: rect)?.resized(longestEdge: 4096)
    }

    private func resetTransform() {
        zoom = 1
        lastZoom = 1
        offset = .zero
        lastOffset = .zero
    }
}
