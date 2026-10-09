import { writeFile } from "node:fs/promises";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
const [root, binary, resultPath] = process.argv.slice(2);
const adapter = new HerdrAdapter({
  kind: "herdr",
  id: "test",
  label: "Test",
  binary,
  configRoot: root,
  cwd: root,
});
await adapter.init();
const ref = {
  session: "test",
};
const workspace: any = (await adapter.call("workspace.create", ref)).result;
const paneId = workspace.result.root_pane.pane_id;
await adapter.call("pane.run", { ...ref, paneId, command: "sleep 120" });
await writeFile(resultPath, JSON.stringify({ ...ref, paneId }));
setInterval(() => {}, 1000);
