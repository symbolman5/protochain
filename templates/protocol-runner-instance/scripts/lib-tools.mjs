// 工具解析（可移植）：NODE/PROTOCHAIN 环境变量可覆盖；缺省用 PATH 中的 node/protochain。
export function nodeBin() {
  const v = process.env.NODE;
  return v && !v.includes("{{") ? v : "node";
}
export function protoBin() {
  const v = process.env.PROTOCHAIN;
  return v && !v.includes("{{") ? v : "protochain";
}
export function need(name) {
  const v = process.env[name];
  if (!v || v.includes("{{")) throw new Error(`环境占位符未替换: ${name}`);
  return v;
}
