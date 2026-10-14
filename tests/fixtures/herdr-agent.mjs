// A deterministic custom agent exercising Herdr's documented lifecycle reports.
// It runs inside a real PTY and receives prompts through Herdr, without a model.
import { connect } from "node:net";
import readline from "node:readline";
function report(state) {
  return new Promise((resolve, reject) => {
    const socket = connect(
      (process.platform === "win32" ? "\\\\.\\pipe\\" : "") +
        process.env.HERDR_SOCKET_PATH,
    );
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: "report",
          method: "pane.report_agent",
          params: {
            pane_id: process.env.HERDR_PANE_ID,
            source: "custom:agenvo-fixture",
            agent: "fixture",
            state,
          },
        }) + "\n",
      ),
    );
    socket.once("data", (data) => {
      socket.destroy();
      const p = JSON.parse(data);
      if (p.error) reject(new Error(JSON.stringify(p.error)));
      else resolve();
    });
    socket.on("error", reject);
  });
}
if (process.argv.includes("--decorated-output")) {
  console.log(
    [
      "─".repeat(48),
      "",
      "",
      "│ Keep table content │",
      "  Keep indentation",
      "Repeated result",
      "Repeated result",
      "── Working ──",
      "---",
      "█ chart",
      "─".repeat(48),
    ].join("\n"),
  );
}
console.log("Fixture ready");
await report("idle");
let waiting = false;
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  await report("working");
  if (line.includes("ask") && !waiting) {
    waiting = true;
    console.log("Which label should I use?");
    await report("blocked");
  } else {
    console.log("Fixture result: " + line);
    waiting = false;
    await report("idle");
  }
});
