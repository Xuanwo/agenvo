import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
let engine: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
// Only the Wasm module is shared; newContext creates an owned runtime per call.
export const getEngine = () =>
  (engine ??= newQuickJSWASMModuleFromVariant(variant));
