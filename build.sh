#!/bin/bash
# Build script for Croc-WASM
set -e

echo "🐊 Building Croc-WASM..."

# 1. Build the WebSocket relay server (native Go)
echo "  → Building relay server..."
go build -o relay/relay-server ./relay/
echo "    ✅ relay/relay-server ($(ls -lh relay/relay-server | awk '{print $5}'))"

# 2. Build the WASM module (Go → WASM)
echo "  → Building WASM module..."
GOOS=js GOARCH=wasm go build -o public/croc.wasm ./wasm/
echo "    ✅ public/croc.wasm ($(ls -lh public/croc.wasm | awk '{print $5}'))"

# 3. Copy wasm_exec.js if needed
WASM_EXEC=$(go env GOROOT)/lib/wasm/wasm_exec.js
if [ -f "$WASM_EXEC" ]; then
	cp "$WASM_EXEC" public/
	echo "    ✅ public/wasm_exec.js"
fi

echo ""
echo "🐊 Build complete!"
echo "   Run: cd relay && ./relay-server"
echo "   Open: http://localhost:8154"
