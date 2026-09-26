'use strict';

/**
 * 通道增设建议（按需试算，纯函数，**不写库、不改任何通道**）。
 *
 * 背景：换景通道规划（routing.js）对每条**重放生效**提示逐组联合搜索
 * 互不共边的简单路径组合，遇到端点不连通 / 通道争用时整组无解。本模块
 * 回答舞台监督的问题：**在现有区位之间补建至多两条无向通道**，能不能让
 * 全部生效提示都取得互不共边的线路？
 *
 * 搜索规则（严格按需求）：
 *  - 候选只取**现有区位之间尚未连接**的无向区位对（自环、已连通的对都
 *    不纳入），端点按名称排序，故每对有唯一的规范表示；
 *  - 按新增条数由少到多试算：先枚举 1 条新增，再枚举 2 条新增的全部
 *    组合，命中第一个「全部生效提示均可排开」的方案即返回——所以 1 条
 *    能解决时绝不会返回 2 条方案；
 *  - 同条数存在多解时，按新增通道端点名称排序选择首组：候选对先按
 *    （a, b）字典序排列，2 条组合按（第一对、第二对）字典序枚举；
 *  - 每组试算只重新规划**修复前原本无解**的生效提示（原来可行的组
 *    不会因新增边变坏：加边只会增加可选路径），并**复用 routing.js 的
 *    整组联合路径求解**（planCueBasic：简单路径枚举 + MRV 回溯）；
 *  - 命中方案后再对全部生效提示做一次带争用诊断的完整重算，得到
 *    「修复后完整线路」。
 *
 * 规模保护（不宣称最优或无解的情形）：
 *  - PATH_CAP：任一必要试算中某条转移的简单路径枚举超过上限时，该次
 *    建议计算标记 limited（reason: 'path_cap'）、未计算，既不宣称无解
 *    也不宣称最优——因为后续候选还没试完；
 *  - TRIAL_CAP：试算（候选方案 × 原无解组）组数超过上限时标记 limited
 *    （reason: 'trial_cap'）、未计算。
 *
 * @module passage-advice
 */

const {
  computeRouting,
  planCue,
  planCueBasic,
  buildGraph,
  edgeKey,
} = require('./routing');

/** 试算组数上限（候选方案 × 修复前无解组数，防御异常规模输入） */
const TRIAL_CAP = 20000;

/** 最多建议增设的通道条数（需求限定：至多两条） */
const MAX_NEW_EDGES = 2;

/** 候选区位对规范化（端点按名称排序，禁止自环），与通道落库口径一致 */
function sortPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

/**
 * 全部「现有区位间尚未连接」的无向区位对，按端点名称字典序排列。
 *
 * @param {string[]} locationNames 区位名称（含孤立区位）
 * @param {Set<string>} existingKeys 现有通道的规范化 edgeKey 集合
 * @returns {Array<{a:string, b:string, key:string}>}
 */
function candidatePairs(locationNames, existingKeys) {
  const names = [...locationNames].sort();
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = sortPair(names[i], names[j]); // names 已排序，实际恒为 names[i/j]
      const key = edgeKey(a, b);
      if (!existingKeys.has(key)) pairs.push({ a, b, key });
    }
  }
  return pairs;
}

/** 在现有通道上追加若干候选对，构建试算用邻接表（调用方保证不与现边重复） */
function graphWith(passages, edges) {
  const adj = buildGraph(passages.concat(edges.map((e) => ({ loc_a: e.a, loc_b: e.b }))));
  for (const [, list] of adj) list.sort(); // buildGraph 已排序，这里显式保证试算确定
  return adj;
}

function ensureAllNodes(adj, locationNames) {
  for (const name of locationNames) if (!adj.has(name)) adj.set(name, []);
}

/**
 * 通道增设建议主入口（纯函数）。
 *
 * @param {Array<{name:string}>} locations 全部区位（含无通道的孤立区位）
 * @param {Array<{loc_a:string, loc_b:string}>} passages 现有无向通道
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @returns {Object} 建议结果，status 取值：
 *   - 'empty'：没有生效提示，无需建议；
 *   - 'already_feasible'：现有通道下全部生效提示已可排开，无需增设；
 *   - 'found'：找到方案，additions 为建议通道（1 或 2 条），before/after
 *     给出修复前原无解组与修复后全部生效提示的完整线路；
 *   - 'not_found'：在「至多两条、现有区位间尚未连接的区位对」范围内
 *     全部试完仍无解，scope 明确说明搜索范围与已试组数；
 *   - 'limited'：任一必要试算遇路径规模上限或试算组数上限，未计算
 *     （reason: 'path_cap' | 'trial_cap'），不宣称最优或无解。
 */
function computePassageAdvice(locations, passages, cues, results) {
  const locationNames = locations.map((l) => l.name);
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const effectiveCues = cues.filter((c) => {
    const r = resultByNumber.get(c.number);
    return r && r.ok;
  });
  const skippedCueCount = cues.length - effectiveCues.length;

  if (effectiveCues.length === 0) {
    return {
      status: 'empty',
      additions: [],
      before: [],
      after: null,
      scope: {
        maxNewEdges: MAX_NEW_EDGES,
        candidatePairs: 0,
        oneEdgeCandidates: 0,
        twoEdgeCandidates: 0,
        trials: 0,
      },
      limited: null,
      effectiveCueCount: 0,
      skippedCueCount: cues.length,
    };
  }

  // 现有通道下的完整规划（修复前状态；before 直接取其中的无解组）
  const baseline = computeRouting(locations, passages, cues, results);
  const existingKeys = new Set(passages.map((p) => edgeKey(p.loc_a, p.loc_b)));
  const candidates = candidatePairs(locationNames, existingKeys);
  const oneEdgeCount = candidates.length;
  const twoEdgeCount = (candidates.length * (candidates.length - 1)) / 2;

  const scope = {
    maxNewEdges: MAX_NEW_EDGES,
    candidatePairs: candidates.length,
    oneEdgeCandidates: oneEdgeCount,
    twoEdgeCandidates: twoEdgeCount,
    trials: 0,
  };

  const problemGroups = baseline.groups.filter((g) => g.status !== 'ok');
  const problemCues = effectiveCues.filter((c) =>
    problemGroups.some((g) => g.number === c.number)
  );
  const before = baseline.groups.filter((g) => g.status !== 'ok');

  // 现有通道已全部可排：无需增设
  if (problemCues.length === 0) {
    return {
      status: 'already_feasible',
      additions: [],
      before: [],
      after: null,
      scope,
      limited: null,
      effectiveCueCount: effectiveCues.length,
      skippedCueCount,
    };
  }

  // 修复前规划本身就有组遇到路径枚举上限：基线未计算，无法据其搜索
  const baseLimited = problemGroups.find((g) => g.status === 'limited');
  if (baseLimited) {
    return {
      status: 'limited',
      additions: [],
      before,
      after: null,
      scope,
      limited: {
        reason: 'path_cap',
        phase: 'baseline',
        message: baseLimited.limited
          ? baseLimited.limited.message
          : '现有通道规划的简单路径枚举量超过上限，本组未计算，无法进行通道增设试算',
        cue: baseLimited.number,
        cap: baseLimited.limited ? baseLimited.limited.cap : null,
      },
      effectiveCueCount: effectiveCues.length,
      skippedCueCount,
    };
  }

  let trials = 0;

  /**
   * 对一个候选方案（1～2 条新增边）试算：只重规划修复前无解的生效提示。
   * 任一重规划组遇到路径枚举上限即抛出 RoutingLimitError；
   * 全部转为 ok 才算该方案可行。
   */
  function trialEdges(edges) {
    const adj = graphWith(passages, edges);
    ensureAllNodes(adj, locationNames);
    for (const cue of problemCues) {
      const g = planCueBasic(cue, adj);
      if (g.status === 'limited') {
        const err = new Error(g.limited ? g.limited.message : '路径规模超限，未计算');
        err.cue = cue.number;
        err.cap = g.limited ? g.limited.cap : null;
        err.from = g.limited ? g.limited.from : null;
        err.to = g.limited ? g.limited.to : null;
        throw err;
      }
      if (g.status !== 'ok') return false;
    }
    return true;
  }

  /** 试算预算：每个候选方案对每个原无解组各做一次重规划 */
  function consumeTrial() {
    trials += problemCues.length;
    if (trials > TRIAL_CAP) return false;
    return true;
  }

  /**
   * 命中方案后的收尾：对全部生效提示做一次带争用诊断的完整重算
   * （复用现有整组联合求解），确认修复后线路并给页面展示。
   */
  function finishFound(edges) {
    scope.trials = trials;
    const adj = graphWith(passages, edges);
    ensureAllNodes(adj, locationNames);
    const afterGroups = effectiveCues.map((cue) => planCue(cue, adj));
    // 防御：命中后的完整重算若遇路径上限，仍不得宣称得到方案
    const hitLimited = afterGroups.find((g) => g.status === 'limited');
    if (hitLimited) {
      return {
        status: 'limited',
        additions: [],
        before,
        after: null,
        scope,
        limited: {
          reason: 'path_cap',
          phase: 'verify',
          message: hitLimited.limited
            ? hitLimited.limited.message
            : '修复后完整线路重算时简单路径枚举量超过上限，未计算',
          cue: hitLimited.number,
          cap: hitLimited.limited ? hitLimited.limited.cap : null,
        },
        effectiveCueCount: effectiveCues.length,
        skippedCueCount,
      };
    }
    return {
      status: 'found',
      additions: edges.map((e) => ({ a: e.a, b: e.b })),
      before,
      after: afterGroups,
      scope,
      limited: null,
      effectiveCueCount: effectiveCues.length,
      skippedCueCount,
    };
  }

  /** 任一必要试算遇路径规模上限：未计算，不宣称最优或无解 */
  function limitedByPath(err, phase, edges) {
    scope.trials = trials;
    const edgeText = edges.map((e) => `「${e.a} — ${e.b}」`).join('、');
    return {
      status: 'limited',
      additions: [],
      before,
      after: null,
      scope,
      limited: {
        reason: 'path_cap',
        phase,
        message:
          `试算新增通道 ${edgeText} 时，提示 ${err.cue} 的简单路径枚举量超过上限` +
          `（${err.from ? `「${err.from}」→「${err.to}」` : ''}，上限 ${err.cap}），本次通道增设建议未计算——` +
          '后续候选方案尚未试完，不能据此宣称无解或最优。',
        cue: err.cue,
        cap: err.cap,
        trialEdges: edges.map((e) => ({ a: e.a, b: e.b })),
      },
      effectiveCueCount: effectiveCues.length,
      skippedCueCount,
    };
  }

  try {
    // 1) 先试 1 条新增（候选按端点名称字典序，命中即首组）
    for (const e1 of candidates) {
      if (!consumeTrial()) {
        scope.trials = trials;
        return {
          status: 'limited',
          additions: [],
          before,
          after: null,
          scope,
          limited: {
            reason: 'trial_cap',
            phase: 'one-edge',
            message:
              `通道增设试算组数超过上限（已试 ${trials} 组 × ${problemCues.length} 个原无解提示，` +
              `上限 ${TRIAL_CAP} 组），1 条新增的候选尚未全部试完，本次建议未计算，不能宣称无解或最优。`,
            cap: TRIAL_CAP,
          },
          effectiveCueCount: effectiveCues.length,
          skippedCueCount,
        };
      }
      try {
        if (trialEdges([e1])) return finishFound([e1]);
      } catch (err) {
        return limitedByPath(err, 'trial', [e1]);
      }
    }

    // 2) 再试 2 条新增的全部组合（按两对端点名称字典序枚举，命中即首组）
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const edges = [candidates[i], candidates[j]];
        if (!consumeTrial()) {
          scope.trials = trials;
          return {
            status: 'limited',
            additions: [],
            before,
            after: null,
            scope,
            limited: {
              reason: 'trial_cap',
              phase: 'two-edge',
              message:
                `通道增设试算组数超过上限（已试 ${trials} 组 × ${problemCues.length} 个原无解提示，` +
                `上限 ${TRIAL_CAP} 组），2 条新增的组合尚未全部试完，本次建议未计算，不能宣称无解或最优。`,
              cap: TRIAL_CAP,
            },
            effectiveCueCount: effectiveCues.length,
            skippedCueCount,
          };
        }
        try {
          if (trialEdges(edges)) return finishFound(edges);
        } catch (err) {
          return limitedByPath(err, 'trial', edges);
        }
      }
    }
  } catch (err) {
    return limitedByPath(err, 'trial', []);
  }

  // 3) 两条以内全部候选试完仍无解：明确说明搜索范围
  scope.trials = trials;
  return {
    status: 'not_found',
    additions: [],
    before,
    after: null,
    scope,
    limited: null,
    effectiveCueCount: effectiveCues.length,
    skippedCueCount,
  };
}

module.exports = {
  computePassageAdvice,
  candidatePairs,
  TRIAL_CAP,
  MAX_NEW_EDGES,
};
