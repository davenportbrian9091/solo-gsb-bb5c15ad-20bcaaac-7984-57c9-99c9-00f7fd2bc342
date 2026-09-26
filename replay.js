'use strict';

/**
 * 逐组校验并应用提示（重放规则的唯一实现，全量重放与现场偏差推演共用）。
 *
 * 规则：
 *  - 每组转移基于「该组变动前」的状态校验来源区位；
 *  - 同组内每件道具最多转移一次；
 *  - 整组应用后，除「后台」外任一区位不得被多件道具占用（允许同组互换）；
 *  - 任一条校验失败则整组不生效，状态保持变动前，并记录全部冲突原因。
 *
 * 冲突溯源（trace，随每组结果返回）：
 *  - 维护「道具 -> 最后一次成功转移它的提示号」，仅在某组整组生效后按提示号顺序更新，
 *    失败组既不改变位置也不改变溯源；null 表示从未成功转移（现处初始区位）；
 *    特殊值 ONSITE_MARK 表示断点处由舞台监督现场校正录入；
 *  - 来源区位不符：记录道具当前区位与最后一次成功转移的提示号；
 *  - 容量冲突：记录试算后同占该区位的全部道具，标明是否由本组转入，
 *    以及各道具此前（组前状态）最后一次成功转移的提示号。
 *
 * 注意：会就地修改传入的 state / lastMoved，需要保留原状态时调用方应先拷贝。
 *
 * @returns {{results: Array, state: Object<string,string>, lastMoved: Object<string,*>}}
 */
function runCues(locations, cues, state, lastMoved) {
  const locDef = new Map(locations.map((l) => [l.name, l]));
  const results = [];

  for (const cue of cues) {
    const errors = [];
    // 结构化冲突溯源：随结果返回，供失败提示旁展示（成功组恒为空）
    const trace = { sourceMismatches: [], capacityConflicts: [] };

    // 1) 同组内同一道具不得出现多次（数据库有唯一约束，这里兜底防御）
    const seen = new Set();
    for (const t of cue.transfers) {
      if (seen.has(t.prop)) errors.push(`道具「${t.prop}」在本组中被转移多次`);
      seen.add(t.prop);
    }

    // 2) 基于变动前状态校验来源
    for (const t of cue.transfers) {
      if (!(t.prop in state)) {
        errors.push(`道具「${t.prop}」不存在`);
      } else if (state[t.prop] !== t.from) {
        errors.push(`道具「${t.prop}」当前位于「${state[t.prop]}」，不在来源区位「${t.from}」`);
        // 溯源：当前区位 + 最后一次成功转移的提示号（null = 初始区位）
        trace.sourceMismatches.push({
          prop: t.prop,
          from: t.from,
          current: state[t.prop],
          lastMovedCue: lastMoved[t.prop],
        });
      }
      if (!locDef.has(t.to)) {
        errors.push(`目标区位「${t.to}」不存在`);
      }
    }

    // 3) 试算整组完成后的占用情况（来源校验通过才有意义）
    let next = null;
    if (errors.length === 0) {
      next = { ...state };
      for (const t of cue.transfers) next[t.prop] = t.to;

      const occupancy = new Map(); // 区位 -> [道具]
      for (const [prop, loc] of Object.entries(next)) {
        if (!occupancy.has(loc)) occupancy.set(loc, []);
        occupancy.get(loc).push(prop);
      }
      for (const [loc, occupants] of occupancy) {
        const def = locDef.get(loc);
        if (def && !def.unlimited && occupants.length > 1) {
          errors.push(
            `区位「${loc}」容量为一件，本组完成后将被 ${occupants.map((p) => `「${p}」`).join('、')} 同时占用`
          );
          // 溯源：试算后同占该区位的道具，标明是否由本组转入 + 此前最后一次成功转移的提示号
          const movedIn = new Set(
            cue.transfers.filter((t) => t.to === loc).map((t) => t.prop)
          );
          trace.capacityConflicts.push({
            location: loc,
            occupants: occupants.map((p) => ({
              prop: p,
              movedIn: movedIn.has(p),
              lastMovedCue: lastMoved[p] !== undefined ? lastMoved[p] : null,
            })),
          });
        }
      }
    }

    if (errors.length === 0 && next) {
      // 整组通过才提交：位置与溯源一并按提示号顺序更新
      Object.assign(state, next);
      for (const t of cue.transfers) lastMoved[t.prop] = cue.number;
      results.push({ number: cue.number, note: cue.note, ok: true, errors: [], transfers: cue.transfers, trace });
    } else {
      // 整组不生效，状态与溯源一并回滚（保持变动前）
      results.push({ number: cue.number, note: cue.note, ok: false, errors, transfers: cue.transfers, trace });
    }
  }

  return { results, state, lastMoved };
}

/**
 * 现场校正后接续重放时，lastMoved 中标记道具区位来自断点现场录入
 * （而非计划中的某条提示），trace 展示为「现场校正」。
 */
const ONSITE_MARK = 'onsite';

/** 汇总最终区位：区位 -> [道具] */
function buildFinalLocations(locations, state) {
  const finalLocations = {};
  for (const l of locations) finalLocations[l.name] = [];
  for (const [prop, loc] of Object.entries(state)) {
    if (!finalLocations[loc]) finalLocations[loc] = [];
    finalLocations[loc].push(prop);
  }
  return finalLocations;
}

/**
 * 检查一个状态是否合法：每个区位都存在，且普通（非后台）区位不被多件道具占用。
 * 供「现场偏差推演」校验断点处的现场状态使用（规则与整组容量校验一致）。
 *
 * @returns {Array<{location:string, occupants:string[]}>} 冲突区位列表，为空即合法
 */
function occupancyConflicts(locations, state) {
  const locDef = new Map(locations.map((l) => [l.name, l]));
  const occupancy = new Map(); // 区位 -> [道具]
  for (const [prop, loc] of Object.entries(state)) {
    if (!occupancy.has(loc)) occupancy.set(loc, []);
    occupancy.get(loc).push(prop);
  }
  const conflicts = [];
  for (const [loc, occupants] of occupancy) {
    const def = locDef.get(loc);
    if (!def) {
      conflicts.push({ location: loc, occupants, missing: true });
    } else if (!def.unlimited && occupants.length > 1) {
      conflicts.push({ location: loc, occupants, missing: false });
    }
  }
  return conflicts;
}

/**
 * 全量重放：从道具初始区位出发，按提示号升序逐组校验并应用转移。
 *
 * @param {Array<{name:string, unlimited:boolean}>} locations
 * @param {Array<{name:string, location:string}>}   props
 * @param {Array<{number:number, note:string, transfers:Array<{prop:string, from:string, to:string}>}>} cues 已按提示号升序
 * @returns {{results: Array, finalState: Object<string,string>,
 *            finalLocations: Object<string,string[]>, lastMoved: Object<string,*>}}
 *   results 元素：{number, note, ok, errors, transfers,
 *     trace: {sourceMismatches: Array<{prop, from, current, lastMovedCue}>,
 *             capacityConflicts: Array<{location, occupants: Array<{prop, movedIn, lastMovedCue}>}>}}
 */
function replay(locations, props, cues) {
  // 当前状态：道具 -> 区位（从初始区位开始）
  const state = {};
  for (const p of props) state[p.name] = p.location;

  // 溯源：道具 -> 最后一次成功转移它的提示号（null = 从未成功转移，现处初始区位）
  const lastMoved = {};
  for (const p of props) lastMoved[p.name] = null;

  const run = runCues(locations, cues, state, lastMoved);
  return {
    results: run.results,
    finalState: run.state,
    finalLocations: buildFinalLocations(locations, run.state),
    lastMoved: run.lastMoved,
  };
}

/**
 * 从任意给定状态接续重放（现场偏差推演专用）：
 * 前半段提示重放到断点后，用断点处的现场状态校正，再按同样规则重放后续提示。
 *
 * @param {Array} locations 区位定义
 * @param {Array} restCues  断点之后的提示（已按提示号升序）
 * @param {Object} startState     断点校正后的现场状态（会被拷贝，不修改入参）
 * @param {Object} startLastMoved 校正后溯源：现场录入的道具标记为 ONSITE_MARK
 * @returns {ReturnType<replay>}
 */
function replayFrom(locations, restCues, startState, startLastMoved) {
  const state = { ...startState };
  const lastMoved = { ...startLastMoved };
  const run = runCues(locations, restCues, state, lastMoved);
  return {
    results: run.results,
    finalState: run.state,
    finalLocations: buildFinalLocations(locations, run.state),
    lastMoved: run.lastMoved,
  };
}

/**
 * 对比两次重放的结果（用于「试排预览」：现行序列 vs 草稿插入/替换后的假设序列）。
 *
 *  - changedCues：按提示号列出「生效状态」发生变化的提示（含新增），携带前后冲突原因；
 *  - movedProps：最终区位发生变化的道具（from/to 为 null 表示道具在该序列中不存在）。
 *
 * @param {ReturnType<replay>} before 现行序列重放结果
 * @param {ReturnType<replay>} after  假设序列重放结果
 */
function diffReplays(before, after) {
  const beforeBy = new Map(before.results.map((r) => [r.number, r]));
  const afterBy = new Map(after.results.map((r) => [r.number, r]));
  const numbers = new Set([...beforeBy.keys(), ...afterBy.keys()]);

  const changedCues = [];
  for (const number of numbers) {
    const b = beforeBy.get(number) || null;
    const a = afterBy.get(number) || null;
    // 新增（一边不存在）或 ok 状态翻转，都算生效状态变化
    if (!b || !a || b.ok !== a.ok) {
      changedCues.push({
        number,
        note: (a || b).note,
        before: b ? { ok: b.ok, errors: b.errors } : null,
        after: a ? { ok: a.ok, errors: a.errors } : null,
      });
    }
  }
  changedCues.sort((x, y) => x.number - y.number);

  const movedProps = [];
  const allProps = new Set([
    ...Object.keys(before.finalState),
    ...Object.keys(after.finalState),
  ]);
  for (const prop of allProps) {
    const from = before.finalState[prop];
    const to = after.finalState[prop];
    if (from !== to) movedProps.push({ prop, from: from || null, to: to || null });
  }

  return { changedCues, movedProps };
}

module.exports = { replay, replayFrom, runCues, occupancyConflicts, buildFinalLocations, ONSITE_MARK, diffReplays };
