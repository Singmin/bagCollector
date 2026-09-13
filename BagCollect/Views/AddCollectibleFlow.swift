import PhotosUI
import SwiftData
import SwiftUI
import UIKit

private enum AddFlowStep {
    case source
    case crop
    case processing
    case recovery
    case mask
    case optimization
    case details
}

struct AddCollectibleFlow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let existingItem: Collectible?
    private let cutoutEngine: any SubjectCutoutEngine

    @State private var step: AddFlowStep
    @State private var sourceImage: UIImage?
    @State private var workingImage: UIImage?
    @State private var candidates: [ForegroundCandidate] = []
    @State private var selectedMask: UIImage?
    @State private var maskSource: MaskSource = .vision
    @State private var processingNotice: String?
    @State private var cutoutFailure: CutoutFailure?
    @State private var segmentationTask: Task<Void, Never>?
    @State private var confirmDismiss = false
    @State private var enhancementSettings: EnhancementSettings

    @State private var name: String
    @State private var notes: String
    @State private var tagsText: String
    @State private var selectedShelfID: UUID?
    @State private var didReprocess = false

    init(
        existingItem: Collectible? = nil,
        cutoutEngine: any SubjectCutoutEngine = AppleVisionCutoutEngine()
    ) {
        self.existingItem = existingItem
        self.cutoutEngine = cutoutEngine
        let original = existingItem?.originalImageData.flatMap(UIImage.init(data:))
        _step = State(initialValue: existingItem == nil ? .source : .details)
        _sourceImage = State(initialValue: original)
        _workingImage = State(initialValue: original)
        _selectedMask = State(initialValue: existingItem?.maskImageData.flatMap(UIImage.init(data:)))
        _name = State(initialValue: existingItem?.name ?? "")
        _notes = State(initialValue: existingItem?.notes ?? "")
        _tagsText = State(initialValue: existingItem?.tags.joined(separator: "，") ?? "")
        _selectedShelfID = State(initialValue: existingItem?.shelf?.id)
        _enhancementSettings = State(initialValue: existingItem.map {
            EnhancementSettings(isEnabled: $0.enhancementEnabled, intensity: $0.enhancementIntensity)
        } ?? .default)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .source:
                    SourceImportView(
                        cancel: requestDismiss,
                        selected: receiveSourceImage
                    )
                case .crop:
                    if let image = sourceImage {
                        CropEditorView(
                            image: image,
                            cancel: requestDismiss,
                            back: existingItem == nil ? { step = .source } : { step = .details },
                            completion: beginSegmentation
                        )
                    }
                case .processing:
                    processingView
                case .recovery:
                    if let failure = cutoutFailure {
                        CutoutRecoveryView(
                            failure: failure,
                            canRetry: AppleVisionCutoutEngine.supportsAutomaticCutout,
                            cancel: requestDismiss,
                            back: { step = .crop },
                            retry: retrySegmentation,
                            manual: beginManualMask,
                            chooseAnother: chooseAnotherPhoto
                        )
                    }
                case .mask:
                    if let image = workingImage, let mask = selectedMask {
                        MaskEditorView(
                            image: image,
                            candidates: candidates,
                            initialMask: mask,
                            initialSource: maskSource,
                            notice: processingNotice,
                            cancel: requestDismiss,
                            back: { step = .crop },
                            completion: { finalMask, finalSource in
                                selectedMask = finalMask
                                maskSource = finalSource
                                didReprocess = true
                                step = .optimization
                            }
                        )
                    }
                case .optimization:
                    if let image = workingImage, let mask = selectedMask {
                        FinishedOptimizationView(
                            image: image,
                            mask: mask,
                            maskSource: maskSource,
                            candidateCount: candidates.count,
                            settings: $enhancementSettings,
                            cancel: requestDismiss,
                            back: { step = .mask },
                            retry: { beginSegmentation(image) },
                            completion: { step = .details }
                        )
                    }
                case .details:
                    DetailsEditorView(
                        existingItem: existingItem,
                        workingImage: workingImage,
                        maskImage: selectedMask,
                        didReprocess: didReprocess,
                        enhancementSettings: enhancementSettings,
                        name: $name,
                        notes: $notes,
                        tagsText: $tagsText,
                        selectedShelfID: $selectedShelfID,
                        cancel: requestDismiss,
                        reprocess: {
                            if sourceImage != nil { step = .crop }
                        },
                        saved: { dismiss() }
                    )
                }
            }
        }
        .tint(AppTheme.ink)
        .preferredColorScheme(.light)
        .interactiveDismissDisabled(step != .source || existingItem != nil)
        .confirmationDialog("放弃本次编辑？", isPresented: $confirmDismiss) {
            Button("放弃更改", role: .destructive) { dismiss() }
        } message: {
            Text("尚未保存的图片处理和信息会丢失。")
        }
        .onDisappear {
            segmentationTask?.cancel()
        }
    }

    private var processingView: some View {
        VStack(spacing: 20) {
            ProgressView()
                .controlSize(.large)
            Text("正在寻找画面主体")
                .font(.editorialSection)
            Text("处理只在你的设备上进行")
                .font(.subheadline)
                .foregroundStyle(AppTheme.mutedInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .editorialScreenBackground()
        .navigationTitle("识别主体")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消", systemImage: "xmark", action: requestDismiss)
            }
        }
    }

    private func requestDismiss() {
        if step == .source && existingItem == nil {
            segmentationTask?.cancel()
            dismiss()
        } else {
            confirmDismiss = true
        }
    }

    private func receiveSourceImage(_ image: UIImage) {
        let normalized = image.normalizedOrientation().resized(longestEdge: 4096)
        sourceImage = normalized
        workingImage = normalized
        step = .crop
    }

    private func beginSegmentation(_ image: UIImage) {
        segmentationTask?.cancel()
        workingImage = image
        candidates = []
        processingNotice = nil
        cutoutFailure = nil
        step = .processing

        segmentationTask = Task {
            do {
                let result = try await cutoutEngine.extractSubjects(from: image)
                guard !Task.isCancelled else { return }
                candidates = result.candidates
                selectedMask = result.candidates.first?.mask
                maskSource = result.maskSource
                step = .mask
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                cutoutFailure = (error as? CutoutFailure) ?? .inferenceFailed
                selectedMask = nil
                step = .recovery
            }
        }
    }

    private func retrySegmentation() {
        guard let image = workingImage else { return }
        beginSegmentation(image)
    }

    private func beginManualMask() {
        guard let image = workingImage else { return }
        candidates = []
        selectedMask = UIImage.solidMask(size: image.size, white: true)
        maskSource = .manualSeed
        processingNotice = "自动抠图未完成。请使用“擦除”移除主体之外的背景。"
        step = .mask
    }

    private func chooseAnotherPhoto() {
        segmentationTask?.cancel()
        sourceImage = nil
        workingImage = nil
        selectedMask = nil
        candidates = []
        cutoutFailure = nil
        processingNotice = nil
        maskSource = .vision
        step = .source
    }
}

private struct CutoutRecoveryView: View {
    let failure: CutoutFailure
    let canRetry: Bool
    let cancel: () -> Void
    let back: () -> Void
    let retry: () -> Void
    let manual: () -> Void
    let chooseAnother: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "wand.and.stars.inverse")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 82, height: 82)
                    .background(AppTheme.paperDeep, in: Circle())

                Text(failure == .unsupportedEnvironment ? "当前环境不能自动抠图" : "自动抠图没有完成")
                    .font(.editorialSection)
                    .multilineTextAlignment(.center)

                Text(failure.localizedDescription)
                    .font(.body)
                    .foregroundStyle(AppTheme.mutedInk)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)

                VStack(spacing: 12) {
                    if canRetry {
                        Button("重新识别", systemImage: "arrow.clockwise", action: retry)
                            .buttonStyle(EditorialPrimaryButtonStyle())
                    }
                    Button("手动擦除背景", systemImage: "eraser", action: manual)
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    Button("换一张照片", systemImage: "photo.on.rectangle", action: chooseAnother)
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, AppTheme.pagePadding)
            .padding(.top, 76)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .editorialScreenBackground()
        .navigationTitle("自动抠图")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark", action: cancel)
            }
            ToolbarItem(placement: .topBarLeading) {
                Button("返回", systemImage: "chevron.left", action: back)
            }
        }
    }
}

private struct SourceImportView: View {
    let cancel: () -> Void
    let selected: (UIImage) -> Void

    @State private var selection: PhotosPickerItem?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EditorialEyebrow("NEW OBJECT · 1 / 5")
                Text("把新收藏\n放进来")
                    .font(.editorialTitle)
                    .padding(.top, 7)
                Text("选择照片后，我们会在本机完成裁剪和主体识别。原图不会上传。")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.mutedInk)
                    .lineSpacing(3)
                    .padding(.top, 11)

                PhotosPicker(selection: $selection, matching: .images) {
                    VStack(spacing: 10) {
                        Image(systemName: isLoading ? "hourglass" : "plus")
                            .font(.system(size: 27, weight: .light))
                            .foregroundStyle(.white)
                            .frame(width: 52, height: 52)
                            .background(AppTheme.ink, in: Circle())
                        Text(isLoading ? "正在读取照片" : "从相册选择照片")
                            .font(.system(.body, design: .serif, weight: .semibold))
                        Text("纸袋、书、票根、唱片等都可以")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.mutedInk)
                    }
                    .frame(maxWidth: .infinity, minHeight: 334)
                    .background(AppTheme.paperDeep.opacity(0.72), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(AppTheme.mutedInk.opacity(0.52), style: StrokeStyle(lineWidth: 1, dash: [7, 6]))
                    }
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .padding(.top, 23)

                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14)
                }
            }
            .padding(.horizontal, AppTheme.pagePadding)
            .padding(.top, 22)
            .padding(.bottom, 28)
        }
        .editorialScreenBackground()
        .navigationTitle("添加收藏")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark", action: cancel)
            }
        }
        .onChange(of: selection) { _, newValue in
            guard let newValue else { return }
            load(newValue)
        }
    }

    private func load(_ item: PhotosPickerItem) {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    throw ImageProcessingError.invalidImage
                }
                selected(image)
            } catch {
                errorMessage = "无法读取照片。若照片存储在 iCloud，请联网后重试。"
            }
            isLoading = false
        }
    }
}

private struct DetailsEditorView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Shelf.sortOrder) private var shelves: [Shelf]

    let existingItem: Collectible?
    let workingImage: UIImage?
    let maskImage: UIImage?
    let didReprocess: Bool
    let enhancementSettings: EnhancementSettings
    @Binding var name: String
    @Binding var notes: String
    @Binding var tagsText: String
    @Binding var selectedShelfID: UUID?
    let cancel: () -> Void
    let reprocess: () -> Void
    let saved: () -> Void

    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                artworkPreview
                    .frame(maxWidth: .infinity)
                    .frame(height: 230)
                    .listRowBackground(Color.clear)

                if workingImage != nil {
                    Button("重新裁剪与抠图", systemImage: "wand.and.stars", action: reprocess)
                }
            }

            Section("基本信息") {
                TextField("名称（可留空）", text: $name)
                Picker("展示架", selection: $selectedShelfID) {
                    ForEach(shelves) { shelf in
                        Text(shelf.name).tag(Optional(shelf.id))
                    }
                }
                TextField("标签，用逗号分隔", text: $tagsText, axis: .vertical)
                    .lineLimit(1...3)
            }

            Section("收藏故事") {
                TextField("获得地点、日期或想记住的故事", text: $notes, axis: .vertical)
                    .lineLimit(3...8)
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppTheme.paper)
        .navigationTitle(existingItem == nil ? "收藏信息" : "编辑收藏")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消", systemImage: "xmark", action: cancel)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存", systemImage: "checkmark") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSaving || (existingItem == nil && (workingImage == nil || maskImage == nil)))
            }
        }
        .overlay {
            if isSaving {
                ProgressView("正在保存")
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .onAppear {
            if selectedShelfID == nil {
                selectedShelfID = shelves.first(where: \.isSystem)?.id ?? shelves.first?.id
            }
        }
    }

    @ViewBuilder
    private var artworkPreview: some View {
        if let image = previewImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .padding()
                .background(AppTheme.paperGradient, in: RoundedRectangle(cornerRadius: AppTheme.cardCornerRadius))
                .overlay(RoundedRectangle(cornerRadius: AppTheme.cardCornerRadius).stroke(AppTheme.hairline))
        } else {
            ContentUnavailableView("暂无图片", systemImage: "photo")
        }
    }

    private var previewImage: UIImage? {
        if didReprocess, let workingImage, let maskImage {
            let previewSource = workingImage.resized(longestEdge: 2048)
            let enhanced = CoreImageEnhancer().enhancedImage(
                previewSource,
                settings: enhancementSettings
            ) ?? previewSource
            return ImageCompositor.apply(mask: maskImage, to: enhanced)
        }
        return existingItem?.cutoutImageData.flatMap(UIImage.init(data:))
            ?? workingImage
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        do {
            let shelf = shelves.first { $0.id == selectedShelfID }
                ?? ShelfStore.ensureUnfiledShelf(in: modelContext)
            let tags = Collectible.normalizedTags(from: tagsText)
            let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)

            var export: (original: Data, cutout: Data, mask: Data, thumbnail: Data)?
            if didReprocess || existingItem == nil {
                guard let workingImage, let maskImage else { throw ImageProcessingError.invalidImage }
                export = try ImageProcessingService.export(
                    original: workingImage,
                    mask: maskImage,
                    enhancement: enhancementSettings
                )
            }

            if let existingItem {
                let shelfChanged = existingItem.shelf?.id != shelf.id
                existingItem.name = cleanName.isEmpty ? "未命名收藏" : cleanName
                existingItem.notes = notes
                existingItem.tags = tags
                existingItem.updatedAt = Date()
                existingItem.shelf = shelf
                if shelfChanged { existingItem.shelfOrder = ShelfStore.nextItemOrder(in: shelf) }
                if let export {
                    existingItem.originalImageData = export.original
                    existingItem.cutoutImageData = export.cutout
                    existingItem.maskImageData = export.mask
                    existingItem.thumbnailImageData = export.thumbnail
                    existingItem.enhancementEnabled = enhancementSettings.isEnabled
                    existingItem.enhancementIntensity = enhancementSettings.normalized.intensity
                }
            } else if let export {
                let item = Collectible(
                    name: cleanName.isEmpty ? "未命名收藏" : cleanName,
                    notes: notes,
                    tags: tags,
                    shelfOrder: ShelfStore.nextItemOrder(in: shelf),
                    originalImageData: export.original,
                    cutoutImageData: export.cutout,
                    maskImageData: export.mask,
                    thumbnailImageData: export.thumbnail,
                    enhancementEnabled: enhancementSettings.isEnabled,
                    enhancementIntensity: enhancementSettings.normalized.intensity,
                    shelf: shelf
                )
                modelContext.insert(item)
            }
            try modelContext.save()
            saved()
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
        }
    }
}
