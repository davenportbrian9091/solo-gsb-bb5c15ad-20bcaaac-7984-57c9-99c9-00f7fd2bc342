'use strict';

const express = require('express');
const db = require('./db');
const {
  replay,
  replayFrom,
  occupancyConflicts,
  ONSITE_MARK,
  diffReplays,
} = require('./replay');
const { computeAssignments } = require('./assignment');
const { computeRotation } = require('./rotation');
const { normalizeAbsenceRules, computeAbsenceRotation } = require('./absence');
const { computeRouting } = require('./routing');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BACKSTAGE = '后台';

/* ---------- 读取全量状态（含重放结果） ---------- */

function loadBaseData() {
  const locations = db
    .prepare('SELECT name, unlimited FROM locations ORDER BY unlimited DESC, rowid')
    .all()
    .map((l) => ({ name: l.name, unlimited: !!l.unlimited }));

  const props = db.prepare('SELECT name, location FROM props ORDER BY rowid').all();

  const trStmt = db.prepare(
    'SELECT prop, from_loc, to_loc FROM transfers WHERE cue_number = ? ORDER BY id'
  );
  const cues = db
    .prepare('SELECT number, note FROM cues ORDER BY number')
    .all()
    .map((c) => ({
      number: c.number,
      note: c.note,
      transfers: trStmt.all(c.number).map((t) => ({ prop: t.prop, from: t.from_loc, to: t.to_loc })),
    }));

  return { locations, props, cues };
}

/* 人员及其可搬运道具名单（资格按录入顺序返回） */
function loadStaff() {
  const qualStmt = db.prepare('SELECT prop FROM staff_quals WHERE staff = ? ORDER BY rowid');
  return db
    .prepare('SELECT name FROM staff ORDER BY rowid')
    .all()
    .map((s) => ({ name: s.name, props: qualStmt.all(s.name).map((q) => q.prop) }));
}

/* 区位间的无向通道（规范化为 loc_a < loc_b 存储，禁止自环与重复连接） */
function loadPassages() {
  return db
    .prepare('SELECT loc_a, loc_b FROM passages ORDER BY loc_a, loc_b')
    .all()
    .map((p) => ({ a: p.loc_a, b: p.loc_b }));
}

function loadState() {
  const { locations, props, cues } = loadBaseData();
  const staff = loadStaff();
  const passages = loadPassages();
  const replayResult = replay(locations, props, cues);
  // 岗位表以最新重放结果 + 最新人员资格实时重算，不落地存储
  const assignments = computeAssignments(cues, replayResult.results, staff);
  // 连场轮换排班：对整场全部生效提示联合求解（相邻生效提示人员不重复），同样实时重算
  const rotation = computeRotation(cues, replayResult.results, staff);
  // 换景通道规划：对生效提示逐组联合搜索不共边的简单路径组合，随区位/通道/提示实时重算
  const routing = computeRouting(
    locations,
    passages.map((p) => ({ loc_a: p.a, loc_b: p.b })),
    cues,
    replayResult.results
  );
  return { locations, props, cues, replay: replayResult, staff, assignments, rotation, passages, routing };
}

function ok(res) {
  res.json(loadState());
}

function bad(res, msg, code = 400) {
  res.status(code).json({ error: msg });
}

/* ---------- 查询 ---------- */

app.get('/api/state', (req, res) => ok(res));

/* ---------- 区位 ---------- */

app.post('/api/locations', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, '区位名称不能为空');
  if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」已存在`, 409);
  db.prepare('INSERT INTO locations (name, unlimited) VALUES (?, 0)').run(name);
  ok(res);
});

app.delete('/api/locations/:name', (req, res) => {
  const name = req.params.name;
  if (name === BACKSTAGE) return bad(res, '「后台」是固有区位，不能删除');
  if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」不存在`, 404);
  if (db.prepare('SELECT 1 FROM props WHERE location = ?').get(name))
    return bad(res, `区位「${name}」仍放有道具，无法删除`, 409);
  if (
    db.prepare('SELECT 1 FROM transfers WHERE from_loc = ? OR to_loc = ?').get(name, name)
  )
    return bad(res, `区位「${name}」仍被提示中的转移引用，无法删除`, 409);
  const tx = db.transaction(() => {
    // 关联的无向通道随区位一并清理（表上两端 FK 均为 ON DELETE CASCADE，
    // 这里显式删除以保证即使外部关闭 foreign_keys 也不留悬挂通道）
    db.prepare('DELETE FROM passages WHERE loc_a = ? OR loc_b = ?').run(name, name);
    db.prepare('DELETE FROM locations WHERE name = ?').run(name);
  });
  tx();
  ok(res);
});

/* ---------- 换景通道（区位间无向边） ----------
 * 通道不区分方向：提交 (A, B) 与 (B, A) 视为同一条。服务端把端点规范化
 * 为字典序 (loc_a, loc_b) 后落库，自环（两端相同）与重复连接被入参校验
 * 和数据库 PRIMARY KEY / CHECK 双重拒绝。删除任一端区位时关联通道随之清理。
 */

app.post('/api/passages', (req, res) => {
  const a = String(req.body.a || '').trim();
  const b = String(req.body.b || '').trim();
  if (!a || !b) return bad(res, '请选择通道的两个区位');
  if (a === b) return bad(res, '通道的两个端点不能是同一区位（禁止自环）');
  if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(a))
    return bad(res, `区位「${a}」不存在`);
  if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(b))
    return bad(res, `区位「${b}」不存在`);
  const [x, y] = a < b ? [a, b] : [b, a];
  try {
    db.prepare('INSERT INTO passages (loc_a, loc_b) VALUES (?, ?)').run(x, y);
  } catch (err) {
    if (String(err.message).includes('UNIQUE'))
      return bad(res, `「${x}」与「${y}」之间的通道已存在（重复连接）`, 409);
    throw err;
  }
  ok(res);
});

app.delete('/api/passages/:a/:b', (req, res) => {
  const a = req.params.a;
  const b = req.params.b;
  const [x, y] = a < b ? [a, b] : [b, a];
  const r = db.prepare('DELETE FROM passages WHERE loc_a = ? AND loc_b = ?').run(x, y);
  if (r.changes === 0) return bad(res, `「${x}」与「${y}」之间不存在通道`, 404);
  ok(res);
});

/* ---------- 道具 ---------- */

function checkInitialCapacity(location, excludeProp) {
  const loc = db.prepare('SELECT unlimited FROM locations WHERE name = ?').get(location);
  if (!loc) return `区位「${location}」不存在`;
  if (loc.unlimited) return null;
  const row = excludeProp
    ? db.prepare('SELECT name FROM props WHERE location = ? AND name != ?').get(location, excludeProp)
    : db.prepare('SELECT name FROM props WHERE location = ?').get(location);
  if (row) return `区位「${location}」初始只能放置一件道具（已放置「${row.name}」）`;
  return null;
}

app.post('/api/props', (req, res) => {
  const name = String(req.body.name || '').trim();
  const location = String(req.body.location || '').trim();
  if (!name) return bad(res, '道具名称不能为空');
  if (!location) return bad(res, '请选择初始区位');
  if (db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」已存在`, 409);
  const capErr = checkInitialCapacity(location, null);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('INSERT INTO props (name, location) VALUES (?, ?)').run(name, location);
  ok(res);
});

app.put('/api/props/:name', (req, res) => {
  const name = req.params.name;
  const location = String(req.body.location || '').trim();
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  const capErr = checkInitialCapacity(location, name);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('UPDATE props SET location = ? WHERE name = ?').run(location, name);
  ok(res);
});

app.delete('/api/props/:name', (req, res) => {
  const name = req.params.name;
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  // 引用该道具的转移保留，重放时会明确提示「道具不存在」，便于舞台监督核对
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM props WHERE name = ?').run(name);
    db.prepare('DELETE FROM staff_quals WHERE prop = ?').run(name); // 搬运资格随道具一并失效
  });
  tx();
  ok(res);
});

/* ---------- 提示（一组同时发生的转移） ---------- */

function validateCuePayload(body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number <= 0)
    return { err: '提示号必须是正整数' };
  const note = String(body.note || '').trim();
  const transfers = Array.isArray(body.transfers) ? body.transfers : [];
  if (transfers.length === 0) return { err: '每组提示至少需要一条转移' };

  const seenProps = new Set();
  for (const t of transfers) {
    const prop = String(t.prop || '').trim();
    const from = String(t.from || '').trim();
    const to = String(t.to || '').trim();
    if (!prop || !from || !to) return { err: '每条转移都要选择道具、来源区位和目标区位' };
    if (from === to) return { err: `道具「${prop}」的来源与目标区位相同，不是有效转移` };
    if (seenProps.has(prop)) return { err: `道具「${prop}」在同组中最多只能转移一次` };
    seenProps.add(prop);
    if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(prop))
      return { err: `道具「${prop}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(from))
      return { err: `来源区位「${from}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(to))
      return { err: `目标区位「${to}」不存在` };
  }
  return { number, note, transfers: transfers.map((t) => ({
    prop: String(t.prop).trim(), from: String(t.from).trim(), to: String(t.to).trim(),
  })) };
}

app.post('/api/cues', (req, res) => {
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);
  if (db.prepare('SELECT 1 FROM cues WHERE number = ?').get(v.number))
    return bad(res, `提示号 ${v.number} 已存在，提示号必须唯一`, 409);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)').run(v.number, v.note);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(v.number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

/* ---------- 试排预览（不写库） ----------
 * 沿用保存时的字段校验，把草稿按提示号插入或替换到内存中的序列，
 * 分别重放「现行序列」与「假设序列」，返回生效状态变化与最终区位变化。
 */
app.post('/api/cues/preview', (req, res) => {
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);

  const { locations, props, cues } = loadBaseData();
  const draft = { number: v.number, note: v.note, transfers: v.transfers };
  const existed = cues.some((c) => c.number === v.number);

  // 按提示号插入新提示，或整组替换同号提示（仅内存，不落库）
  const hypothetical = existed
    ? cues.map((c) => (c.number === v.number ? draft : c))
    : [...cues, draft].sort((a, b) => a.number - b.number);

  const currentReplay = replay(locations, props, cues);
  const hypotheticalReplay = replay(locations, props, hypothetical);
  const diff = diffReplays(currentReplay, hypotheticalReplay);

  res.json({
    mode: existed ? 'replace' : 'insert',
    draft,
    current: currentReplay,
    hypothetical: hypotheticalReplay,
    changedCues: diff.changedCues,
    movedProps: diff.movedProps,
  });
});

app.put('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  const v = validateCuePayload({ ...req.body, number });
  if (v.err) return bad(res, v.err);

  const tx = db.transaction(() => {
    db.prepare('UPDATE cues SET note = ? WHERE number = ?').run(v.note, number);
    db.prepare('DELETE FROM transfers WHERE cue_number = ?').run(number);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

app.delete('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  db.prepare('DELETE FROM cues WHERE number = ?').run(number); // 转移级联删除
  ok(res);
});

/* ---------- 批量平移提示号 ----------
 * 输入闭区间 [from, to] 与非零整数位移 shift，区间内每条提示号 n 改为 n + shift。
 * 校验：区间内至少一条提示；新号均为安全正整数；不与区间外提示号冲突。
 * 校验通过后在单个事务中改写提示主键与转移的提示号引用，备注、转移内容与组内顺序不变。
 */

// 共用校验：返回 { moves, conflicts } 或 { err }
function planShift(body) {
  const from = Number(body.from);
  const to = Number(body.to);
  const shift = Number(body.shift);
  if (!Number.isSafeInteger(from) || from <= 0) return { err: '起始号必须是正整数' };
  if (!Number.isSafeInteger(to) || to <= 0) return { err: '结束号必须是正整数' };
  if (from > to) return { err: `起始号 ${from} 不能大于结束号 ${to}` };
  if (!Number.isSafeInteger(shift) || shift === 0) return { err: '位移必须是非零整数' };

  const rows = db
    .prepare('SELECT number, note FROM cues WHERE number BETWEEN ? AND ? ORDER BY number')
    .all(from, to);
  if (rows.length === 0) return { err: `区间 [${from}, ${to}] 内没有任何提示，无法平移` };

  const moves = rows.map((r) => ({ from: r.number, to: r.number + shift, note: r.note }));
  for (const m of moves) {
    if (!Number.isSafeInteger(m.to) || m.to <= 0)
      return { err: `提示 ${m.from} 平移后的新号 ${m.to} 不是安全正整数，整批拒绝` };
  }

  // 新号不得与区间外的提示号冲突（区间内互撞不可能：位移是单射）
  const marks = moves.map(() => '?').join(',');
  const conflicts = db
    .prepare(
      `SELECT number FROM cues WHERE (number < ? OR number > ?) AND number IN (${marks}) ORDER BY number`
    )
    .all(from, to, ...moves.map((m) => m.to))
    .map((r) => r.number);

  return { moves, conflicts };
}

// 预览：只列出原号→新号与冲突号，不写库
app.post('/api/cues/shift/preview', (req, res) => {
  const plan = planShift(req.body);
  if (plan.err) return bad(res, plan.err);
  res.json(plan);
});

// 执行：校验通过后单事务落库，随后全量重放并返回最新状态
app.post('/api/cues/shift', (req, res) => {
  const plan = planShift(req.body);
  if (plan.err) return bad(res, plan.err);
  if (plan.conflicts.length)
    return res.status(409).json({
      error: `新号与区间外提示冲突：${plan.conflicts.join('、')}，整批已拒绝`,
      conflicts: plan.conflicts,
      moves: plan.moves,
    });

  const from = Number(req.body.from);
  const to = Number(req.body.to);
  const shift = Number(req.body.shift);

  const tx = db.transaction(() => {
    // 先取出区间内提示的完整内容（转移按 id 保序），再删旧行、按新号重写
    const trStmt = db.prepare(
      'SELECT prop, from_loc, to_loc FROM transfers WHERE cue_number = ? ORDER BY id'
    );
    const cues = db
      .prepare('SELECT number, note FROM cues WHERE number BETWEEN ? AND ? ORDER BY number')
      .all(from, to)
      .map((c) => ({ number: c.number, note: c.note, transfers: trStmt.all(c.number) }));

    db.prepare('DELETE FROM cues WHERE number BETWEEN ? AND ?').run(from, to); // 旧转移级联删除

    const insCue = db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)');
    const insTr = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const c of cues) {
      const newNum = c.number + shift;
      insCue.run(newNum, c.note);
      for (const t of c.transfers) insTr.run(newNum, t.prop, t.from_loc, t.to_loc);
    }
  });
  tx();
  ok(res);
});

/* ---------- 现场偏差推演（不写库） ----------
 * 舞台监督选择一条「已执行完」的提示号作为断点，录入部分道具的现场区位
 * （未录入者沿用该断点的计划区位）。先按现有规则重放至断点得到计划状态，
 * 校验现场区位合法（区位存在且普通区位不重叠），再以校正后的现场状态
 * 接续重放断点之后的提示；失败组仍按同一规则整组不生效。
 * 整个过程只在内存中重放，不修改提示、道具初始区位或数据库。
 */

function badSim(res, msg, extra = {}) {
  res.status(400).json({ error: msg, ...extra });
}

app.post('/api/onsite/simulate', (req, res) => {
  const breakpoint = Number(req.body.breakpoint);
  if (!Number.isSafeInteger(breakpoint) || breakpoint <= 0)
    return badSim(res, '断点提示号必须是正整数');

  const { locations, props, cues } = loadBaseData();
  const cue = cues.find((c) => c.number === breakpoint);
  if (!cue) return badSim(res, `提示号 ${breakpoint} 不存在，无法作为断点`);

  const propNames = new Set(props.map((p) => p.name));
  const locNames = new Set(locations.map((l) => l.name));

  // 解析现场录入：支持 [{prop, location}] 或 {prop: location}，空字符串/缺省 = 沿用计划
  let raw = req.body.overrides;
  if (!Array.isArray(raw) && raw && typeof raw === 'object') {
    raw = Object.entries(raw).map(([prop, location]) => ({ prop, location }));
  }
  if (!Array.isArray(raw)) return badSim(res, '现场区位录入格式不正确');

  const overrides = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') return badSim(res, '现场区位录入格式不正确');
    const prop = String(item.prop || '').trim();
    const location = item.location === undefined || item.location === null
      ? ''
      : String(item.location).trim();
    if (!prop) return badSim(res, '现场区位录入缺少道具名称');
    if (!propNames.has(prop)) return badSim(res, `道具「${prop}」不存在`);
    if (location !== '' && !locNames.has(location))
      return badSim(res, `现场区位「${location}」不存在`);
    if (Object.prototype.hasOwnProperty.call(overrides, prop))
      return badSim(res, `道具「${prop}」的现场区位被重复录入`);
    overrides[prop] = location;
  }

  // 1) 按现有规则重放至断点（含断点提示本身），得到断点处的计划状态
  const idx = cues.findIndex((c) => c.number === breakpoint);
  const prefix = cues.slice(0, idx + 1);
  const suffix = cues.slice(idx + 1);

  const planPrefix = replay(locations, props, prefix);
  const planStateAtBreakpoint = planPrefix.finalState;

  // 2) 校正为现场状态：未录入者沿用该断点的计划区位
  const onsiteState = { ...planStateAtBreakpoint };
  const onsiteLastMoved = { ...planPrefix.lastMoved };
  const recorded = {};
  for (const [prop, location] of Object.entries(overrides)) {
    if (location !== '') {
      onsiteState[prop] = location;
      onsiteLastMoved[prop] = ONSITE_MARK; // 溯源：该道具由现场校正
      recorded[prop] = location;
    }
  }

  // 3) 校验现场状态：区位存在且普通区位不重叠（与整组容量规则一致）
  const conflicts = occupancyConflicts(locations, onsiteState);
  if (conflicts.length) {
    return badSim(res, '断点处现场区位不合法，无法接续推演', {
      breakpoint,
      planState: planStateAtBreakpoint,
      onsiteState,
      recorded,
      validation: {
        ok: false,
        conflicts: conflicts.map((c) =>
          c.missing
            ? `区位「${c.location}」不存在，却被 ${c.occupants.map((p) => `「${p}」`).join('、')} 占用`
            : `普通区位「${c.location}」容量为一件，现场状态下被 ${c.occupants.map((p) => `「${p}」`).join('、')} 同时占用`
        ),
        conflictsDetail: conflicts,
      },
    });
  }

  // 4) 以校正后的现场状态接续重放后续提示（复用同一重放规则，失败组整组不生效）
  const onsiteReplay = replayFrom(locations, suffix, onsiteState, onsiteLastMoved);

  // 5) 原计划侧：同样的全序列重放，用于并列对比
  const planReplay = replay(locations, props, cues);

  // 断点处计划/现场差异（仅列出区位不同的道具）
  const breakpointDiff = props
    .map((p) => ({
      prop: p.name,
      plan: planStateAtBreakpoint[p.name],
      onsite: onsiteState[p.name],
      recorded: Object.prototype.hasOwnProperty.call(recorded, p.name),
    }))
    .filter((d) => d.plan !== d.onsite);

  // 后续各提示：原计划 vs 现场推演的生效状态与冲突原因
  const planBy = new Map(planReplay.results.map((r) => [r.number, r]));
  const onsiteBy = new Map(onsiteReplay.results.map((r) => [r.number, r]));
  const followCues = suffix.map((c) => {
    const p = planBy.get(c.number) || null;
    const o = onsiteBy.get(c.number) || null;
    return {
      number: c.number,
      note: c.note,
      changed: !p || !o ? false : p.ok !== o.ok,
      plan: p ? { ok: p.ok, errors: p.errors, trace: p.trace } : null,
      onsite: o ? { ok: o.ok, errors: o.errors, trace: o.trace } : null,
    };
  });

  // 最终道具区位差异（计划终态 vs 现场推演终态）
  const finalDiff = [];
  for (const p of props) {
    const planLoc = planReplay.finalState[p.name];
    const onsiteLoc = onsiteReplay.finalState[p.name];
    if (planLoc !== onsiteLoc) {
      finalDiff.push({
        prop: p.name,
        plan: planLoc,
        onsite: onsiteLoc,
        // 现场终态停留在断点现场区位 = 后续没有任何提示成功移动它
        fromBreakpoint: onsiteLoc === onsiteState[p.name],
      });
    }
  }

  res.json({
    breakpoint,
    note: cue.note,
    recorded,
    planStateAtBreakpoint,
    onsiteStateAtBreakpoint: onsiteState,
    breakpointDiff,
    unchangedAtBreakpoint: props.length - breakpointDiff.length,
    followCues,
    plan: planReplay,
    onsite: onsiteReplay,
    finalDiff,
  });
});

/* ---------- 换景人员与搬运资格 ----------
 * 人员与资格变化后不落任何岗位表缓存：loadState 每次都用最新数据重算。
 */

app.post('/api/staff', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, '人员姓名不能为空');
  if (db.prepare('SELECT 1 FROM staff WHERE name = ?').get(name))
    return bad(res, `人员「${name}」已存在`, 409);
  db.prepare('INSERT INTO staff (name) VALUES (?)').run(name);
  ok(res);
});

app.delete('/api/staff/:name', (req, res) => {
  const name = req.params.name;
  if (!db.prepare('SELECT 1 FROM staff WHERE name = ?').get(name))
    return bad(res, `人员「${name}」不存在`, 404);
  db.prepare('DELETE FROM staff WHERE name = ?').run(name); // 搬运资格级联删除
  ok(res);
});

app.post('/api/staff/:name/quals', (req, res) => {
  const name = req.params.name;
  const prop = String(req.body.prop || '').trim();
  if (!db.prepare('SELECT 1 FROM staff WHERE name = ?').get(name))
    return bad(res, `人员「${name}」不存在`, 404);
  if (!prop) return bad(res, '请选择要授权的道具');
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(prop))
    return bad(res, `道具「${prop}」不存在`, 404);
  if (db.prepare('SELECT 1 FROM staff_quals WHERE staff = ? AND prop = ?').get(name, prop))
    return bad(res, `「${name}」已具备「${prop}」的搬运资格`, 409);
  db.prepare('INSERT INTO staff_quals (staff, prop) VALUES (?, ?)').run(name, prop);
  ok(res);
});

app.delete('/api/staff/:name/quals/:prop', (req, res) => {
  const { name, prop } = req.params;
  if (!db.prepare('SELECT 1 FROM staff WHERE name = ?').get(name))
    return bad(res, `人员「${name}」不存在`, 404);
  const r = db.prepare('DELETE FROM staff_quals WHERE staff = ? AND prop = ?').run(name, prop);
  if (r.changes === 0)
    return bad(res, `「${name}」本就不具备「${prop}」的搬运资格`, 404);
  ok(res);
});

/* ---------- 逐提示岗位表 ----------
 * 以最新重放结果与最新人员资格实时计算（与 /api/state 中的 assignments 一致）。
 */
app.get('/api/assignments', (req, res) => {
  const { assignments } = loadState();
  const summary = {
    total: assignments.length,
    ready: assignments.filter((a) => a.status === 'ok').length,
    understaffed: assignments.filter((a) => a.status === 'understaffed').length,
    skipped: assignments.filter((a) => a.status === 'skipped').length,
  };
  res.json({ assignments, summary });
});

/* ---------- 连场轮换排班（整场联合求解查询 API） ----------
 * 仅纳入全量重放生效的提示（失败提示不计轮次）；每条转移须由具备资格的
 * 人员承担、同组每人一岗，且同一人员不得出现在相邻两条生效提示中。
 * 无法覆盖全场时返回首个无法形成可行前缀的提示号及其前一条生效提示号，
 * 不输出部分岗位表。人员、资格或提示变化后实时重算，不落地存储。
 */
app.get('/api/rotation', (req, res) => {
  const { rotation } = loadState();
  res.json(rotation);
});

/* ---------- 换景通道规划（独立预警查询 API） ----------
 * 仅纳入全量重放生效的提示（失败组不执行，不占通道）；逐组为每条转移
 * 联合搜索不共边的简单路径组合，区分端点不连通与通道争用。区位、通道或
 * 提示变化后随全量状态实时重算，不落地存储（与 /api/state 中的 routing 一致）。
 */
app.get('/api/routing', (req, res) => {
  const { routing } = loadState();
  res.json(routing);
});

/* ---------- 临时缺席试排（不写库） ----------
 * 舞台监督临时添加多条规则，每条指定一名现有人员与一个提示号闭区间；
 * 区间按提示号覆盖全量重放后生效的提示（失败提示不占轮次），重叠规则取并集。
 * 试排沿用搬运资格、组内一人一岗及相邻生效提示不得同人规则，对整场联合
 * 求解并允许回溯调整前序分配；某轮缺席人员不能出场，区间外仍可参与。
 * 全程只在内存中计算：不保存规则、不改动正式排班或数据库。
 * 规则校验（未知人员、无效区间）不通过时整次拒绝（400）并逐条列出原因。
 */
app.post('/api/rotation/absence/trial', (req, res) => {
  const { locations, props, cues } = loadBaseData();
  const staff = loadStaff();
  const staffNames = new Set(staff.map((s) => s.name));

  const rawRules = req.body && Array.isArray(req.body.rules) ? req.body.rules : null;
  if (!rawRules)
    return res.status(400).json({ error: '请以 { rules: [...] } 形式提交缺席规则' });
  if (rawRules.length === 0)
    return res.status(400).json({ error: '请至少添加一条临时缺席规则' });

  const { rules, errors } = normalizeAbsenceRules(rawRules, staffNames);
  if (errors.length) {
    return res.status(400).json({
      error: `缺席规则校验未通过：${errors.map((e) => e.message).join('；')}`,
      errors,
    });
  }

  const replayResult = replay(locations, props, cues);
  const trial = computeAbsenceRotation(cues, replayResult.results, staff, rules);
  res.json(trial);
});

/* ---------- 启动 ---------- */

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`舞台换景排练系统已启动: http://localhost:${PORT}`);
});
