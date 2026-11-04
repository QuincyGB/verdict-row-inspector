import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/langchain.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    bundle: true,
    skipNodeModulesBundle: true,
    shims: true,
    outDir: "dist",
});
