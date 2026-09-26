'use strict';

/**
 * 连场轮换排班（整场联合求解）。
 *
 * 与「逐提示岗位表」（assignment.js，每组独立求完整匹配）不同，本模块把
 * 整场所有**全量重放生效的提示**放在一起联合求解，在组内约束之外再叠加一条
 * 跨组约束：
 *
 *  - 仅纳入全量重放中**整组生效**的提示；失败（未生效）提示**不计轮次**，
 *    即不参与排班、也不隔开前后两条生效提示（……第 k 条生效提示的下一条
 *    生效提示就是第 k+1 条，中间夹着多少失败提示都不影响相邻判定）；
 *  - 每条转移仍须由**具备该道具搬运资格**的人员承担；
 *  - 同一人员在同一条提示内最多承担一个岗位（沿用二分图完整匹配约束）；
 *  - **同一人员不得出现在相邻两条生效提示中**（连场必须轮换）；
 *  - 排班对**整场联合求解**：后一条提示排不开时允许回头调整前序提示的
 *    合法分配——每组各自独立可行并不保证连起来可行（例如相邻两组的合格
 *    人员恰好是同一个人），只有对整条生效序列统一求一致分配才算数。
 *
 * 求解方法（精确枚举，非贪心）：
 *  跨组约束只作用于「相邻两组各自动用了哪些人」，与组内具体哪个人搬哪件
 *  道具无关。因此对每组先枚举出**所有互不相同的「动用人员集合」**——
 *  即存在一组完整匹配、且匹配恰好使用的人员子集（组内每条转移一岗，
 *  集合大小恒等于转移数）；再按生效序列做动态规划：
 *    dp[i] = 排完前 i 条生效提示后，第 i 条可能动用的全部人员集合；
 *    转移条件 = 本组动用集合与上一组动用集合互不相交（连场轮换）。
 *  某组之后 dp 为空，说明**不存在覆盖到该组的可行前缀**：该组即「首个
 *  无法形成可行前缀的提示」。由于求解的是整条序列的联合可行性，回溯
 *  恢复分配时会自然地回头调整前序提示的分配（同一前缀保留多个候选集合）。
 *
 * 规模说明：每组动用集合数最多为 C(|人员|, |转移数|)，dp 逐层只保留下一层
 *  可达集合，实际舞台规模（个位/十位人数与每组转移数）下为毫秒级；为防御
 *  异常输入导致的枚举膨胀，设有组合数上限（COMBO_CAP），超限返回
 *  状态 'limited' 而非超时。
 */

const { runMaxMatching } = require('./assignment');

/** 单组候选动用集合枚举的组合数上限（防御异常规模输入） */
const COMBO_CAP = 500000;

class RotationLimitError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'RotationLimitError';
    Object.assign(this, extra);
  }
}

/**
 * 枚举从 m 个元素中选 size 个的全部下标组合（按字典序，剪枝用）。
 * 组合总数超过 cap 时抛出 RotationLimitError。
 *
 * @returns {Array<number[]>} 每个元素是长度为 size 的升序下标数组
 */
function combinations(m, size, cap) {
  if (size < 0 || size > m) return [];
  const out = [];
  const combo = [];
  function visit(start) {
    const left = size - combo.length;
    if (left === 0) {
      out.push(combo.slice());
      if (out.length > cap) {
        throw new RotationLimitError(
          `单组可行动用集合枚举量超过上限（C(${m}, ${size}) > ${cap}），连场排班未计算`,
          { code: 'COMBO_CAP', staffCount: m, transferCount: size, cap }
        );
      }
      return;
    }
    for (let i = start; i <= m - left; i++) {
      combo.push(i);
      visit(i + 1);
      combo.pop();
    }
  }
  visit(0);
  return out;
}

/**
 * 求一条生效提示的全部「可行动用集合」。
 *
 * 对每个大小恰为转移数的人员子集，检查组内全部转移是否都能只在该子集内
 * 得到完整匹配（runMaxMatching）；通过则记录其位掩码（BigInt，第 j 位 =
 * 人员 j 被本组动用）与一组代表性岗位分配。不同匹配若动用同一人员集合，
 * 对相邻组的约束完全等价，只需保留一个。
 *
 * @param {Array<{prop:string, from:string, to:string}>} transfers 组内转移
 * @param {string[]} staffNames 全部人员（序号即位号）
 * @param {Map<string, Set<string>>} qualified 人员 -> 具备资格的道具集合
 * @param {bigint|null} [allowMask] 可选位掩码：仅第 j 位为 1 的人员允许被本组
 *   动用（临时缺席试排逐轮剔除缺席人员）；null 表示全部人员均可
 * @returns {{mask:bigint, positions:Array<{prop,from,to,staff}>}[]}
 *   按最低位掩码升序（= 按人员录入顺序的字典序），保证排班结果确定
 */
function feasibleUsedsets(transfers, staffNames, qualified, allowMask = null) {
  const size = transfers.length;
  // 只可能动用「至少与组内某条转移有资格关系」且本轮允许出场的人员
  const eligibleIdx = [];
  staffNames.forEach((name, j) => {
    const allowed = allowMask === null || (allowMask & (1n << BigInt(j))) !== 0n;
    if (allowed && transfers.some((t) => qualified.get(name).has(t.prop))) eligibleIdx.push(j);
  });

  const options = [];
  for (const idxCombo of combinations(eligibleIdx.length, size, COMBO_CAP)) {
    const subsetIdx = idxCombo.map((k) => eligibleIdx[k]);
    const subsetNames = subsetIdx.map((j) => staffNames[j]);
    // 该子集内每条转移的合格人员（保持人员录入顺序）
    const candidates = transfers.map((t) =>
      subsetNames.filter((name) => qualified.get(name).has(t.prop))
    );
    const { leftMatch } = runMaxMatching(candidates, subsetNames);
    if (leftMatch.every((j) => j !== null)) {
      let mask = 0n;
      for (const j of subsetIdx) mask |= 1n << BigInt(j);
      options.push({
        mask,
        positions: transfers.map((t, i) => ({
          prop: t.prop,
          from: t.from,
          to: t.to,
          staff: subsetNames[leftMatch[i]],
        })),
      });
    }
  }
  options.sort((a, b) => (a.mask < b.mask ? -1 : a.mask > b.mask ? 1 : 0));
  return options;
}

/**
 * 连场轮换求解核心（整场联合求解，纯函数）。
 *
 * 与 computeRotation 相同的组内 / 跨组约束，但允许逐轮指定「可出场人员掩码」
 * （allowMasks[i] = 第 i 条生效提示可动用的人员位掩码，null = 全部人员均可），
 * 供「临时缺席试排」把缺席人员逐轮剔除；缺席区间只作用于被覆盖的轮次，
 * 区间外轮次的可行动用集合不变。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} effective
 *   已按提示号升序的「参与轮次」提示（调用方负责剔除失败提示）
 * @param {string[]} staffNames 全部人员（序号即位号）
 * @param {Map<string, Set<string>>} qualified 人员 -> 具备资格的道具集合
 * @param {Array<bigint|null>|null} [allowMasks] 逐轮可出场人员掩码
 * @param {{skippedCueCount?:number}} [extra] 公共计数字段
 * @returns {Object}
 *   status 'ok'：{ rounds, roster }（rounds 每项带 usedStaff；roster 按全部人员）；
 *   status 'blocked'：{ block: {roundIndex, reason, soloFeasible,
 *     compatibleWithPrevious, transferCount} }（不含 rounds / roster；
 *     roundIndex 为生效序列内下标，由调用方映射为提示号）；
 *   status 'limited'：{ limited }（枚举超上限保护）；
 *   另含 effectiveCueNumbers / skippedCueCount / summary。
 */
function runRotation(effective, staffNames, qualified, allowMasks = null, extra = {}) {
  const skippedCueCount = extra.skippedCueCount || 0;
  const effectiveCueNumbers = effective.map((c) => c.number);
  const base = {
    effectiveCueNumbers,
    skippedCueCount,
    rounds: [],
    roster: [],
    block: null,
  };

  if (effective.length === 0) {
    return {
      ...base,
      status: 'empty',
      summary: { effectiveCues: 0, skippedCues: skippedCueCount, staff: staffNames.length, rounds: 0 },
    };
  }

  let perCue;
  try {
    perCue = effective.map((cue, i) =>
      feasibleUsedsets(cue.transfers, staffNames, qualified, allowMasks ? allowMasks[i] : null)
    );
  } catch (err) {
    if (err instanceof RotationLimitError) {
      return {
        ...base,
        status: 'limited',
        rounds: [],
        roster: [],
        limited: { message: err.message, code: err.code, staffCount: err.staffCount, transferCount: err.transferCount, cap: err.cap },
        summary: { effectiveCues: effective.length, skippedCues: skippedCueCount, staff: staffNames.length, rounds: 0 },
      };
    }
    throw err;
  }

  /**
   * 动态规划：layer[i] = 排完前 i+1 条生效提示后，第 i+1 条所有可能动用集合，
   * 每项保存 mask、代表性岗位表与回溯指针 prev（上一层选项在 layer[i-1] 中的下标）。
   * 相邻层转移条件：两层掩码按位与为 0n（连场两组无同一人员）。
   * 每组选项已按掩码升序，因此首个可行解即「尽量少动用录入靠后人员」的确定解。
   */
  const layers = [];

  // 第一条生效提示：无前序，任何可行动用集合都可作为前缀
  layers.push(perCue[0].map((opt) => ({ mask: opt.mask, option: opt, prev: -1 })));

  let blockIndex = -1;
  let blockReason = null;

  for (let i = 1; i < effective.length; i++) {
    const layer = [];
    const prevLayer = layers[i - 1];
    for (const opt of perCue[i]) {
      // 与上一组动用集合不相交（同一人员不得出现在相邻两条生效提示中）
      const prevIndex = prevLayer.findIndex((node) => (node.mask & opt.mask) === 0n);
      if (prevIndex !== -1) layer.push({ mask: opt.mask, option: opt, prev: prevIndex });
    }
    if (layer.length === 0) {
      blockIndex = i;
      // 区分：本组单独就无法整组覆盖（人手不足），还是单独可行但与任何可行前缀都连不上
      blockReason = perCue[i].length === 0 ? 'understaffed' : 'rotation';
      break;
    }
    layers.push(layer);
  }

  // 第一条生效提示本身就无法完整覆盖
  if (layers[0].length === 0) {
    blockIndex = 0;
    blockReason = 'understaffed';
  }

  if (blockIndex !== -1) {
    const cue = effective[blockIndex];
    return {
      ...base,
      status: 'blocked',
      rounds: [],
      roster: [],
      block: {
        // 轮次内下标；调用方按 effective[roundIndex] 映射为提示号
        roundIndex: blockIndex,
        reason: blockReason,
        transferCount: cue.transfers.length,
        soloFeasible: perCue[blockIndex].length, // 本组单独可行的动用集合数（0 = 人手不足）
        compatibleWithPrevious:
          blockIndex > 0
            ? perCue[blockIndex].filter((opt) =>
                layers[blockIndex - 1].some((node) => (node.mask & opt.mask) === 0n)
              ).length
            : null,
      },
      summary: {
        effectiveCues: effective.length,
        skippedCues: skippedCueCount,
        staff: staffNames.length,
        rounds: blockIndex, // 可行前缀覆盖的生效提示数
      },
    };
  }

  /* 全场可行：从末层沿回溯指针恢复整场分配（回溯会体现对前序合法分配的调整） */
  const chosenOptions = new Array(effective.length);
  let li = layers.length - 1;
  let nodeIndex = 0; // 每层按掩码升序，取最小者得到确定解
  while (li >= 0) {
    const node = layers[li][nodeIndex];
    chosenOptions[li] = node.option;
    nodeIndex = node.prev;
    li--;
  }

  const rounds = effective.map((cue, i) => ({
    number: cue.number,
    note: cue.note,
    round: i + 1, // 连场轮次（失败提示不计轮次）
    transferCount: cue.transfers.length,
    usedStaff: chosenOptions[i].positions.map((p) => p.staff),
    positions: chosenOptions[i].positions,
  }));

  // 整场人员安排：每名人员在哪些轮次出场（含岗位明细），供舞台监督通览
  const roster = staffNames.map((name) => {
    const appearances = [];
    for (const rnd of rounds) {
      const positions = rnd.positions.filter((p) => p.staff === name);
      if (positions.length) {
        appearances.push({
          round: rnd.round,
          cue: rnd.number,
          positions: positions.map((p) => ({ prop: p.prop, from: p.from, to: p.to })),
        });
      }
    }
    return {
      staff: name,
      cues: appearances.map((a) => a.cue),
      positionCount: appearances.reduce((sum, a) => sum + a.positions.length, 0),
      appearances,
    };
  });

  return {
    ...base,
    status: 'ok',
    rounds,
    roster,
    summary: {
      effectiveCues: effective.length,
      skippedCues: skippedCueCount,
      staff: staffNames.length,
      rounds: rounds.length,
      usedStaff: roster.filter((r) => r.positionCount > 0).length,
    },
  };
}

/**
 * 连场轮换排班（整场联合求解，纯函数）：runRotation 在「全员每轮可出场」
 * 情形下的对外包装，阻塞结果额外给出阻塞提示号与其前一条生效提示号。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string, props:string[]}>} staff 人员及其可搬运道具名单
 * @returns {Object} 排班结果，形态见下：
 *   公共字段：status（'ok' | 'blocked' | 'empty' | 'limited'）、
 *     effectiveCueNumbers（按重放顺序的生效提示号；失败提示不在其中，不计轮次）、
 *     rounds（仅 ok 时非空：每条生效提示一项，含完整岗位表 positions 与 usedStaff）、
 *     roster（仅 ok 时非空：每名人员承担的轮次提示号与岗位数）、summary。
 *   blocked 时另有 block：
 *     { number, reason: 'understaffed' | 'rotation',
 *       previousEffectiveCue, soloFeasible, compatibleWithPrevious, transferCount }，
 *     且不输出 rounds / roster（不输出部分岗位表）。
 */
function computeRotation(cues, results, staff) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const staffNames = staff.map((s) => s.name);
  const qualified = new Map(staff.map((s) => [s.name, new Set(s.props)]));

  // 仅纳入全量重放整组生效的提示；失败提示不计轮次（不隔开相邻生效提示）
  const effective = cues.filter((c) => {
    const r = resultByNumber.get(c.number);
    return !!(r && r.ok);
  });

  const solved = runRotation(effective, staffNames, qualified, null, {
    skippedCueCount: cues.length - effective.length,
  });

  if (solved.status !== 'blocked') return solved;

  const bi = solved.block.roundIndex;
  const cue = effective[bi];
  const { roundIndex, ...blockRest } = solved.block;
  return {
    ...solved,
    block: {
      number: cue.number,
      // 前一条生效提示号（失败提示不计轮次）；首条即无解时为 null
      previousEffectiveCue: bi > 0 ? effective[bi - 1].number : null,
      ...blockRest,
    },
  };
}

module.exports = {
  computeRotation,
  runRotation,
  feasibleUsedsets,
  combinations,
  RotationLimitError,
  COMBO_CAP,
};
