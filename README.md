# BagCollect

BagCollect 是一个使用 SwiftUI 构建的私人视觉陈列柜。第一版支持从系统相册选择照片、裁剪、使用 Vision 识别前景主体、手动画笔精修蒙版、归入展示架，并通过横向陈列和网格检索浏览收藏。

## 运行要求

- macOS 与 Xcode 26.6（当前机器已经安装）
- iOS 17.0 或更高版本的模拟器/设备
- 首次构建前需要接受 Xcode License：`sudo xcodebuild -license accept`

打开 `BagCollect.xcodeproj`，选择 iPhone 模拟器后运行即可。照片选择器在模拟器中可使用模拟器照片库；Vision 抠图建议同时在真机验证。

## iCloud 同步

工程默认以本地模式构建，确保未配置付费开发者账号时也可以运行。启用个人 iCloud 同步时：

1. 在 Target 的 Signing & Capabilities 中添加 iCloud，并勾选 CloudKit。
2. 添加 Background Modes，勾选 Remote notifications。
3. 创建或选择私有 CloudKit Container。
4. 在 Swift Compiler - Custom Flags 中为 Debug/Release 增加 `-D CLOUDKIT_ENABLED`。
5. 使用同一 iCloud 账号在两台设备验证新增、编辑、移动和删除同步。

数据模型没有唯一约束，关系保持可选，适配 SwiftData 管理的 CloudKit 同步约束。
