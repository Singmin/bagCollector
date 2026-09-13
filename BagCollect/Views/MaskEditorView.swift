import SwiftUI
import UIKit

private enum MaskTool: String, CaseIterable, Identifiable {
    case navigate = "移动"
    case add = "保留"
    case erase = "擦除"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .navigate: "hand.draw"
        case .add: "plus.circle"
        case .erase: "minus.circle"
        }
    }
}

struct MaskEditorView: View {
    let image: UIImage
    let candidates: [ForegroundCandidate]
    let notice: String?
    let cancel: () -> Void
    let back: () -> Void
    let completion: (UIImage, MaskSource) -> Void

    @State private var history: [UIImage]
    @State private var redoStack: [UIImage] = []
    @State private var selectedCandidateID: Int?
    @State private var maskSource: MaskSource
    @State private var initialSource: MaskSource
    @State private var tool: MaskTool = .erase
    @State private var brushRadius: CGFloat = 0.035
    @State private var showOriginal = false

    init(
        image: UIImage,
        candidates: [ForegroundCandidate],
        initialMask: UIImage,
        initialSource: MaskSource,
        notice: String?,
        cancel: @escaping () -> Void,
        back: @escaping () -> Void,
        completion: @escaping (UIImage, MaskSource) -> Void
    ) {
        self.image = image
        self.candidates = candidates
        self.notice = notice
        self.cancel = cancel
        self.back = back
        self.completion = completion
        _history = State(initialValue: [initialMask])
        _selectedCandidateID = State(initialValue: candidates.first?.id)
        _maskSource = State(initialValue: initialSource)
        _initialSource = State(initialValue: initialSource)
    }

    private var currentMask: UIImage { history.last! }

    var body: some View {
        VStack(spacing: 12) {
            if let notice {
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }

            if candidates.count > 1 {
                candidatePicker
            }

            InteractiveMaskCanvas(
                image: image,
                mask: currentMask,
                tool: tool,
                brushRadius: brushRadius,
                showOriginal: showOriginal,
                strokeFinished: applyStroke
            )
            .frame(maxHeight: .infinity)
            .padding(.horizontal)

            editingControls
                .padding(.horizontal)
                .padding(.bottom, 8)
        }
        .navigationTitle("精修抠图")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark", action: cancel)
            }
            ToolbarItem(placement: .topBarLeading) {
                Button("返回", systemImage: "chevron.left", action: back)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(showOriginal ? "查看抠图" : "查看原图", systemImage: showOriginal ? "person.crop.rectangle" : "photo") {
                    showOriginal.toggle()
                }
                Button("下一步", systemImage: "arrow.right") {
                    completion(currentMask, maskSource)
                }
                .buttonStyle(.borderedProminent)
                .disabled(maskSource == .manualSeed)
            }
        }
    }

    private var candidatePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(candidates) { candidate in
                    Button {
                        selectedCandidateID = candidate.id
                        history = [candidate.mask]
                        redoStack.removeAll()
                        maskSource = .vision
                        initialSource = .vision
                    } label: {
                        Image(uiImage: candidate.preview)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 58, height: 58)
                            .padding(5)
                            .background(
                                selectedCandidateID == candidate.id
                                    ? Color.accentColor.opacity(0.16)
                                    : AppTheme.secondaryBackground,
                                in: RoundedRectangle(cornerRadius: 12)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(selectedCandidateID == candidate.id ? Color.accentColor : .clear, lineWidth: 2)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(candidate.id == -1 ? "全部识别主体" : "识别主体 \(candidate.id)")
                }
            }
            .padding(.horizontal)
        }
    }

    private var editingControls: some View {
        VStack(spacing: 12) {
            Picker("编辑工具", selection: $tool) {
                ForEach(MaskTool.allCases) { tool in
                    Label(tool.rawValue, systemImage: tool.symbol).tag(tool)
                }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 18) {
                Button("撤销", systemImage: "arrow.uturn.backward") { undo() }
                    .disabled(history.count <= 1)
                Button("重做", systemImage: "arrow.uturn.forward") { redo() }
                    .disabled(redoStack.isEmpty)

                if tool != .navigate {
                    Slider(value: $brushRadius, in: 0.008...0.10) {
                        Text("笔刷大小")
                    } minimumValueLabel: {
                        Image(systemName: "circle.fill").font(.system(size: 5))
                    } maximumValueLabel: {
                        Image(systemName: "circle.fill").font(.system(size: 14))
                    }
                    .accessibilityValue("\(Int(brushRadius * 1000))")
                }
            }
            .buttonStyle(.bordered)
        }
    }

    private func applyStroke(_ points: [CGPoint]) {
        guard tool == .add || tool == .erase else { return }
        let updated = MaskPainter.paint(
            points: points,
            normalizedRadius: brushRadius,
            adding: tool == .add,
            on: currentMask
        )
        history.append(updated)
        maskSource = .manualEdited
        if history.count > 30 { history.removeFirst() }
        redoStack.removeAll()
    }

    private func undo() {
        guard history.count > 1, let removed = history.popLast() else { return }
        redoStack.append(removed)
        if history.count == 1 { maskSource = initialSource }
    }

    private func redo() {
        guard let restored = redoStack.popLast() else { return }
        history.append(restored)
        maskSource = .manualEdited
    }
}

private struct InteractiveMaskCanvas: View {
    let image: UIImage
    let mask: UIImage
    let tool: MaskTool
    let brushRadius: CGFloat
    let showOriginal: Bool
    let strokeFinished: ([CGPoint]) -> Void

    @State private var zoom: CGFloat = 1
    @State private var lastZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var lastPan: CGSize = .zero
    @State private var currentStroke: [CGPoint] = []

    var body: some View {
        GeometryReader { proxy in
            let mapper = AspectFitMapper(imageSize: image.size, containerSize: proxy.size)
            let rect = mapper.fittedRect

            ZStack {
                CheckerboardBackground()
                Image(uiImage: displayedImage)
                    .resizable()
                    .scaledToFit()

                if tool != .navigate, currentStroke.count > 1 {
                    Canvas { context, size in
                        var path = Path()
                        path.move(to: CGPoint(x: currentStroke[0].x * size.width, y: currentStroke[0].y * size.height))
                        for point in currentStroke.dropFirst() {
                            path.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                        }
                        context.stroke(
                            path,
                            with: .color(tool == .add ? .green.opacity(0.8) : .red.opacity(0.8)),
                            style: StrokeStyle(lineWidth: brushRadius * 2 * min(size.width, size.height), lineCap: .round, lineJoin: .round)
                        )
                    }
                }
            }
            .frame(width: rect.width, height: rect.height)
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(Color(uiColor: .separator), lineWidth: 1)
            }
            .scaleEffect(zoom)
            .offset(pan)
            .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
            .contentShape(Rectangle())
            .gesture(dragGesture(container: proxy.size, baseRect: rect))
            .simultaneousGesture(magnificationGesture)
        }
        .accessibilityLabel("抠图精修画布")
        .accessibilityHint(tool == .navigate ? "拖动移动，双指缩放" : "在图片上涂抹以修改选区")
    }

    private var displayedImage: UIImage {
        showOriginal ? image : (ImageCompositor.apply(mask: mask, to: image) ?? image)
    }

    private func dragGesture(container: CGSize, baseRect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if tool == .navigate {
                    pan = CGSize(
                        width: lastPan.width + value.translation.width,
                        height: lastPan.height + value.translation.height
                    )
                } else if let point = normalizedPoint(value.location, container: container, baseRect: baseRect) {
                    currentStroke.append(point)
                }
            }
            .onEnded { _ in
                if tool == .navigate {
                    lastPan = pan
                } else {
                    let points = currentStroke
                    currentStroke.removeAll()
                    if !points.isEmpty { strokeFinished(points) }
                }
            }
    }

    private var magnificationGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in zoom = min(8, max(1, lastZoom * value)) }
            .onEnded { _ in lastZoom = zoom }
    }

    private func normalizedPoint(_ location: CGPoint, container: CGSize, baseRect: CGRect) -> CGPoint? {
        let scaledSize = CGSize(width: baseRect.width * zoom, height: baseRect.height * zoom)
        let origin = CGPoint(
            x: container.width / 2 + pan.width - scaledSize.width / 2,
            y: container.height / 2 + pan.height - scaledSize.height / 2
        )
        let point = CGPoint(
            x: (location.x - origin.x) / scaledSize.width,
            y: (location.y - origin.y) / scaledSize.height
        )
        guard (0...1).contains(point.x), (0...1).contains(point.y) else { return nil }
        return point
    }
}

struct CheckerboardBackground: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 14
            let columns = Int(ceil(size.width / cell))
            let rows = Int(ceil(size.height / cell))
            for row in 0..<rows {
                for column in 0..<columns where (row + column).isMultiple(of: 2) {
                    let rect = CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell, height: cell)
                    context.fill(Path(rect), with: .color(Color(uiColor: .tertiarySystemFill)))
                }
            }
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }
}
