// A deterministic agent for herdr-core: it reports status through OSC 7501,
// answers each submitted line, and treats esc or ctrl+c as an interrupt.
// It runs in a real hc terminal and needs no model.
const report = (state, extra = "") =>
  process.stdout.write(`\x1b]7501;state=${state}${extra}\x1b\\`);
let line = "";
let pasting = false;
let timer;
const finish = (text) => {
  clearTimeout(timer);
  process.stdout.write(text + "\r\n");
  report("idle");
};
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk === "\x1b" || chunk === "\x03") {
    if (timer) finish("interrupted");
    timer = undefined;
    return;
  }
  // A bracketed paste is one prompt even when it spans lines.
  chunk = chunk
    .replaceAll("\x1b[200~", "\u0002")
    .replaceAll("\x1b[201~", "\u0003");
  for (const char of chunk) {
    if (char === "\u0002" || char === "\u0003") {
      pasting = char === "\u0002";
      continue;
    }
    if (pasting || (char !== "\r" && char !== "\n")) {
      line += char;
      continue;
    }
    const prompt = line.trim();
    line = "";
    if (!prompt) continue;
    report("working");
    process.stdout.write(`received:${prompt}\r\n`);
    // "hold" keeps the turn working until it is interrupted.
    if (prompt.endsWith("hold")) timer = setTimeout(() => {}, 600000);
    else timer = setTimeout(() => finish(`pong:${prompt}`), 300);
  }
});
process.stdout.write("\x1b[?2004hfixture agent ready\r\n");
report("idle");
