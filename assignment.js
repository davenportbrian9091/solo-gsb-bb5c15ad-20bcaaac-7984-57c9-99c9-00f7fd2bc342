'use strict';

/**
 * 逐提示岗位表（换景人员分配）。
 *
 * 规则（以全量重放结果为准）：
 *  - 仅「整组生效」的提示需要执行，才生成岗位；失败提示标记为「无需执行」；
 *  - 组内每条道具转移 = 一个同时执行的岗位；
 *  - 同一人员在同一组内最多承担一个岗位（不同组先后执行，可重复出现）；
 *  - 人员必须具备该道具的搬运资格才能承担对应岗位；
 *  - 对整组求「完整匹配」（二分图最大匹配，增广路算法），而不是按转移录入
 *    顺序贪心分配 —— 贪心会让先录入的转移占掉唯一合适的人：例如同组
 *    「屏风（张三/王五可搬）、桌子（仅张三可搬）」，必须先录的屏风改派王五，
 *    桌子才能分给张三，整组才有解；
 *  - 无法整组覆盖时：该组标记为「人手不足」，列出未覆盖道具，不输出部分岗位表，
 *    并给出「资格瓶颈诊断」（见 diagnoseBottleneck）。
 *
 * 人员资格或提示内容变化后，由服务端用最新数据整体重算（本模块为纯函数）。
 */

/**
 * 二分图最大匹配（Kuhn 增广路算法）：左侧为组内各条转移（道具），右侧为人员，
 * 边表示「该人员具备这条转移所需道具的搬运资格」。
 * 与按录入顺序贪心不同：已占位的人员可被增广路改派到其他转移，
 * 从而找到整组的最大覆盖。
 *
 * @param {Array<string[]>} candidates  candidates[i] = 可承担第 i 条转移的人员名单
 * @param {string[]} staffNames         全部人员名单（右侧节点，顺序即人员录入顺序）
 * @returns {{leftMatch:Array<number|null>, rightMatch:Array<number|null>}}
 *   leftMatch[i]  = 第 i 条转移分配到的人员序号（null = 未覆盖）；
 *   rightMatch[j] = 人员 j 当前承担的转移序号（null = 未承担本组岗位）
 */
function runMaxMatching(candidates, staffNames) {
  const leftMatch = new Array(candidates.length).fill(null);
  const rightMatch = new Array(staffNames.length).fill(null);
  const indexOf = new Map(staffNames.map((name, j) => [name, j]));

  // 增广路：为第 ti 条转移寻找人员；若看中的人已被占，尝试把占用人改派到别的转移
  function augment(ti, seen) {
    for (const name of candidates[ti]) {
      const j = indexOf.get(name);
      if (j === undefined || seen.has(j)) continue;
      seen.add(j);
      if (rightMatch[j] === null || augment(rightMatch[j], seen)) {
        rightMatch[j] = ti;
        leftMatch[ti] = j;
        return true;
      }
    }
    return false;
  }

  for (let ti = 0; ti < candidates.length; ti++) augment(ti, new Set());
  return { leftMatch, rightMatch };
}

/**
 * 兼容旧接口的包装：返回每条转移分配到的人员姓名（null = 未覆盖）。
 * @param {Array} transfers 组内转移（仅用于计数与保持顺序）
 * @param {Array<string[]>} candidates candidates[i] = 可承担第 i 条转移的人员名单
 * @returns {Array<string|null>}
 */
function maxMatching(transfers, candidates) {
  const names = [...new Set(candidates.flat())];
  const { leftMatch } = runMaxMatching(candidates, names);
  return leftMatch.map((j) => (j === null ? null : names[j]));
}

/**
 * 资格瓶颈诊断（Hall 缺额的可达集 / 竞争簇分解）。
 *
 * 不能只把当前未匹配道具当作瓶颈：最大匹配下未匹配的转移，往往只是一组
 * 互相竞争的道具中「最后落单」的那个。诊断做法：
 *  1. 从整组最大匹配中的全部未匹配转移出发，在资格二分图上沿交替路
 *     （左：道具 → 所有资格边 → 右：人员 → 该人员在匹配中承担的转移 → 左…）
 *     做 BFS，得到未匹配转移沿「资格竞争关系」可达的全部道具与人员；
 *  2. 可达道具集 Z 满足 Hall 紧约束 |Z| = |N(Z)| + 缺额：这些道具能找的
 *     人全在可达人员里，补人 / 补资格必须落到簇内道具上才能解除缺口；
 *  3. 可达子图再按「道具 — 资格边 — 人员」的连通性切成互不相连的竞争簇，
 *     每簇独立缺人（每簇缺口 = 簇内未匹配转移数 = 簇内道具数 − 人员数）。
 *
 * 注意连通性判定使用交替路可达集而不是把整张二分图直接取连通块：
 * 否则可能沿「可达道具 → 未被占用的外人」把本不缺人的富余部分也并进簇，
 * 掩盖真正的瓶颈。
 *
 * @param {Array<{prop:string}>} transfers 组内转移（按录入顺序）
 * @param {string[]} staffNames 全部人员名单
 * @param {Array<string[]>} candidates candidates[i] = 第 i 条转移的合格人员
 * @param {Array<number|null>} leftMatch  runMaxMatching 的左侧匹配结果
 * @param {Array<number|null>} rightMatch runMaxMatching 的右侧匹配结果
 * @returns {{shortage:number, clusters:Array<{shortage:number,
 *   props:string[], staff:string[], uncoveredProps:string[]}>}}
 *   - shortage：全组岗位缺口总数（= 未覆盖转移数）；
 *   - clusters：互不相连的资格竞争簇，每簇给出缺口人数、参与竞争的
 *     全部道具名单、合格人员名单，以及该簇内当前未覆盖的道具名单。
 */
function diagnoseBottleneck(transfers, staffNames, candidates, leftMatch, rightMatch) {
  const n = transfers.length;
  const qual = candidates.map((list) => list.map((name) => staffNames.indexOf(name)));
  // 反向边：人员 j -> 其具备资格的全部转移序号
  const personProps = staffNames.map(() => []);
  qual.forEach((list, ti) => list.forEach((j) => personProps[j].push(ti)));

  /* 1) 交替路 BFS：从未匹配转移出发，左→任意资格边；右→仅匹配边回左 */
  const reachL = new Array(n).fill(false);
  const reachR = new Array(staffNames.length).fill(false);
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (leftMatch[i] === null) {
      reachL[i] = true;
      queue.push([0, i]);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const [side, id] = queue[head];
    if (side === 0) {
      for (const j of qual[id]) {
        if (!reachR[j]) {
          reachR[j] = true;
          queue.push([1, j]);
        }
      }
    } else {
      // 最大匹配下，沿交替路可达的人员必然已匹配，否则存在增广路
      const ti = rightMatch[id];
      if (ti !== null && !reachL[ti]) {
        reachL[ti] = true;
        queue.push([0, ti]);
      }
    }
  }

  /* 2) 可达子图按连通关系切成互不相连的竞争簇（边 = 可达道具与可达人员间的资格） */
  const seenL = new Array(n).fill(false);
  const seenR = new Array(staffNames.length).fill(false);
  const clusters = [];

  for (let start = 0; start < n; start++) {
    if (!reachL[start] || seenL[start]) continue;
    const L = [];
    const R = [];
    const stack = [[0, start]];
    seenL[start] = true;
    while (stack.length) {
      const [side, id] = stack.pop();
      if (side === 0) {
        L.push(id);
        for (const j of qual[id]) {
          if (reachR[j] && !seenR[j]) {
            seenR[j] = true;
            stack.push([1, j]);
          }
        }
      } else {
        R.push(id);
        for (const ti of personProps[id]) {
          if (reachL[ti] && !seenL[ti]) {
            seenL[ti] = true;
            stack.push([0, ti]);
          }
        }
      }
    }
    L.sort((a, b) => a - b);
    R.sort((a, b) => a - b);
    const uncoveredIdx = L.filter((i) => leftMatch[i] === null);
    clusters.push({
      firstIndex: L[0], // 仅用于按转移录入顺序稳定排序
      shortage: uncoveredIdx.length,
      props: L.map((i) => transfers[i].prop),
      staff: R.map((j) => staffNames[j]),
      uncoveredProps: uncoveredIdx.map((i) => transfers[i].prop),
    });
  }

  clusters.sort((a, b) => a.firstIndex - b.firstIndex);
  return {
    shortage: clusters.reduce((sum, c) => sum + c.shortage, 0),
    clusters: clusters.map(({ firstIndex, ...c }) => c),
  };
}

/**
 * 生成逐提示岗位表。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string, props:string[]}>} staff 人员及其可搬运道具名单
 * @returns {Array<{number:number, note:string, status:'ok'|'understaffed'|'skipped',
 *   positions:Array<{prop:string, from:string, to:string, staff:string}>,
 *   uncovered:string[], transferCount:number,
 *   diagnosis:null|{shortage:number, clusters:Array}>}>}
 *   - ok：人员齐备，positions 为完整岗位表（每条转移一岗，同组人员不重复）；
 *   - understaffed：人手不足，positions 恒为空（不输出部分岗位表），uncovered 列出
 *     未覆盖道具，diagnosis 为资格瓶颈诊断（竞争簇、每簇缺口与道具/人员名单）；
 *   - skipped：重放未生效，无需执行，positions 与 diagnosis 恒为空 / null。
 */
function computeAssignments(cues, results, staff) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const staffNames = staff.map((s) => s.name);
  const qualified = new Map(staff.map((s) => [s.name, new Set(s.props)]));

  return cues.map((cue) => {
    const r = resultByNumber.get(cue.number);
    const base = { number: cue.number, note: cue.note, transferCount: cue.transfers.length };

    // 失败提示：整组未生效，无需执行
    if (!r || !r.ok) {
      return { ...base, status: 'skipped', positions: [], uncovered: [], diagnosis: null };
    }

    // 每条转移的可承担人员 = 具备该道具搬运资格的人（按人员录入顺序）
    const candidates = cue.transfers.map((t) =>
      staff.filter((s) => qualified.get(s.name).has(t.prop)).map((s) => s.name)
    );

    const { leftMatch, rightMatch } = runMaxMatching(candidates, staffNames);

    if (leftMatch.every((j) => j !== null)) {
      // 整组完整匹配：输出岗位表
      return {
        ...base,
        status: 'ok',
        positions: cue.transfers.map((t, i) => ({
          prop: t.prop,
          from: t.from,
          to: t.to,
          staff: staffNames[leftMatch[i]],
        })),
        uncovered: [],
        diagnosis: null,
      };
    }

    // 无解：人手不足，标出未覆盖道具，不输出部分岗位表；附资格瓶颈诊断
    return {
      ...base,
      status: 'understaffed',
      positions: [],
      uncovered: cue.transfers.filter((t, i) => leftMatch[i] === null).map((t) => t.prop),
      diagnosis: diagnoseBottleneck(
        cue.transfers,
        staffNames,
        candidates,
        leftMatch,
        rightMatch
      ),
    };
  });
}

module.exports = { computeAssignments, maxMatching, diagnoseBottleneck, runMaxMatching };
