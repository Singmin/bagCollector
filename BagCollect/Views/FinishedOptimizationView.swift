import SwiftUI
import UIKit

private enum OptimizationPreviewMode: String, CaseIterable, Identifiable {
    case original = "原图"
    case cutout = "抠图"
    case enhanced = "增强"

    var id: String { rawValue }
}

struct FinishedOptimizationView: View {
    let image: UIImage
    let mask: UIImage
    let maskSource: MaskSource
    let candidateCount: Int
    @Binding var settings: EnhancementSettings
    let cancel: () -> Void
    let back: () -> Void
    let retry: () -> Void
    let completion: () -> Void

    @State private var previewMode: OptimizationPreviewMode = .enhanced
    @State private var report: QualityReport?
    @State private var originalCutout: UIImage?
    @State private var enhancedCutout: UIImage?
    @State private var isProcessing = true
    @State private var renderTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                EditorialEyebrow("NEW OBJECT · 4 / 5")

                preview

                Picker("预览方式", selection: $previewMode) {
                    ForEach(OptimizationPreviewMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("optimization-preview-picker")

                qualityCard
                enhancementCard

                HStack(spacing: 12) {
                    Button("返回精修", systemImage: "paintbrush", action: back)
                        .buttonStyle(.bordered)
                    Button("重新识别", systemImage: "arrow.clockwise", action: retry)
                        .buttonStyle(.bordered)
                }
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, AppTheme.pagePadding)
            .padding(.top, 18)
            .padding(.bottom, 32)
        }
        .editorialScreenBackground()
        .navigationTitle("成品优化")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark", action: cancel)
            }
            ToolbarItem(placement: .topBarLeading) {
                Button("返回", systemImage: "chevron.left", action: back)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("下一步", systemImage: "arrow.right", action: completion)
                    .buttonStyle(.borderedProminent)
                    .disabled(isProcessing || report?.hasBlockingIssue != false)
                    .accessibilityIdentifier("optimization-next")
            }
        }
        .onAppear { reload(debounced: false) }
        .onChange(of: settings) { _, _ in reload(debounced: true) }
        .onDisappear { renderTask?.cancel() }
    }

    private var preview: some View {
        ZStack {
            CheckerboardBackground()
            if let displayedImage {
                Image(uiImage: displayedImage)
                    .resizable()
                    .scaledToFit()
                    .padding(18)
            } else {
                ProgressView("正在生成预览")
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 350)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cardCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardCornerRadius, style: .continuous)
                .stroke(AppTheme.hairline)
        }
        .accessibilityIdentifier("optimization-preview")
    }

    private var displayedImage: UIImage? {
        switch previewMode {
        case .original:
            image
        case .cutout:
            originalCutout
        case .enhanced:
            settings.isEnabled ? enhancedCutout : originalCutout
        }
    }

    @ViewBuilder
    private var qualityCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                if let report {
                    Image(systemName: report.status.symbol)
                        .foregroundStyle(report.status.color)
                    Text(report.status.title)
                        .font(.headline)
                } else {
                    ProgressView()
                    Text("正在检查成品")
                        .font(.headline)
                }
                Spacer()
            }

            if let report {
                if report.issues.isEmpty {
                    Text("主体、边缘和画面质量均未发现明显问题。")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.mutedInk)
                } else {
                    ForEach(report.issues) { issue in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(issue.title, systemImage: issue.severity.symbol)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(issue.severity.color)
                            Text(issue.guidance)
                                .font(.footnote)
                                .foregroundStyle(AppTheme.mutedInk)
                                .padding(.leading, 24)
                        }
                    }
                }
            }
        }
        .padding(18)
        .background(AppTheme.paperLight, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppTheme.hairline)
        }
        .accessibilityIdentifier("quality-report")
    }

    private var enhancementCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle("自动增强", isOn: $settings.isEnabled)
                .font(.headline)
                .accessibilityIdentifier("enhancement-toggle")

            Text("只调整曝光、白平衡和明暗层次，不改变蒙版边缘。原始照片始终保留。")
                .font(.footnote)
                .foregroundStyle(AppTheme.mutedInk)

            if settings.isEnabled {
                HStack {
                    Image(systemName: "circle.lefthalf.filled")
                        .foregroundStyle(AppTheme.mutedInk)
                    Slider(value: $settings.intensity, in: 0...1)
                        .accessibilityLabel("增强强度")
                        .accessibilityValue("\(Int(settings.intensity * 100))%")
                    Text("\(Int(settings.intensity * 100))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(AppTheme.mutedInk)
                        .frame(width: 38, alignment: .trailing)
                }
            }
        }
        .padding(18)
        .background(AppTheme.paperLight, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppTheme.hairline)
        }
    }

    private func reload(debounced: Bool) {
        renderTask?.cancel()
        isProcessing = true
        let settingsSnapshot = settings.normalized
        let imageSnapshot = image.resized(longestEdge: 1600)
        let maskSnapshot = mask
        let context = QualityValidationContext(maskSource: maskSource, candidateCount: candidateCount)

        renderTask = Task {
            if debounced {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
            }

            let output = await Task.detached(priority: .userInitiated) {
                let original = ImageCompositor.apply(mask: maskSnapshot, to: imageSnapshot)
                let enhancedSource = CoreImageEnhancer().enhancedImage(
                    imageSnapshot,
                    settings: settingsSnapshot
                ) ?? imageSnapshot
                let enhanced = ImageCompositor.apply(mask: maskSnapshot, to: enhancedSource)
                let report = DefaultImageQualityValidator().validate(
                    image: enhancedSource,
                    mask: maskSnapshot,
                    context: context
                )
                return (original, enhanced, report)
            }.value

            guard !Task.isCancelled else { return }
            originalCutout = output.0
            enhancedCutout = output.1
            report = output.2
            isProcessing = false
        }
    }
}

private extension QualityStatus {
    var color: Color {
        switch self {
        case .ready: .green
        case .needsReview: .orange
        case .needsFix: .red
        }
    }
}

private extension QualitySeverity {
    var symbol: String {
        switch self {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .blocking: "xmark.octagon"
        }
    }

    var color: Color {
        switch self {
        case .info: AppTheme.mutedInk
        case .warning: .orange
        case .blocking: .red
        }
    }
}
