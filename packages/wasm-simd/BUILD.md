# WASM SIMD Build Guide

## 🚀 Quick Build

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

### Build Options

1. **Build from the project root** (recommended):

   ```bash
   # Build the WASM and automatically copy it to the Chrome extension
   npm run build:wasm
   ```

2. **Build only the WASM package**:

   ```bash
   # From the packages/wasm-simd directory
   npm run build

   # Or from anywhere using a pnpm filter
   pnpm --filter @chrome-mcp/wasm-simd build
   ```

3. **Development-mode build**:
   ```bash
   npm run build:dev  # unoptimized version, builds faster
   ```

### Build Artifacts

After the build completes, the following are generated in the `pkg/` directory:

- `simd_math.js` - JavaScript bindings
- `simd_math_bg.wasm` - WebAssembly binary file
- `simd_math.d.ts` - TypeScript type definitions
- `package.json` - NPM package info

### Integrating into the Chrome Extension

The WASM files are automatically copied to the `app/chrome-extension/workers/` directory, where the Chrome extension can use them directly:

```typescript
// Using it in the Chrome extension
const wasmUrl = chrome.runtime.getURL('workers/simd_math.js');
const wasmModule = await import(wasmUrl);
```

## 🔧 Development Workflow

1. Modify the Rust code in `src/lib.rs`
2. Run `npm run build` to rebuild
3. The Chrome extension will automatically use the new WASM file

## 📊 Performance Testing

```bash
# Run the benchmark inside the Chrome extension
import { runSIMDBenchmark } from './utils/simd-benchmark';
await runSIMDBenchmark();
```
