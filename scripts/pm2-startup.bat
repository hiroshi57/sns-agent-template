@echo off
:: PM2 自動起動スクリプト（Windows ログオン時にタスクスケジューラから実行）
::
:: ⚠️ 絶対パスを直接書かない
::    %~dp0 = このバッチファイルのあるディレクトリ (scripts\)
::    %~dp0.. = リポジトリルート (chatwork-x-automation\)

:: リポジトリルートに移動
cd /d "%~dp0.."

:: pm2 が保存した設定を復元して全プロセスを再起動
call npx pm2 resurrect

:: 復元確認
call npx pm2 status
