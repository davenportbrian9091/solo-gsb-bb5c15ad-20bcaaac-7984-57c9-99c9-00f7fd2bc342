'use strict';

/**
 * 换景通道规划（逐提示边不相交路径联合求解）。
 *
 * 区位之间可由页面维护**无向通道**；对每条「全量重放整组生效」的提示，
 * 组内每件道具的转移（来源区位 → 目标区位）都要在通道图上选择一条
 * **简单路径**（不重复经过同一区位），且同组**任意两条路径不得共用通道**
 * （无向边：同一条通道两个方向都算占用；路径在中间区位相遇不冲突，
 * 只有共用通道才算冲突）。
 *
 * 关键要求：必须**联合搜索**可行组合，不能逐条固定最短路——逐条取最短
 * 可能占掉后一条转移的唯一桥梁，而让前一条改走稍长的绕行路径后整组
 * 其实可解。本模块的做法：
 *  1. 对每条转移用 DFS 枚举**全部**简单路径，再按（长度、区位序列
 *     字典序）排序——最短路在前，故联合求解命中的第一个解优先采用
 *     较短路径，结果确定；
 *  2. 用 MRV 顺序（候选路径最少的转移先选）做带约束传播的回溯搜索，
 *     逐条选路径并剔除与已选路径共边的候选，任一转移候选被掏空即回溯，
 *     允许回头调整前序转移的选择；
 *  3. 无解时区分两类原因：
 *     - disconnected（端点不连通）：某条转移的两个端区位在通道图上
 *       根本不在同一连通分量（BFS 不可达），与其他转移如何选路无关；
 *     - contention（通道争用）：每条转移的端点各自可达，但不存在一组
 *       两两不共边的路径；附「争用簇」诊断——把转移按**极小不可行
 *       子集**（自身不可行、删掉其中任意一条转移后即可联合排开）分簇，
 *       每簇列出卷入争用的转移，帮助舞台监督判断该在哪补通道。
 *
 * 规模说明：舞台通道图规模很小（个位/十位区位与通道数），简单路径
 * 枚举与回溯均为毫秒级；为防御异常数据，设有两条上限：
 *  - PATH_CAP：单条转移参与联合搜索的简单路径条数上限；
 *  - DIAG_CAP：争用诊断枚举转移子集的数量上限。
 * 超限分别以 status 'limited' / diagnosisTruncated 标注，而非超时。
 */

/** 单条转移参与联合搜索的简单路径条数上限（防御异常规模输入） */
const PATH_CAP = 10000;

/** 争用诊断枚举转移子集的数量上限（防御异常规模输入） */
const DIAG_CAP = 100000;

/** 争用诊断只在转移数不超过该值时枚举子集（2^16 = 65536 < DIAG_CAP） */
const DIAG_MAX_TRANSFERS = 16;

class RoutingLimitError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'RoutingLimitError';
    Object.assign(this, extra);
  }
}

/** 无向边的规范化键（字典序小的区位在前），两个方向产生同一个键 */
function edgeKey(a, b) {
  return a < b ? `${a}${b}` : `${b}${a}`;
}

/**
 * 由通道列表构建邻接表。通道为无向边，两端区位均会出现在图中
 * （没有任何通道的孤立区位以空邻接表表示）。
 *
 * @param {Array<{loc_a:string, loc_b:string}>} passages
 * @returns {Map<string, string[]>} 区位 -> 相邻区位（按名称排序，保证枚举确定）
 */
function buildGraph(passages) {
  const adj = new Map();
  const ensure = (name) => {
    if (!adj.has(name)) adj.set(name, []);
  };
  for (const p of passages) {
    ensure(p.loc_a);
    ensure(p.loc_b);
    adj.get(p.loc_a).push(p.loc_b);
    adj.get(p.loc_b).push(p.loc_a);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

/** 确保区位在邻接表中有节点（含孤立区位） */
function ensureNodes(adj, locations) {
  for (const name of locations) if (!adj.has(name)) adj.set(name, []);
}

/**
 * BFS 判断 start 在无向图上能否到达 target。
 * @returns {boolean}
 */
function reachable(adj, start, target) {
  if (!adj.has(start) || !adj.has(target)) return false;
  if (start === target) return true;
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of adj.get(queue[head])) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * 枚举 start → target 的全部简单路径（不重复经过同一区位）。
 *
 * 邻接表已按区位名称排序，一次 DFS 收集全部简单路径后，再按（边数、
 * 区位序列字典序）排序——**最短路径在前**，使联合搜索命中的第一个解
 * 优先采用较短路径，同长度时结果确定。路径总数超过 cap 时抛出
 * RoutingLimitError，已枚举出的路径不完整，调用方不得据此判定「无解」。
 *
 * @returns {Array<string[]>}
 */
function allSimplePaths(adj, start, target, cap) {
  if (!adj.has(start) || !adj.has(target)) return [];
  if (start === target) return [[start]];
  if (!reachable(adj, start, target)) return []; // 不连通（联合求解前还会先做 reachable 筛查）

  const paths = [];
  const path = [start];
  const onPath = new Set([start]);

  function dfs(u) {
    if (u === target) {
      paths.push(path.slice());
      if (paths.length > cap) {
        throw new RoutingLimitError(
          `「${start}」→「${target}」的简单路径枚举量超过上限（>${cap}），本组通道规划未计算`,
          { code: 'PATH_CAP', from: start, to: target, cap }
        );
      }
      return;
    }
    if (path.length - 1 >= adj.size - 1) return; // n 个节点的简单路径最多 n-1 条边
    for (const v of adj.get(u)) {
      if (onPath.has(v)) continue; // 简单路径：不重复经过同一区位
      path.push(v);
      onPath.add(v);
      dfs(v);
      path.pop();
      onPath.delete(v);
    }
  }

  dfs(start);

  // 最短优先：先按边数升序，再按区位序列的字典序（名称序），结果确定
  paths.sort((p, q) => {
    if (p.length !== q.length) return p.length - q.length;
    for (let i = 0; i < p.length; i++) {
      if (p[i] < q[i]) return -1;
      if (p[i] > q[i]) return 1;
    }
    return 0;
  });
  return paths;
}

/**
 * 一条路径占用的无向边键集合。
 * @param {string[]} path 区位序列
 * @returns {Set<string>}
 */
function pathEdges(path) {
  const edges = new Set();
  for (let i = 1; i < path.length; i++) edges.add(edgeKey(path[i - 1], path[i]));
  return edges;
}

/**
 * 联合搜索：为一组转移寻找两两不共边的简单路径组合。
 *
 * 候选路径已按（长度、字典序）升序排列；搜索按 MRV（当前可行候选数最少
 * 的转移优先）选下一条转移，每次只保留与全部已选路径不共边的候选——
 * 这是前向约束传播：某转移候选提前被掏空即可立即剪枝回溯，而不必等
 * 选到它时才发现冲突。首个成功组合为确定解（优先短路径）。
 *
 * @param {Array<string[]>[]} pathLists  pathLists[i] = 转移 i 的候选简单路径（已排序）
 * @returns {Array<string[]>|null} 每个转移一条路径；null = 候选范围内无可行组合
 */
function jointSearch(pathLists) {
  const n = pathLists.length;
  const chosen = new Array(n); // chosen[i] = 转移 i 选中的路径（null 未定）

  // 每条候选路径的边集只在入口计算一次；随后逐层只做「是否与已占边相交」判断
  const edgeLists = pathLists.map((list) => list.map((path) => ({ path, edges: pathEdges(path) })));

  // 已选路径对每条通道的占用次数。同组内两条已选路径不会共边（加入前已过滤），
  // 故占用计数恒为 0/1；用计数而非布尔，使回溯只需无脑 -1，不依赖加入顺序。
  const used = new Map();
  const isFree = (edges) => {
    for (const e of edges) if (used.has(e)) return false;
    return true;
  };
  const addEdges = (edges, delta) => {
    for (const e of edges) {
      const c = (used.get(e) || 0) + delta;
      if (c > 0) used.set(e, c);
      else used.delete(e); // 计数归 0 立即移除，保证 isFree 的 has 判断准确
    }
  };

  function search(remaining) {
    if (remaining.length === 0) return true;

    // MRV：在未分配的转移中挑当前可行候选最少的先定（并列取下标最小者，结果确定）
    let pickIdxInRemaining = -1;
    let feasibleChosen = null;
    let bestCount = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const i = remaining[k];
      const feasible = edgeLists[i].filter((cand) => isFree(cand.edges));
      if (feasible.length === 0) return false; // 前向检查：该转移已无通道可选，立即剪枝
      if (feasible.length < bestCount) {
        bestCount = feasible.length;
        pickIdxInRemaining = k;
        feasibleChosen = feasible;
      }
    }

    const i = remaining[pickIdxInRemaining];
    const rest = remaining.filter((_, k) => k !== pickIdxInRemaining);
    for (const cand of feasibleChosen) {
      chosen[i] = cand.path;
      addEdges(cand.edges, 1);
      if (search(rest)) return true;
      addEdges(cand.edges, -1);
      chosen[i] = null;
    }
    return false;
  }

  const order = [...Array(n).keys()];
  return search(order) ? chosen : null;
}

/** 枚举 0..n-1 中选 size 个下标的全部组合（字典序，升序） */
function indexCombinations(n, size) {
  const out = [];
  const combo = [];
  function visit(start) {
    const left = size - combo.length;
    if (left === 0) {
      out.push(combo.slice());
      return;
    }
    for (let i = start; i <= n - left; i++) {
      combo.push(i);
      visit(i + 1);
      combo.pop();
    }
  }
  visit(0);
  return out;
}

/**
 * 争用诊断：把转移按「极小不可行子集」分簇。
 *
 * 一个转移子集是极小不可行子集，当且仅当：
 *  - 该子集内的转移**无法**选出两两不共边的路径组合；且
 *  - 去掉其中任意一条转移后，剩下的转移**可以**联合排开。
 * 每条「卷入争用」的转移至少属于一个极小不可行子集；只属于可去掉而
 * 不影响可行性的转移不列为受影响（它们不是争用瓶颈的一部分）。
 *
 * 枚举按子集大小升序，命中的极小簇立即记录；任何包含已命中簇的更大
 * 子集不再是「极小」，直接跳过。检查数超过 DIAG_CAP（或转移数超过
 * DIAG_MAX_TRANSFERS）时 truncated = true，调用方退化为「全部转移受影响」。
 *
 * @param {Array<{prop:string, from:string, to:string}>} transfers
 * @param {Array<string[]>[]} pathLists 各转移候选简单路径
 * @returns {{clusters: Array<{transfers:Array<{index:number, prop:string, from:string, to:string}>}>},
 *   affected:number[], truncated:boolean}}
 */
function diagnoseContention(transfers, pathLists) {
  const n = transfers.length;

  if (n > DIAG_MAX_TRANSFERS) {
    return {
      clusters: [{ transfers: transfers.map((t, i) => ({ index: i, ...t })) }],
      affected: [...Array(n).keys()],
      truncated: true,
    };
  }

  // feasibility 缓存：位掩码 -> 该子集能否联合排开
  const cache = new Map();
  let checks = 0;
  let truncated = false;

  function feasible(mask) {
    if (cache.has(mask)) return cache.get(mask);
    checks += 1;
    if (checks > DIAG_CAP) {
      truncated = true;
      cache.set(mask, true); // 超限后停止诊断；具体取值不再被使用
      return true;
    }
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const ok = jointSearch(idx.map((i) => pathLists[i])) !== null;
    cache.set(mask, ok);
    return ok;
  }

  const fullMask = (1 << n) - 1;
  const minimalMasks = [];

  if (!truncated) {
    // 单元素子集必然可行（端点已确认可达，至少有一条路径），从大小 2 开始枚举
    for (let size = 2; size <= n && !truncated; size++) {
      for (const combo of indexCombinations(n, size)) {
        if (checks > DIAG_CAP) {
          truncated = true;
          break;
        }
        const mask = combo.reduce((m, i) => m | (1 << i), 0);
        // 包含任一已命中极小簇的更大子集不可能极小，跳过
        if (minimalMasks.some((cm) => (mask & cm) === cm)) continue;
        if (feasible(mask)) continue;
        // 极小性：删掉簇内任意一条转移后都可行
        let minimal = true;
        for (const i of combo) {
          if (!feasible(mask & ~(1 << i))) {
            minimal = false;
            break;
          }
        }
        if (minimal) minimalMasks.push(mask);
      }
    }
  }

  if (truncated) {
    return {
      clusters: [{ transfers: transfers.map((t, i) => ({ index: i, ...t })) }],
      affected: [...Array(n).keys()],
      truncated: true,
    };
  }

  // 理论上整组不可行（fullMask 不可行）时至少存在一个极小不可行子集；
  // 兜底：若未枚举出任何簇，把整组作为一簇。
  if (!minimalMasks.length) {
    return {
      clusters: [{ transfers: transfers.map((t, i) => ({ index: i, ...t })) }],
      affected: [...Array(n).keys()],
      truncated: false,
    };
  }

  minimalMasks.sort((a, b) => a - b);
  const affected = new Set();
  const clusters = minimalMasks.map((mask) => {
    const idxs = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        idxs.push(i);
        affected.add(i);
      }
    }
    return { transfers: idxs.map((i) => ({ index: i, ...transfers[i] })) };
  });

  return { clusters, affected: [...affected].sort((a, b) => a - b), truncated: false };
}

/**
 * 对单条（已生效）提示求解通道规划——基础求解，不做争用诊断。
 *
 * 返回状态 'ok' / 'disconnected' / 'limited' / 'contention'；为 'contention'
 * 时额外携带 pathLists（各转移的全部候选简单路径），供 planCue 继续做
 * 极小不可行子集诊断，或供通道增设试算直接复判，避免重复枚举。
 *
 * @param {{number:number, note:string, transfers:Array}} cue
 * @param {Map<string, string[]>} adj 通道邻接表
 * @returns {{number:number, note:string, status:'ok'|'disconnected'|'contention'|'limited',
 *   routes:Array<{prop, from, to, path:string[], edges:string[], hops:number}>,
 *   disconnected:Array<{index:number, prop:string, from:string, to:string}>,
 *   contention:null, pathLists?:Array<string[]>[],
 *   limited?:{message:string, code:string, from:string, to:string, cap:number}}}
 */
function planCueBasic(cue, adj) {
  const transfers = cue.transfers;
  const base = { number: cue.number, note: cue.note };

  // 1) 端点不连通筛查：与其他转移无关，BFS 不可达即整组无解
  const disconnected = [];
  transfers.forEach((t, i) => {
    if (!reachable(adj, t.from, t.to)) {
      disconnected.push({ index: i, prop: t.prop, from: t.from, to: t.to });
    }
  });
  if (disconnected.length) {
    return { ...base, status: 'disconnected', routes: [], disconnected, contention: null };
  }

  // 2) 枚举每条转移的全部简单路径（最短优先）；超路径上限标记 limited
  let pathLists;
  try {
    pathLists = transfers.map((t) => allSimplePaths(adj, t.from, t.to, PATH_CAP));
  } catch (err) {
    if (err instanceof RoutingLimitError) {
      return {
        ...base,
        status: 'limited',
        routes: [],
        disconnected: [],
        contention: null,
        limited: { message: err.message, code: err.code, from: err.from, to: err.to, cap: err.cap },
      };
    }
    throw err;
  }

  // 3) 联合搜索边不相交路径组合
  const chosen = jointSearch(pathLists);
  if (chosen) {
    return {
      ...base,
      status: 'ok',
      routes: transfers.map((t, i) => ({
        prop: t.prop,
        from: t.from,
        to: t.to,
        path: chosen[i],
        edges: [...pathEdges(chosen[i])],
        hops: chosen[i].length - 1,
      })),
      disconnected: [],
      contention: null,
    };
  }

  // 4) 各端点均可达但联合排不开：通道争用。候选路径一并返回，
  //    由 planCue 做极小不可行子集诊断（增设试算只关心是否转为可行，直接复用）。
  return { ...base, status: 'contention', routes: [], disconnected: [], contention: null, pathLists };
}

/**
 * 对单条（已生效）提示求解通道规划：在 planCueBasic 的基础上，对通道争用
 * 情形补做极小不可行子集（争用簇）诊断。字段结构见 planCueBasic。
 */
function planCue(cue, adj) {
  const basic = planCueBasic(cue, adj);
  if (basic.status !== 'contention') return basic;
  const diagnosis = diagnoseContention(cue.transfers, basic.pathLists);
  return {
    number: basic.number,
    note: basic.note,
    status: 'contention',
    routes: [],
    disconnected: [],
    contention: diagnosis,
  };
}

/**
 * 换景通道规划（纯函数）：对全部**整组生效**提示逐组求解通道线路，
 * 实时重算、不落地存储。失败（未生效）提示不参与规划，仅回显数量，
 * 因为整组根本不会执行，谈不上换景通道占用。
 *
 * @param {Array<{name:string}>} locations 全部区位（含无通道的孤立区位）
 * @param {Array<{loc_a:string, loc_b:string}>} passages 无向通道
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @returns {{status:'ok'|'empty'|'error', groups:Array, effectiveCueCount:number,
 *   skippedCueCount:number, summary:{total:number, ok:number, disconnected:number,
 *   contention:number, limited:number, affectedTransfers:number}}}
 */
function computeRouting(locations, passages, cues, results) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const adj = buildGraph(passages);
  ensureNodes(adj, locations.map((l) => l.name));

  const groups = [];
  let effectiveCount = 0;
  const summary = { total: 0, ok: 0, disconnected: 0, contention: 0, limited: 0, affectedTransfers: 0 };

  for (const cue of cues) {
    const r = resultByNumber.get(cue.number);
    if (!r || !r.ok) continue; // 失败提示不参与通道规划
    effectiveCount += 1;
    const group = planCue(cue, adj);
    groups.push(group);
    summary.total += 1;
    summary[group.status] += 1;
    if (group.status === 'disconnected') summary.affectedTransfers += group.disconnected.length;
    if (group.status === 'contention') summary.affectedTransfers += group.contention.affected.length;
  }

  if (effectiveCount === 0) {
    return { status: 'empty', groups, effectiveCueCount: 0, skippedCueCount: cues.length, summary };
  }

  const hasProblem = groups.some((g) => g.status !== 'ok');
  return {
    status: hasProblem ? 'error' : 'ok',
    groups,
    effectiveCueCount: effectiveCount,
    skippedCueCount: cues.length - effectiveCount,
    summary,
  };
}

module.exports = {
  computeRouting,
  planCue,
  planCueBasic,
  buildGraph,
  reachable,
  allSimplePaths,
  jointSearch,
  diagnoseContention,
  edgeKey,
  RoutingLimitError,
  PATH_CAP,
  DIAG_CAP,
};
