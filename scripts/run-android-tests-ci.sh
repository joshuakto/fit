#!/bin/sh
# Appium must start before wdio, with NODE_OPTIONS cleared. See #254 for details.
# Short version: wdio sets NODE_OPTIONS=--import tsx/register for .ts spec loading;
# appium inherits it and crashes resolving unicorn-magic/node (ESM-only).
# EXTERNAL_APPIUM=1 tells wdio.mobile.conf.mjs to skip its built-in appium service.
#
# Port 4723 is appium's default and must match wdio.mobile.conf.mjs.
unset NODE_OPTIONS
node node_modules/appium/index.js \
    --base-path / \
    --allow-insecure "*:chromedriver_autodownload,*:adb_shell" \
    --port 4723 > appium-server.log 2>&1 &
APPIUM_PID=$!

i=0
while [ "$i" -lt 30 ]; do
    if curl -sf http://localhost:4723/status > /dev/null 2>&1; then
        echo "Appium ready after $((i * 2)) seconds"
        break
    fi
    i=$((i + 1))
    sleep 2
done

EXTERNAL_APPIUM=1 npm run test:android
STATUS=$?
kill "$APPIUM_PID" 2>/dev/null || true
exit "$STATUS"
