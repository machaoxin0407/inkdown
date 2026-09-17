# 墨页 Inkdown v0.1.1

面向 Windows 10/11 x64 的离线 Markdown 阅读与编辑器，现以 MIT 许可开源。

- 修复 Mermaid 框图节点与连线文字不可见，支持浅色、深色主题。
- 编辑区上下滚动时，预览按源码位置同步滚动；预览仍可独立滚动。
- 支持文件夹树、多标签、实时预览、代码高亮、KaTeX 公式和本地图片。
- 保存前检查外部修改，支持 BOM 与 CRLF 保留，以及冲突处理。

下载 `Inkdown_0.1.1_x64-setup.exe` 安装，或完整解压 `Inkdown_0.1.1_x64-standalone.zip` 后运行。`Inkdown.exe` 也作为单文件程序提供；随附 LICENSE 和第三方许可声明。

需要系统 WebView2；缺少运行时的电脑在首次安装时需要联网补齐。当前版本未签名，无自动更新。可用 PowerShell `Get-FileHash 文件名 -Algorithm SHA256` 与 `SHA256SUMS.txt` 对照。

验证范围及性能测量条件见仓库中的 VALIDATION.md。
