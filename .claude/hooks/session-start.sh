#!/bin/bash
set -euo pipefail

# Claude Code on the web のセッション開始時に、検証を即実行できるよう依存を導入するフック。
# プロジェクトを立ち上げたら、下の TODO をこのプロジェクトの依存導入に書き換えること
# （例: npm install / pip install -e ".[dev]" / bundle install）。
# 出力はログへ逃がして、セッション文脈に流れる行を最小にする。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
LOG=/tmp/session-start-setup.log

# TODO: ここに依存導入コマンドを書く。例:
#   npm install --no-audit --no-fund > "$LOG" 2>&1
#   echo "deps ready: npm install 完了（検証コマンドが実行可能。ログ: $LOG）"

echo "session-start: 依存導入は未定義（テンプレート直後。.claude/hooks/session-start.sh の TODO を書き換える）"
