// WP-03 假服务器（client.ts 协议面单测专用，纯 ESM）：行分隔 JSON，镜像 serve.rs 行为形——
// hello→hello；run→两 event（分块）+response；fsWrite→response；exec.args 含 boom=error 帧；
// 未知 method=error。
import * as readline from "node:readline";

let silent = false;
const rl = readline.createInterface({ input: process.stdin });
process.stdin.resume();
rl.on("line", (line) => {
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ v: 5, kind: "error", id: 0, payload: { code: "frame_reject", message: "bad" } }) + "\n");
    process.exit(2);
  }
  if (f.kind === "hello") {
    if (silent) return;
    process.stdout.write(JSON.stringify({ v: 5, kind: "hello", payload: { protocol: 5 } }) + "\n");
    return;
  }
  if (silent) return;
  const p = f.payload ?? {};
  const method = p.method;
  if (method === "run") {
    // exec.args 含 "boom"=error 帧（fail-closed 拒绝形镜像真 serve privilege/compile 拒）。
    if ((p.params?.exec?.args ?? []).includes("boom")) {
      process.stdout.write(JSON.stringify({ v: 5, kind: "error", id: f.id, payload: { code: "privilege_missing", message: "无特权（fail-closed 形）" } }) + "\n");
      return;
    }
    // 分两半的 stdout + stderr 各一 event，再 response（事件保序/reqId 关联断言料）。
    const d = p.params?.exec?.args?.join("|") ?? "";
    process.stdout.write(JSON.stringify({ v: 5, kind: "event", payload: { name: "output", data: { reqId: f.id, stream: "stdout", data: "chunk1:" } } }) + "\n");
    process.stdout.write(JSON.stringify({ v: 5, kind: "event", payload: { name: "output", data: { reqId: f.id, stream: "stdout", data: d } } }) + "\n");
    process.stdout.write(JSON.stringify({ v: 5, kind: "event", payload: { name: "output", data: { reqId: f.id, stream: "stderr", data: "E" } } }) + "\n");
    process.stdout.write(JSON.stringify({ v: 5, kind: "response", id: f.id, payload: { result: { exitCode: 7 } } }) + "\n");
    return;
  }
  if (method === "fsWrite") {
    process.stdout.write(JSON.stringify({ v: 5, kind: "response", id: f.id, payload: { result: { exitCode: 0 } } }) + "\n");
    return;
  }
  if (method === "boom") {
    process.stdout.write(JSON.stringify({ v: 5, kind: "error", id: f.id, payload: { code: "privilege_missing", message: "无特权（fail-closed 形）" } }) + "\n");
    return;
  }
  if (method === "silent") {
    silent = true;
    return;
  }
  process.stdout.write(JSON.stringify({ v: 5, kind: "error", id: f.id, payload: { code: "unknown_method", message: method } }) + "\n");
});
rl.on("close", () => process.exit(0));
