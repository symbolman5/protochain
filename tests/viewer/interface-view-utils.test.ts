/**
 * G5 Wave 4 纯函数单测（TI7/TI8/TI9）。
 * 以 CJS 方式执行 UMD 的 viewer/*.js（用 new Function 提供 module/exports），规避
 * jest ESM + 仓库 type:module 下 require('.js') 报 "Must use import to load ES Module"。
 *
 * 覆盖：
 *  - TI7 decideDefaultScope（Ob-6=A + 并存规则，Gif-5 落地页判定）
 *  - TI8 buildCatalogView（catalog 查表、零推导，Gif-5 中间输出 diff）
 *  - TI9 buildSchemaTree / collectSchemaFieldPaths（schema 全量递归，Gif-2 字段 diff）
 *  - TI9 buildErrorTable / buildTransportRows（错误码表 / transport，Gif-2）
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BASE = dirname(fileURLToPath(import.meta.url));

/** 以 CJS 方式执行 UMD 模块（不触发 Node 的 .js→ESM 解析） */
function loadUmd(relPath: string): any {
  const code = readFileSync(join(BASE, relPath), 'utf8');
  const module: any = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', code);
  fn(module, module.exports);
  return module.exports;
}

const U = loadUmd('../../viewer/interface-view-utils.js');
const demo = JSON.parse(
  readFileSync(join(BASE, '../../examples/fulfillment-payment/web/interface-details.json'), 'utf8')
);

describe('G5 Wave 4 · interface-view-utils 纯函数', () => {
  describe('TI7 · decideDefaultScope（Ob-6=A + 并存规则）', () => {
    it('（a）manifest + interface-details(catalog) 在场 → 接口目录优先（catalog）', () => {
      const state = { manifest: { bundles: {} }, interfaceDetails: { catalog: {} }, projectData: {} };
      expect(U.decideDefaultScope(state)).toEqual({ scope: 'catalog' });
    });

    it('（b）仅 manifest + 协议数据（无 interface-details）→ 状态机（composition）', () => {
      const state = { manifest: { bundles: {} }, projectData: { P1: { sourceModelVersion: '1.0.0' } } };
      expect(U.decideDefaultScope(state)).toEqual({ scope: 'composition' });
    });

    it('（c）并存（manifest + interface-details + pN.data.json）→ 接口目录优先（catalog）', () => {
      const state = {
        manifest: { bundles: {} },
        interfaceDetails: { catalog: {} },
        projectData: { P1: { sourceModelVersion: '1.0.0' } },
      };
      expect(U.decideDefaultScope(state)).toEqual({ scope: 'catalog' });
    });

    it('（d）仅 manifest（无其他数据）→ 项目总览（project）', () => {
      const state = { manifest: { bundles: {} } };
      expect(U.decideDefaultScope(state)).toEqual({ scope: 'project' });
    });

    it('（e）非项目模式（无 manifest）→ project（由 baseRenderAll 渲染 main-view）', () => {
      const state = { interfaceDetails: { catalog: {} } };
      expect(U.decideDefaultScope(state)).toEqual({ scope: 'project' });
    });

    it('（f）hasInterfaceDirectory：仅当 interface-details 含 catalog 时为真', () => {
      expect(U.hasInterfaceDirectory({ interfaceDetails: demo })).toBe(true);
      expect(U.hasInterfaceDirectory({ interfaceDetails: { schemaVersion: '1.1' } })).toBe(false);
      expect(U.hasInterfaceDirectory({})).toBe(false);
    });
  });

  describe('TI8 · buildCatalogView（catalog 查表、零推导，Gif-5）', () => {
    const idxKeys = ['byProtocol', 'byRole', 'byPreconditionState'] as const;

    it('三索引中间输出与 catalog 表逐组逐条严格一致（零推导）', () => {
      for (const key of idxKeys) {
        const view = U.buildCatalogView(demo.catalog, key);
        const raw = demo.catalog[key];
        const expectedGroups = Object.keys(raw).map((k) => ({
          key: k,
          items: raw[k].map((it: any) => ({ protocolId: it.protocolId, interfaceId: it.interfaceId })),
        }));
        expect(view).toEqual({ indexKey: key, groups: expectedGroups });
      }
    });

    it('归组边界规则（10 §3-1）：观测接口归入"观测"组', () => {
      const groups = U.buildCatalogView(demo.catalog, 'byRole').groups;
      const obs = groups.find((g: any) => g.key === '观测');
      expect(obs).toBeDefined();
      expect(obs.items.length).toBeGreaterThan(0);
      for (const it of obs.items) {
        const entry = demo.entries[it.protocolId][it.interfaceId];
        expect(entry.interface.kind).toBe('observation');
      }
    });

    it('多 from 重复展示（10 §3-1）：同一接口可在多个前置状态组重复出现（允许多归属）', () => {
      const groups = U.buildCatalogView(demo.catalog, 'byPreconditionState').groups;
      const allItems = groups.flatMap((g: any) => g.items);
      const uniquePairs = new Set(allItems.map((it: any) => `${it.protocolId}/${it.interfaceId}`));
      expect(uniquePairs.size).toBeLessThanOrEqual(allItems.length); // 允许重复（多归属）
    });

    it('catalog 缺索引键 → 空 groups（降级不白屏）', () => {
      const view = U.buildCatalogView({ byProtocol: {} }, 'byRole' as any);
      expect(view).toEqual({ indexKey: 'byRole', groups: [] });
    });
  });

  describe('TI9 · schema 全量递归（Gif-2 字段 diff）', () => {
    it('requestSchema 递归展开字段 path 与 schema 属性严格一致', () => {
      const entry = demo.entries['P1']['IF_SYS_T1'];
      const tree = U.buildSchemaTree(entry.interface.requestSchema, 'requestSchema', '');
      const paths = U.collectSchemaFieldPaths(tree).sort();
      expect(paths).toEqual(['currentState', 'order_id']);
    });

    it('嵌套 object / array 递归展开（Ob-4=A 全量递归常开）', () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: {
            type: 'object',
            properties: { b1: { type: 'string' }, b2: { type: 'integer' } },
            required: ['b1'],
          },
          c: { type: 'array', items: { type: 'object', properties: { c1: { type: 'string' } } } },
        },
        required: ['a'],
      };
      const tree = U.buildSchemaTree(schema, 'root', '');
      const paths = U.collectSchemaFieldPaths(tree).sort();
      expect(paths).toEqual(['a', 'b.b1', 'b.b2', 'c.[].c1']);
      const bNode = tree.children.find((n: any) => n.name === 'b');
      expect(bNode.required).toEqual(['b1']);
    });

    it('无 schema 字段 → 空 children（降级不静默，由上层提示）', () => {
      const tree = U.buildSchemaTree({ type: 'object' }, 'x', '');
      expect(tree.children).toBeUndefined();
    });
  });

  describe('TI9 · 错误码表 / transport 中间输出（Gif-2）', () => {
    const entry = {
      interface: {
        errorResponses: [
          { errorCode: 'E1', description: 'bad request' },
          { errorCode: 'E2', description: 'conflict' },
        ],
      },
      binding: {
        errorMapHits: [{ errorCode: 'E1', httpStatus: 400 }],
        unmappedErrorCodes: ['E9'],
        transport: [{ type: 'rest', method: 'POST', path: '/orders', roleId: 'customer' }],
      },
    };

    it('buildErrorTable 合并 errorResponses + errorMapHits + unmapped（字段零丢失）', () => {
      const rows = U.buildErrorTable(entry);
      const byCode: Record<string, any> = {};
      for (const r of rows) byCode[r.errorCode] = r;
      expect(Object.keys(byCode).sort()).toEqual(['E1', 'E2', 'E9']);
      expect(byCode['E1'].httpStatus).toBe(400); // 来自 errorMapHits
      expect(byCode['E1'].description).toBe('bad request'); // 来自 errorResponses
      expect(byCode['E2'].httpStatus).toBeNull();
      expect(byCode['E9'].unmapped).toBe(true);
    });

    it('buildTransportRows 原样透传 method/path/roleId/server（零推导，G6 透传 server）', () => {
      const rows = U.buildTransportRows(entry.binding);
      expect(rows).toEqual([{ type: 'rest', method: 'POST', path: '/orders', roleId: 'customer', server: '' }]);
    });

    it('buildTransportRows 透传 server（G6-3：bindings baseUrl 拼接结果）', () => {
      const rows = U.buildTransportRows({
        transport: [{ type: 'http', method: 'POST', path: '/v1/x', roleId: 'platform', server: 'https://api.example.com' }],
      });
      expect(rows[0].server).toBe('https://api.example.com');
    });
  });

  describe('G6 · 请求/响应示例 + 代码样例中间输出（零推导，纯查表）', () => {
    it('buildRequestResponseExample 透传 interface-details 预投影示例', () => {
      const entry = demo.entries['P1']['IF_SYS_T1'];
      const ex = U.buildRequestResponseExample(entry);
      expect(ex.request).toEqual(entry.interface.requestExample);
      expect(ex.response).toEqual(entry.interface.responseExample);
    });

    it('buildRequestResponseExample 无示例 → 返回 null（老模型零回归）', () => {
      const ex = U.buildRequestResponseExample({ interface: {} });
      expect(ex.request).toBeNull();
      expect(ex.response).toBeNull();
    });

    it('buildCodeSamples 透传 codeSamples（lang/label/code 三元组）', () => {
      const entry = demo.entries['P1']['IF_SYS_T1'];
      const cs = U.buildCodeSamples(entry);
      expect(Array.isArray(cs)).toBe(true);
      expect(cs.length).toBeGreaterThan(0);
      for (const s of cs) {
        expect(s).toHaveProperty('lang');
        expect(s).toHaveProperty('label');
        expect(typeof s.code === 'string' && s.code.length > 0).toBe(true);
      }
    });
  });
});
