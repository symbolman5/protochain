/**
 * 状态机分解：把协议状态空间划分为主状态机 + 附属实体子状态机 + 孤儿组件。
 *
 * 背景：多实体协议（聚合实体 + 附属实体）会在同一 model.md 声明多个状态机，
 * 如 P7 的 US 聚合态 / PS 行生命周期 / PI 配件维度、P1 的 Mapping / TempMapping(SE1)。
 * 各子状态机有独立的入口（initial 类型状态，或 from='-' 的创建转移目标），
 * 相互之间按设计隔离（无跨机转移）。reason/check 阶段必须按状态机隔离判定，
 * 不能把子状态机的状态误判为主状态机的"不可达"。
 *
 * 约定：
 * - 创建转移：from 为 ['-'] 或空（空态创建，如 P1 T1/T7、P5 等）——不参与连通，
 *   其目标状态作为所在分量的入口。
 * - 主状态机：包含协议初始状态（derivable.initialStateId）的连通分量。
 * - 子状态机：非主分量且存在入口（initial 或创建转移目标）。
 * - 孤儿组件：无入口的非主分量（既无 initial 也无创建转移目标）——建模错误，
 *   由调用方并入主分析集合参与不可达判定。
 */

import type { StateDef, TransitionDef } from './types.js';

export interface StateMachine {
  /** 机器编号（comp-<idx>） */
  id: string;
  /** 机器名（附属实体可后续补充 label） */
  label: string;
  states: StateDef[];
  transitions: TransitionDef[];
  /** 入口状态 ID（initial 类型 + 创建转移 '-' 目标） */
  entryStateIds: string[];
  terminalStateIds: string[];
}

export interface DecomposedMachines {
  /** 主状态机（无初始状态时为 null，调用方按既有"无初始状态"逻辑失败） */
  main: StateMachine | null;
  /** 附属实体子状态机（有入口的非主分量） */
  subMachines: StateMachine[];
  /** 孤儿组件（无入口的非主分量，建模错误） */
  orphanComponents: StateMachine[];
}

/** 创建转移：from 为空态（'-' 或空），表示从外部创建实体 */
export function isCreationTransition(t: TransitionDef): boolean {
  return (
    t.from.length === 0 ||
    (t.from.length === 1 && (t.from[0] === '-' || t.from[0] === ''))
  );
}

export function decomposeStateMachines(
  states: StateDef[],
  transitions: TransitionDef[],
  initialStateId?: string
): DecomposedMachines {
  if (!initialStateId) {
    return { main: null, subMachines: [], orphanComponents: [] };
  }

  // 弱连通分量：状态为节点，转移连接 from（排除 '-'/空）与 to（无向）
  const adj = new Map<string, Set<string>>();
  for (const s of states) adj.set(s.id, new Set());
  for (const t of transitions) {
    const nodes = t.from.filter((f) => f !== '-' && f !== '').concat(t.to);
    for (const n of nodes) {
      if (!adj.has(n)) adj.set(n, new Set());
    }
    for (const a of nodes) {
      for (const b of nodes) {
        if (a !== b) {
          adj.get(a)!.add(b);
          adj.get(b)!.add(a);
        }
      }
    }
  }

  const compOf = new Map<string, number>();
  const components: string[][] = [];
  for (const s of states) {
    if (compOf.has(s.id)) continue;
    const idx = components.length;
    const comp: string[] = [];
    const queue = [s.id];
    compOf.set(s.id, idx);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!compOf.has(nb)) {
          compOf.set(nb, idx);
          queue.push(nb);
        }
      }
    }
    components.push(comp);
  }

  const byId = new Map(states.map((s) => [s.id, s]));
  const machines: StateMachine[] = components.map((ids, idx) => {
    const idSet = new Set(ids);
    const entry = new Set<string>();
    for (const id of ids) {
      if (byId.get(id)?.type === 'initial') entry.add(id);
    }
    for (const t of transitions) {
      if (isCreationTransition(t) && idSet.has(t.to)) entry.add(t.to);
    }
    return {
      id: `comp-${idx}`,
      label: '',
      states: ids.map((id) => byId.get(id)!).filter(Boolean),
      transitions: transitions.filter((t) => {
        // 创建转移归属其目标所在分量；普通转移要求 from/to 都在本分量
        if (isCreationTransition(t)) return idSet.has(t.to);
        return idSet.has(t.to) && t.from.every((f) => idSet.has(f));
      }),
      entryStateIds: [...entry],
      terminalStateIds: ids.filter((id) => byId.get(id)?.type === 'terminal'),
    };
  });

  const mainIdx = machines.findIndex((m) =>
    m.states.some((s) => s.id === initialStateId)
  );
  const main = mainIdx >= 0 ? machines[mainIdx] : null;
  const rest = machines.filter((_, i) => i !== mainIdx);
  return {
    main,
    subMachines: rest.filter((m) => m.entryStateIds.length > 0),
    orphanComponents: rest.filter((m) => m.entryStateIds.length === 0),
  };
}
