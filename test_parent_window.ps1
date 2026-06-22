# 测试 parent window 用于 canvas 嵌入
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = "Test Parent"
$form.Width = 1200
$form.Height = 800
$form.StartPosition = "CenterScreen"
$form.Show()
Write-Host "Parent HWND: $($form.Handle.ToInt64())"
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  Write-Host "tick"
})
$timer.Start()
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[System.Windows.Forms.Application]::Run($form)
