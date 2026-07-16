#!/bin/bash
# 启动日常 Chrome 并开启远程调试，用于 CDP 抓取
set -e
PROFILE_DIR="/tmp/chrome-fanyi-real-profile"
if [ ! -d "$PROFILE_DIR" ]; then
  cp -R "$HOME/Library/Application Support/Google/Chrome" "$PROFILE_DIR"
fi

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --no-sandbox \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "about:blank" >/tmp/chrome-fanyi.log 2>&1 &

echo "Chrome launched with remote debugging on port 9222 (pid $!)"
