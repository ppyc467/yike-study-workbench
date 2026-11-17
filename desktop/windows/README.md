# Windows 桌面计时小窗

读取一刻网页窗口标题中的计时状态，在主窗口最小化时显示悬浮小窗。支持自由计时、番茄倒计时、暂停状态和点击返回主窗口。

## 编译

需要 Windows 和 64 位 .NET Framework 4.x。在仓库根目录运行：

```powershell
powershell -NoProfile -File desktop/windows/build.ps1
```

输出为 `bin/YikeMiniTimer.exe`，首次编译会复制一份示例 `bin/launcher.json`。

## 使用

先启动网页端。在 Microsoft Edge 中打开一刻，然后运行：

```powershell
Start-Process -FilePath ./desktop/windows/bin/YikeMiniTimer.exe -ArgumentList '--watch-only'
```

在 60 秒内让一刻窗口出现；开始计时后最小化主窗口，小窗会显示。安装为独立浏览器应用可减少其他标签页标题的干扰。

直接双击程序会按 `bin/launcher.json` 启动浏览器。请将 `executable` 改为自己的 Edge 完整路径，`arguments` 改为自己的网页或已安装应用参数。`appId` 可以留空，程序会按一刻窗口标题查找；需要锁定某个已安装应用时填写它的 AppUserModelID。

自测：

```powershell
$result = Start-Process -FilePath ./desktop/windows/bin/YikeMiniTimer.exe -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
Get-Content ./desktop/windows/bin/self-test-result.txt
if ($result.ExitCode -ne 0) { throw 'Self-test failed' }
```

小窗根据网页标题读取状态，不直接访问数据库。当前窗口识别限定为 Edge，依赖 Windows UI Automation；缩放和多显示器行为需要按使用环境确认。
