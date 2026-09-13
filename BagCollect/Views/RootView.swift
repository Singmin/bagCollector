import SwiftData
import SwiftUI

private enum AppTab {
    case showcase
    case library
}

struct BottomBarVisibilityPreferenceKey: PreferenceKey {
    static var defaultValue = true

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value && nextValue()
    }
}

struct RootView: View {
    @Environment(\.modelContext) private var modelContext
    @StateObject private var deletionCenter = DeletionCenter()
    @State private var selection = AppTab.showcase
    @State private var isAdding = false
    @State private var showsBottomBar = true

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch selection {
                case .showcase:
                    ShowcaseView { selection = .library }
                case .library:
                    LibraryView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showsBottomBar {
                FloatingTabBar(
                    selection: $selection,
                    add: { isAdding = true }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if deletionCenter.pendingSnapshot != nil {
                UndoDeletionToast {
                    deletionCenter.undo(in: modelContext)
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 102)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .environmentObject(deletionCenter)
        .tint(AppTheme.ink)
        .preferredColorScheme(.light)
        .animation(.snappy, value: deletionCenter.pendingSnapshot != nil)
        .animation(.easeOut(duration: 0.2), value: showsBottomBar)
        .onPreferenceChange(BottomBarVisibilityPreferenceKey.self) { showsBottomBar = $0 }
        .onAppear {
            _ = ShelfStore.ensureUnfiledShelf(in: modelContext)
        }
        .fullScreenCover(isPresented: $isAdding) {
            AddCollectibleFlow()
        }
    }
}

private struct FloatingTabBar: View {
    @Binding var selection: AppTab
    let add: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            tabButton(title: "陈列", symbol: "cabinet", tab: .showcase)

            Button(action: add) {
                Image(systemName: "plus")
                    .font(.system(size: 24, weight: .light))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(AppTheme.ink, in: Circle())
                    .overlay(Circle().stroke(AppTheme.paper, lineWidth: 4))
                    .shadow(color: .black.opacity(0.22), radius: 13, y: 7)
            }
            .accessibilityLabel("添加收藏")
            .accessibilityIdentifier("add-collectible")
            .offset(y: -30)
            .zIndex(1)

            tabButton(title: "全部收藏", symbol: "square.grid.2x2", tab: .library)
        }
        .frame(height: 70)
        .padding(.horizontal, 10)
        .background {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .fill(Color.white.opacity(0.56))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .stroke(.white.opacity(0.78))
                }
        }
        .shadow(color: Color(red: 0.16, green: 0.13, blue: 0.10).opacity(0.17), radius: 20, y: 10)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("floating-tab-bar")
        .padding(.horizontal, 17)
        .padding(.bottom, 10)
    }

    private func tabButton(title: String, symbol: String, tab: AppTab) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.22)) { selection = tab }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .medium))
                Text(title)
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(selection == tab ? AppTheme.ink : AppTheme.mutedInk.opacity(0.76))
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(
                selection == tab ? Color.white.opacity(0.62) : Color.clear,
                in: RoundedRectangle(cornerRadius: 19, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(tab == .showcase ? "showcase-tab" : "library-tab")
    }
}

private struct UndoDeletionToast: View {
    let undo: () -> Void

    var body: some View {
        HStack {
            Label("收藏品已删除", systemImage: "trash")
            Spacer()
            Button("撤销", action: undo)
                .fontWeight(.semibold)
        }
        .font(.subheadline)
        .foregroundStyle(.white)
        .padding()
        .background(AppTheme.ink, in: Capsule())
        .shadow(color: .black.opacity(0.18), radius: 12, y: 5)
        .accessibilityElement(children: .combine)
    }
}
