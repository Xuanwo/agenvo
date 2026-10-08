import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten-core";
let engine: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
// Only the Wasm module is shared; newContext creates an owned runtime per call.
export const getEngine = () =>
  (engine ??= newQuickJSWASMModuleFromVariant(
    newVariant(variant, { wasmModule }),
  ));
