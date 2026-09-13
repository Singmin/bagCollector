import SwiftData
import SwiftUI

#if CLOUDKIT_ENABLED
import CloudKit
#endif

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Query private var items: [Collectible]
    @State private var syncStatus = "正在检查…"
    @State private var syncSymbol = "icloud"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 5) {
                        EditorialEyebrow("SETTINGS")
                        Text("我的陈列柜")
                            .font(.editorialTitle)
                    }

                    VStack(spacing: 10) {
                        settingsCard(title: "收藏统计", value: "\(items.count) 件", symbol: "square.stack.3d.up")
                        settingsCard(title: "图片数据", value: imageDataSize, symbol: "internaldrive")
                        settingsCard(title: "iCloud 同步", value: syncStatus, symbol: syncSymbol)
                    }

                    Text("照片处理和收藏数据默认保存在此设备。iCloud 不可用时，不会阻止添加或编辑收藏。")
                        .font(.caption)
                        .foregroundStyle(AppTheme.mutedInk)
                        .lineSpacing(4)
                        .padding(.horizontal, 4)

                    VStack(alignment: .leading, spacing: 8) {
                        EditorialEyebrow("ABOUT")
                        HStack {
                            Text("BagCollect")
                                .font(.editorialCardTitle)
                            Spacer()
                            Text("版本 1.0")
                                .font(.caption)
                                .foregroundStyle(AppTheme.mutedInk)
                        }
                        Text("你的私人视觉陈列柜")
                            .font(.caption)
                            .foregroundStyle(AppTheme.mutedInk)
                    }
                    .padding(18)
                    .background(Color.white.opacity(0.48), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .padding(.horizontal, AppTheme.pagePadding)
                .padding(.top, 22)
                .padding(.bottom, 36)
            }
            .editorialScreenBackground()
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成", systemImage: "checkmark") { dismiss() }
                }
            }
            .task { await refreshSyncStatus() }
        }
    }

    private func settingsCard(title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 13) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .medium))
                .frame(width: 34, height: 34)
                .background(AppTheme.paperDeep, in: Circle())
            Text(title)
                .font(.subheadline)
            Spacer()
            Text(value)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(AppTheme.mutedInk)
                .multilineTextAlignment(.trailing)
        }
        .padding(16)
        .background(Color.white.opacity(0.52), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(AppTheme.hairline.opacity(0.55)))
    }

    private var imageByteCount: Int {
        items.reduce(0) { result, item in
            result
                + (item.originalImageData?.count ?? 0)
                + (item.cutoutImageData?.count ?? 0)
                + (item.maskImageData?.count ?? 0)
                + (item.thumbnailImageData?.count ?? 0)
        }
    }

    private var imageDataSize: String {
        ByteCountFormatter.string(fromByteCount: Int64(imageByteCount), countStyle: .file)
    }

    private func refreshSyncStatus() async {
        #if CLOUDKIT_ENABLED
        do {
            let status = try await CKContainer.default().accountStatus()
            switch status {
            case .available:
                syncStatus = "已启用"
                syncSymbol = "icloud.fill"
            case .noAccount:
                syncStatus = "未登录 iCloud"
                syncSymbol = "icloud.slash"
            case .restricted:
                syncStatus = "此设备受限"
                syncSymbol = "icloud.slash"
            case .couldNotDetermine:
                syncStatus = "暂时无法确定"
                syncSymbol = "exclamationmark.icloud"
            case .temporarilyUnavailable:
                syncStatus = "暂时不可用"
                syncSymbol = "exclamationmark.icloud"
            @unknown default:
                syncStatus = "未知状态"
                syncSymbol = "exclamationmark.icloud"
            }
        } catch {
            syncStatus = "检查失败"
            syncSymbol = "exclamationmark.icloud"
        }
        #else
        syncStatus = "待配置开发者账号"
        syncSymbol = "icloud.slash"
        #endif
    }
}
