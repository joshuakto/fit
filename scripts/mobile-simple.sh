#!/bin/bash

# Simple Mobile Emulation for FIT Plugin (No Appium/Android)
# Usage: ./scripts/mobile-simple.sh

echo "📱 Simple Mobile Emulation for FIT Plugin..."

# Build plugin
echo "🔨 Building..."
npm run build

# Launch regular obsidian with simple mobile window sizing
echo "🔧 Launching Obsidian with mobile-sized window..."
echo ""

# Create mobile-sized Obsidian window
# Using obsidian-launcher with window size options
npx obsidian-launcher launch \
    --plugin . \
    test/vaults/basic \
    -- \
    --force-device-scale-factor=2 \
    --window-position=100,100 \
    --window-size=390,844

echo ""
echo "✅ Obsidian launched in mobile-sized window!"
echo "📱 Window size: 390x844 (iPhone-like)"
echo ""
echo "🔧 To enable true mobile emulation:"
echo "   1. Press F12 for DevTools"
echo "   2. Console → this.app.emulateMobile(true)"
echo ""
echo "💡 Now test FIT plugin with mobile UI!"