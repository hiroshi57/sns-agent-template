# PM2 Windows 自動起動 設定スクリプト
#
# 実行方法（PowerShell を管理者として実行）:
#   powershell -ExecutionPolicy Bypass -File scripts\pm2-windows-autostart.ps1
#
# やること:
#   Windows タスクスケジューラーに「ログオン時に pm2 resurrect」を登録
#   → PC 再起動後も pm2 プロセスが自動復元される（教訓 #PM2-1 対処）
#
# ⚠️ 前提:
#   npm run pm2:setup を先に実行して pm2 save 済みであること
#   pm2 がグローバルインストール済みであること: npm install -g pm2

# ── 設定 ────────────────────────────────────────────────────────
$TaskName   = "PM2-AutoStart-ChatworkX"
$TaskPath   = "\ChatworkAutomation\"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir
$StartupBat = Join-Path $ScriptDir "pm2-startup.bat"

Write-Host ""
Write-Host "══════════════════════════════════════════"
Write-Host "  PM2 Windows 自動起動 セットアップ"
Write-Host "══════════════════════════════════════════"
Write-Host ""
Write-Host "リポジトリルート : $RepoRoot"
Write-Host "起動スクリプト   : $StartupBat"
Write-Host "タスク名         : $TaskPath$TaskName"
Write-Host ""

# ── タスクスケジューラーへの登録 ────────────────────────────────
try {
    # cmd.exe 経由で .bat を実行（pm2 は PATH 依存のため cmd 経由が確実）
    $Action   = New-ScheduledTaskAction `
        -Execute "cmd.exe" `
        -Argument "/c `"$StartupBat`""

    # ユーザーログオン時にトリガー
    $Trigger  = New-ScheduledTaskTrigger -AtLogOn

    # 設定: タイムアウト 5 分、最優先で実行
    $Settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -MultipleInstances IgnoreNew

    # 登録（既存があれば上書き）
    Register-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $TaskPath `
        -Action   $Action `
        -Trigger  $Trigger `
        -Settings $Settings `
        -RunLevel Highest `
        -Force | Out-Null

    Write-Host "✅ タスクスケジューラーに登録しました"
    Write-Host ""
    Write-Host "確認方法:"
    Write-Host "  タスクスケジューラー → $TaskPath$TaskName"
    Write-Host ""
    Write-Host "テスト実行（今すぐ pm2 resurrect を試す）:"
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName' -TaskPath '$TaskPath'"
    Write-Host ""

} catch {
    Write-Host "❌ タスクスケジューラーの登録に失敗しました"
    Write-Host "   エラー: $_"
    Write-Host ""
    Write-Host "原因: PowerShell を「管理者として実行」していない可能性があります"
    Write-Host "対処: PowerShell を右クリック→「管理者として実行」で再実行してください"
    exit 1
}

# ── pm2 save が実行済みか確認 ─────────────────────────────────
$DumpFile = Join-Path $env:USERPROFILE ".pm2\dump.pm2"
if (-Not (Test-Path $DumpFile)) {
    Write-Host "⚠️  警告: pm2 のダンプファイルが見つかりません"
    Write-Host "   $DumpFile"
    Write-Host ""
    Write-Host "   次のコマンドを実行してください:"
    Write-Host "   npm run pm2:setup"
    Write-Host ""
} else {
    Write-Host "✅ pm2 ダンプファイルを確認しました: $DumpFile"
}

Write-Host "══════════════════════════════════════════"
Write-Host "  セットアップ完了"
Write-Host "  次回 PC 再起動時から PM2 が自動起動します"
Write-Host "══════════════════════════════════════════"
Write-Host ""
