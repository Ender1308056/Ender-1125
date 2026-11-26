#!/usr/bin/env bash
# 节奏探索 · Rhythm Pathfinder 玩法验证档案 —— 一键推送脚本
# 用法: bash push-to-github.sh <GitHub Personal Access Token>
# PAT 需勾选 repo 权限（私有仓库勾 repo:status + repo 全部，公开仓库勾 public_repo + workflow）。
set -euo pipefail

PAT="${1:-}"
if [ -z "$PAT" ]; then
  echo "用法: bash push-to-github.sh <GitHub PAT>"
  exit 1
fi

cd "$(dirname "$0")"

git init -q
git config user.name "WorkBuddy Archive"
git config user.email "archive@workbuddy.local"

git add README.md "对话记录-2026-11-25.md" worklog/2026-11-25.md \
  index.html css/style.css js/game.js "assets/素材清单.txt" push-to-github.sh

if git diff --cached --quiet; then
  echo "没有需要提交的变更。"
else
  git commit -q -m "档案归档：节奏探索 · Rhythm Pathfinder（归档日期 2026-11-25）"
fi

# 绕过本地失效代理；若你的环境需要代理，请去掉 -c http.proxy= -c https.proxy=
git -c http.proxy= -c https.proxy= push -f \
  "https://${PAT}@github.com/Ender1308056/Ender-1125.git" HEAD:main

echo "推送完成：https://github.com/Ender1308056/Ender-1125"
