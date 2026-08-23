#!/usr/bin/env node
/**
 * E11 后续问题 5 缺口清单冻结脚本（one-shot）。
 *
 * 数据源：
 *   - /work/hsk-ng/modeling/protocol/P{1..4}/model.md（契约层 contracts[]）
 *   - /work/hsk-ng/modeling/protocol/P{1..4}/derived/specs.json（已投影 specs）
 *   - /work/hsk-ng/modeling/bindings.yaml（errorMap）
 *
 * 输出（stdout JSON）：
 *   - errorMapCodes: errorMap 声明的错误码集合（大小）
 *   - specsErrorCodes: 所有 specs.errorResponses 投影的错误码并集（大小）
 *   - exceptionCodes: 异常路径声明的错误码并集（大小）
 *   - missingInSpecs: errorMap 中存在但 specs 中未声明的错误码
 *   - orphanContractInterfaces: model.md 契约层 contracts[] 中 interface 名未被任何
 *     transition.action / sourceId 匹配的契约（即"无匹配接口"投影空）
 *   - orphanContractErrorCodes: 这些 orphan contract 涉及的 errorCode 子集
 *   - perProtocol: 各协议 specs/errorMap/exception 计数 + 孤儿契约清单
 *
 * 用途：冻结缺口清单，作为工具链修复（specifier 投影 + checker warning）的基准。
 * 落地后此脚本可保留供复验，不强制依赖工具链。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HSK_ROOT = resolve(__dirname, '../../hsk-ng');
const PROTO_ROOT = resolve(__dirname, '..');

function readYaml(p) {
  return yaml.parse(readFileSync(p, 'utf8'));
}
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function extractContractErrorCodes(contracts) {
  const codes = new Set();
  for (const c of contracts ?? []) {
    for (const er of c.errorResponses ?? []) {
      if (er.errorCode) codes.add(er.errorCode);
    }
  }
  return codes;
}

function extractSpecsErrorCodes(specs) {
  const codes = new Set();
  for (const s of specs ?? []) {
    for (const er of s.errorResponses ?? []) {
      if (er.errorCode) codes.add(er.errorCode);
    }
  }
  return codes;
}

function extractExceptionErrorCodes(exceptions) {
  const codes = new Set();
  for (const e of exceptions ?? []) {
    if (e.errorCode) codes.add(e.errorCode);
  }
  return codes;
}

function extractTransitionActionNames(modelText) {
  // 解析「| action |」列（机械正则：markdown 表格中动作列）
  const actions = new Set();
  // 抓 # 转移规则 / 端点转移 表行
  const tableLineRe = /^\|\s*T\d+\s*\|\s*[^|]+\|\s*[^|]+\|\s*[^|]+\|\s*([^|]+?)\s*\|/;
  for (const line of modelText.split('\n')) {
    const m = tableLineRe.exec(line);
    if (m && m[1]) actions.add(m[1].trim());
  }
  // 同时抓合约 contract.interface（避免重复）：用 contract block 头部
  return actions;
}

function extractContractInterfaceNames(modelText) {
  // 解析契约层 YAML 中 `interface: xxx`
  const names = new Set();
  const re = /^\s*-\s*interface:\s*([a-zA-Z0-9_]+)/gm;
  for (const m of modelText.matchAll(re)) {
    names.add(m[1]);
  }
  return names;
}

const PROTOCOLS = ['P1', 'P2', 'P3', 'P4'];
const report = { perProtocol: {}, totals: {} };

// 1. errorMap（系统级，bindings.yaml 中是 code→meta 形态的 map，不是数组）
let errorMapCodes = new Set();
const bindingsPath = resolve(HSK_ROOT, 'modeling/bindings.yaml');
if (existsSync(bindingsPath)) {
  const bindings = readYaml(bindingsPath);
  const em = bindings.errorMap;
  if (em && typeof em === 'object' && !Array.isArray(em)) {
    for (const code of Object.keys(em)) {
      errorMapCodes.add(code);
    }
  }
}

// 累加器
let allSpecsErrorCodes = new Set();
let allExceptionCodes = new Set();
let allOrphanInterfaces = new Set();
let allOrphanErrorCodes = new Set();
let allContractErrorCodes = new Set();

for (const p of PROTOCOLS) {
  const modelPath = resolve(HSK_ROOT, `modeling/protocol/${p}/model.md`);
  const specsPath = resolve(HSK_ROOT, `modeling/protocol/${p}/derived/specs.json`);
  const modelText = existsSync(modelPath) ? readFileSync(modelPath, 'utf8') : '';
  const specs = existsSync(specsPath) ? readJson(specsPath) : { specs: [] };

  // 契约层 YAML：粗抽取第一段 ```yaml ... ``` 块并解析
  const codeFenceRe = /```yaml\n([\s\S]*?)\n```/g;
  let contractYamlText = '';
  for (const m of modelText.matchAll(codeFenceRe)) {
    if (m[1].includes('contracts:')) {
      contractYamlText = m[1];
      break;
    }
  }
  let contracts = [];
  if (contractYamlText) {
    try {
      const parsed = yaml.parse(contractYamlText);
      contracts = parsed?.contracts ?? [];
    } catch (e) {
      contracts = [];
    }
  }

  const contractErrCodes = extractContractErrorCodes(contracts);
  const specsErrCodes = extractSpecsErrorCodes(specs.specs);
  // 异常路径 errorCode：直接从 model.md 表格「| EX* | ... | ... | ... | ... | <code> |」中提取
  const exceptionErrCodes = (() => {
    const set = new Set();
    const re = /^\|\s*EX\d+\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([a-z_][a-z0-9_]*)/gm;
    for (const m of modelText.matchAll(re)) {
      set.add(m[1]);
    }
    return set;
  })();

  // transitions 与契约 interface 对齐（target specifier 匹配：transition.action / transition.id）
  const transitionActions = extractTransitionActionNames(modelText);
  const contractInterfaces = extractContractInterfaceNames(modelText);
  const orphanInterfaces = new Set();
  for (const iface of contractInterfaces) {
    if (!transitionActions.has(iface)) {
      orphanInterfaces.add(iface);
    }
  }
  // 收集 orphan 涉及的错误码
  const orphanCodes = new Set();
  for (const c of contracts) {
    if (orphanInterfaces.has(c.interface)) {
      for (const er of c.errorResponses ?? []) {
        if (er.errorCode) orphanCodes.add(er.errorCode);
      }
    }
  }

  report.perProtocol[p] = {
    errorMapCodesCount: errorMapCodes.size, // 全局共享，仅记 P1 一次
    specsErrorCodesCount: specsErrCodes.size,
    contractErrorCodesCount: contractErrCodes.size,
    exceptionErrorCodesCount: exceptionErrCodes.size,
    transitionActionsCount: transitionActions.size,
    contractInterfacesCount: contractInterfaces.size,
    orphanInterfacesCount: orphanInterfaces.size,
    orphanInterfaces: Array.from(orphanInterfaces),
    orphanErrorCodes: Array.from(orphanCodes),
    specsErrorCodes: Array.from(specsErrCodes),
  };

  for (const c of specsErrCodes) allSpecsErrorCodes.add(c);
  for (const c of exceptionErrCodes) allExceptionCodes.add(c);
  for (const i of orphanInterfaces) allOrphanInterfaces.add(i);
  for (const c of orphanCodes) allOrphanErrorCodes.add(c);
  for (const c of contractErrCodes) allContractErrorCodes.add(c);
}

const missingInSpecs = Array.from(errorMapCodes).filter((c) => !allSpecsErrorCodes.has(c));

report.totals = {
  errorMapCodesCount: errorMapCodes.size,
  specsErrorCodesCount: allSpecsErrorCodes.size,
  exceptionErrorCodesCount: allExceptionCodes.size,
  contractErrorCodesCount: allContractErrorCodes.size,
  orphanInterfacesCount: allOrphanInterfaces.size,
  orphanErrorCodesCount: allOrphanErrorCodes.size,
  missingInSpecsCount: missingInSpecs.length,
  missingInSpecs,
  orphanInterfaces: Array.from(allOrphanInterfaces),
  orphanErrorCodes: Array.from(allOrphanErrorCodes),
};

console.log(JSON.stringify(report, null, 2));