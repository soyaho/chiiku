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

# このプロジェクトの検証（harness/run.js）は、環境に事前導入済みの
# グローバル playwright と /opt/pw-browsers の Chromium を使う。npm install は不要。
# ここでは前提が揃っているかだけ確認する。
{
  node -e "const{execSync}=require('child_process');const p=require('path');let pw;try{pw=require('playwright')}catch(_){pw=require(p.join(execSync('npm root -g').toString().trim(),'playwright'))};console.log('playwright ok')"
  ls "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" | head -5
} > "$LOG" 2>&1 && echo "deps ready: playwright + chromium 事前導入を確認（検証: node harness/run.js。ログ: $LOG）" \
  || echo "deps NG: playwright か Chromium が見つからない（ログ: $LOG）"
