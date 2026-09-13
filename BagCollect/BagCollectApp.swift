import SwiftData
import SwiftUI

@main
struct BagCollectApp: App {
    private let modelContainer: ModelContainer = Persistence.makeContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(modelContainer)
    }
}
