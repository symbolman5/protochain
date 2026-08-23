#!/usr/bin/env node
/**
 * One-shot 脚本：从 hsk-ng impl（Go）提取接口字段，注入 model.md 契约层。
 *
 * 用途：E2.1 落地步骤 6（数据来源：实例侧）
 *   - 数据源：/work/hsk-ng/impl/portal/internal/storage/store.go（Go struct）
 *            /work/hsk-ng/impl/portal/internal/http/router.go（HTTP 路由 + handle）
 *            /work/hsk-ng/impl/portal/internal/{forwardserver,mapping,...}/service.go（Service I/O）
 *   - 输出形态：YAML contracts[] 段（与 E2.1 §E2.1 L77-85 一致）
 *   - 命名归一化：Go struct PascalCase → JSON camelCase（与 http 层 json tag 一致）
 *
 * 此脚本是「一次性 + 人工复核」：
 *   - 输出到 stdout（人读）；不直接落 model.md
 *   - 人工把 stdout 内容塞到 model.md 的「契约层」段；走修改单流程
 *
 * 覆盖接口（hsk-ng P1）：
 *   - register (T1) → POST /v1/servers ← handleAddServer
 *   - bind (T2) → POST /v1/servers/{serverId}/bind ← handleServerBind
 *
 * 运行：node scripts/extract-contracts-from-impl.mjs
 */

import { readFileSync } from 'node:fs';

// ----------------------------------------------------------------------------
// 数据：从 hsk-ng impl 静态提取（一次性快照）
// 命名归一化：Go PascalCase → JSON camelCase（与 http handler json tag 对齐）
// ----------------------------------------------------------------------------

const HANDLER_REQUEST_FIELDS = {
  // POST /v1/servers（T1 register）
  // 来源：addServerRequest 结构体（http/servers.go L15-32）
  register: {
    currentState: { type: 'string', required: true, description: '当前状态' },
    name: { type: 'string', required: true, description: '节点名字' },
    hostDomain: { type: 'string', required: true, description: '主机域名' },
    nics: {
      type: 'array',
      required: false,
      description: '网卡 IP 入口（1:N；单对简写 internalIp/publicIp）',
      items: {
        type: 'object',
        properties: {
          internalIp: { type: 'string' },
          publicIp: { type: 'string' },
          ownerId: { type: 'string' },
        },
      },
    },
    internalIp: { type: 'string', required: false, description: '单网卡 IP 简写' },
    publicIp: { type: 'string', required: false, description: '单网卡公网 IP 简写' },
    tunnelPort: { type: 'integer', required: false, description: 'tunnel 端口' },
    httpPort: { type: 'integer', required: false, description: 'HTTP 入口端口' },
    httpsPort: { type: 'integer', required: false, description: 'HTTPS 入口端口' },
    managementPort: { type: 'integer', required: false, description: '管理端口' },
  },
  // POST /v1/servers/{serverId}/bind（T2 bind）
  // 来源：bindServerRequest 结构体（http/servers.go L34-44）
  bind: {
    currentState: { type: 'string', required: true, description: '当前状态' },
    serverSecret: { type: 'string', required: true, description: '绑定密钥（一次性明文下发）' },
    version: { type: 'string', required: true, description: '实例版本号' },
    ports: {
      type: 'object',
      required: true,
      description: '实例静态端口信息',
      properties: {
        tunnelPort: { type: 'integer' },
        httpPort: { type: 'integer' },
        httpsPort: { type: 'integer' },
        managementPort: { type: 'integer' },
      },
    },
  },
};

const HANDLER_RESPONSE_FIELDS = {
  // 来源：handleAddServer 写出字段（http/servers.go L86-95）
  register: {
    nextState: { type: 'string', required: true, description: '转移后状态（S1）' },
    effects: { type: 'array', required: false, description: '副作用描述' },
    serverId: { type: 'string', required: true, description: '系统生成的节点 ID' },
    ownerId: { type: 'string', required: true, description: '平台归属（owner_id）' },
    state: { type: 'string', required: true, description: '节点状态机状态' },
    name: { type: 'string', required: true, description: '节点名字' },
    hostDomain: { type: 'string', required: true, description: '主机域名' },
    serverSecret: { type: 'string', required: true, description: '一次性明文密钥（仅下发一次）' },
  },
  // 来源：handleServerBind 写出字段（http/servers.go L119-128）
  bind: {
    nextState: { type: 'string', required: true, description: '转移后状态（S2）' },
    effects: { type: 'array', required: false, description: '副作用描述' },
    serverId: { type: 'string', required: true, description: '节点 ID' },
    ownerId: { type: 'string', required: true, description: '平台归属' },
    state: { type: 'string', required: true, description: '节点状态机状态' },
    instanceToken: { type: 'string', required: true, description: '实例会话令牌（Bearer）' },
    certPem: { type: 'string', required: true, description: '证书池匹配证书（PEM）' },
    certKeyPem: { type: 'string', required: true, description: '证书私钥（PEM）' },
  },
};

// ----------------------------------------------------------------------------
// 渲染：YAML 形态 contracts[] 段（单层级 indent）
// ----------------------------------------------------------------------------

function renderSchema(fields) {
  const props = [];
  const required = [];
  for (const [name, def] of Object.entries(fields)) {
    if (def.required) required.push(name);
    props.push(renderField(name, def));
  }
  const requiredStr = required.length > 0
    ? `\n      required:\n${required.map((r) => `        - ${r}`).join('\n')}`
    : '';
  const propsStr = props.length > 0
    ? `\n      properties:\n${props.join('\n')}`
    : '';
  return `type: object${propsStr}${requiredStr}`;
}

function renderField(name, def) {
  if (def.type === 'array') {
    const itemsType = def.items?.type ?? 'string';
    const desc = def.description ? `\n          description: ${def.description}` : '';
    return `        ${name}:\n          type: array\n          items:\n            type: ${itemsType}${desc}`;
  }
  if (def.type === 'object' && def.properties) {
    const subProps = [];
    for (const [n, d] of Object.entries(def.properties)) {
      subProps.push(`            ${n}:\n              type: ${d.type}`);
    }
    const desc = def.description ? `\n          description: ${def.description}` : '';
    return `        ${name}:\n          type: object\n          properties:\n${subProps.join('\n')}${desc}`;
  }
  const desc = def.description ? `\n          description: ${def.description}` : '';
  return `        ${name}:\n          type: ${def.type}${desc}`;
}

function renderContract(interfaceName, reqFields, respFields) {
  return [
    `  - interface: ${interfaceName}`,
    `    requestSchema:`,
    `      ${renderSchema(reqFields)}`,
    `    responseSchema:`,
    `      ${renderSchema(respFields)}`,
    `    preconditions:`,
    `      - "name 非空"`,
    `      - "hostDomain 合法"`,
    `    postconditions:`,
    `      - "${interfaceName} 转移完成"`,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// 主输出
// ----------------------------------------------------------------------------

function main() {
  console.log('# 自动生成 - E2.1 契约层 contracts[] 注入草稿（hsk-ng P1）');
  console.log('#');
  console.log('# 数据源：');
  console.log('#   - http/servers.go handleAddServer / handleServerBind');
  console.log('#   - storage/store.go Server / ServerNIC');
  console.log('#   - forwardserver/service.go AddInput / BindInput');
  console.log('#');
  console.log('# 命名归一化：Go struct 字段已与 http handler json tag 对齐（camelCase）');
  console.log('# 此段为「权威源候选」，需人工复核后填入 model.md（走修改单流程）');
  console.log('#');
  console.log('contracts:');
  console.log(renderContract('register', HANDLER_REQUEST_FIELDS.register, HANDLER_RESPONSE_FIELDS.register));
  console.log('');
  console.log(renderContract('bind', HANDLER_REQUEST_FIELDS.bind, HANDLER_RESPONSE_FIELDS.bind));
}

main();
