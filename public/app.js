'use strict';

/* 全局状态：最近一次从服务器获取的全量数据（含重放结果） */
let state = null;
let editingCue = null; // 正在编辑的提示号，null 表示新增模式

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function toast(msg, okStyle) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('ok', !!okStyle);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || '操作失败');
    throw new Error(data.error || '操作失败');
  }
  state = data; // 所有变更接口都返回最新全量状态
  render();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function locationOptions(selected) {
  return state.locations
    .map((l) => {
      const label = l.unlimited ? `${l.name}（不限）` : `${l.name}（限一件）`;
      return `<option value="${esc(l.name)}" ${l.name === selected ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

function propOptions(selected) {
  return state.props
    .map((p) => `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}

/* ---------- 冲突溯源（失败提示旁展示，lastMovedCue 为 null 表示初始区位） ---------- */

function lastMovedText(cueNumber) {
  if (cueNumber === null || cueNumber === undefined)
    return '初始区位（从未成功转移）';
  if (cueNumber === 'onsite')
    return '现场校正（断点处现场录入）';
  return `提示 ${cueNumber}`;
}

function traceHtml(trace) {
  if (!trace) return '';
  const blocks = [];

  if (trace.sourceMismatches && trace.sourceMismatches.length) {
    blocks.push(`
      <div class="trace-title">来源不符溯源</div>
      <ul>${trace.sourceMismatches
        .map((m) => `<li>「${esc(m.prop)}」当前位于「${esc(m.current)}」（最后一次成功转移：${lastMovedText(m.lastMovedCue)}），本组要求来源「${esc(m.from)}」</li>`)
        .join('')}</ul>`);
  }

  if (trace.capacityConflicts && trace.capacityConflicts.length) {
    for (const c of trace.capacityConflicts) {
      blocks.push(`
        <div class="trace-title">容量冲突溯源 · 区位「${esc(c.location)}」试算后同占道具</div>
        <ul>${c.occupants
          .map((o) => `<li>「${esc(o.prop)}」${o.movedIn
            ? '<span class="trace-tag">本组转入</span>'
            : '<span class="trace-tag dim">非本组转入</span>'}此前最后一次成功转移：${lastMovedText(o.lastMovedCue)}</li>`)
          .join('')}</ul>`);
    }
  }

  return blocks.length ? `<div class="cue-trace">${blocks.join('')}</div>` : '';
}

/* ---------- 渲染 ---------- */

function renderLocations() {
  const ul = $('#location-list');
  ul.innerHTML = state.locations
    .map((l) => `
      <li class="${l.unlimited ? 'backstage' : ''}">
        <strong>${esc(l.name)}</strong>
        <span class="cap">${l.unlimited ? '容量不限' : '限一件'}</span>
        ${l.unlimited ? '' : `<button class="link" data-del-loc="${esc(l.name)}" title="删除区位">✕</button>`}
      </li>`)
    .join('');
  $('#prop-location').innerHTML = locationOptions();
}

function renderProps() {
  const tbody = $('#prop-rows');
  tbody.innerHTML = state.props
    .map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td><select data-prop-loc="${esc(p.name)}">${locationOptions(p.location)}</select></td>
        <td><button class="link" data-del-prop="${esc(p.name)}">删除</button></td>
      </tr>`)
    .join('');
}

function renderCueForm() {
  $('#cue-number').disabled = editingCue !== null;
  $('#cue-submit').textContent = editingCue !== null ? `保存修改（提示号 ${editingCue}）` : '保存提示';
  $('#cue-cancel').classList.toggle('hidden', editingCue === null);
}

function addTransferRow(t) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="t-prop">${propOptions(t && t.prop)}</select></td>
    <td><select class="t-from">${locationOptions(t && t.from)}</select></td>
    <td><select class="t-to">${locationOptions(t && t.to)}</select></td>
    <td><button type="button" class="link t-remove">移除</button></td>`;
  tr.querySelector('.t-remove').onclick = () => {
    tr.remove();
    if (!$('#transfer-rows').children.length) addTransferRow();
    clearPreview();
  };
  $('#transfer-rows').appendChild(tr);
}

function resetCueForm() {
  editingCue = null;
  $('#cue-number').value = '';
  $('#cue-note').value = '';
  $('#transfer-rows').innerHTML = '';
  addTransferRow();
  renderCueForm();
  clearPreview();
}

function renderCues() {
  const box = $('#cue-list');
  if (!state.cues.length) {
    box.innerHTML = '<p class="hint">还没有提示，请在上方录入。</p>';
    return;
  }
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  box.innerHTML = state.cues
    .map((c) => {
      const r = resultByNumber.get(c.number);
      const badge = r && r.ok
        ? '<span class="badge ok">✓ 已生效</span>'
        : '<span class="badge fail">✗ 整组未生效</span>';
      const transfers = c.transfers
        .map((t) => `<div>「${esc(t.prop)}」 ${esc(t.from)} <span class="arrow">→</span> ${esc(t.to)}</div>`)
        .join('');
      const errors = r && !r.ok
        ? `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${traceHtml(r.trace)}`
        : '';
      return `
        <div class="cue-item ${r && r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${c.number}</span>
            <span class="note">${esc(c.note || '')}</span>
            ${badge}
          </div>
          <div class="cue-transfers">${transfers}</div>
          ${errors}
          <div class="cue-actions">
            <button class="small ghost" data-edit-cue="${c.number}">编辑</button>
            <button class="small danger" data-del-cue="${c.number}">删除</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderReplay() {
  const box = $('#replay-results');
  if (!state.replay.results.length) {
    box.innerHTML = '<p class="hint">暂无提示可重放。</p>';
  } else {
    box.innerHTML = state.replay.results
      .map((r) => `
        <div class="cue-item ${r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            ${r.ok ? '<span class="badge ok">✓ 整组生效</span>' : '<span class="badge fail">✗ 整组未生效</span>'}
          </div>
          ${r.ok ? '' : `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${traceHtml(r.trace)}`}
        </div>`)
      .join('');
  }

  $('#final-board').innerHTML = Object.entries(state.replay.finalLocations)
    .map(([loc, props]) => `
      <div class="loc ${loc === '后台' ? 'backstage' : ''}">
        <div class="loc-name">${esc(loc)}</div>
        ${props.length ? props.map((p) => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="empty">（空）</span>'}
      </div>`)
    .join('');
}

function render() {
  renderLocations();
  renderProps();
  renderCueForm();
  renderCues();
  renderReplay();
  renderSimForm();
  renderStaff();
  renderAssignments();
  renderRotation();
  renderAbsenceForm();
  renderPassages();
  renderRouting();
}

/* ---------- 换景人员与逐提示岗位表 ---------- */

function renderStaff() {
  const box = $('#staff-list');
  if (!state.staff.length) {
    box.innerHTML = '<p class="hint">还没有人员，请在下方添加并授予搬运资格。</p>';
    return;
  }
  box.innerHTML = state.staff
    .map((s) => {
      const chips = s.props
        .map((p) => `
          <span class="chip qual-chip">${esc(p)}
            <button type="button" class="chip-x" data-del-qual="${esc(s.name)}" data-prop="${esc(p)}" title="移除该道具的搬运资格">✕</button>
          </span>`)
        .join('');
      // 只能授予尚未具备的道具资格
      const available = state.props.filter((p) => !s.props.includes(p.name));
      const addForm = available.length
        ? `<form class="qual-form inline-form" data-staff="${esc(s.name)}">
             <select class="qual-prop">${available
               .map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`)
               .join('')}</select>
             <button type="submit" class="small ghost">＋ 授予资格</button>
           </form>`
        : '<p class="hint">已具备全部道具的搬运资格。</p>';
      return `
        <div class="staff-item">
          <div class="staff-head">
            <strong>${esc(s.name)}</strong>
            ${s.props.length ? '' : '<span class="hint">（暂无搬运资格，无法承担岗位）</span>'}
            <button type="button" class="link" data-del-staff="${esc(s.name)}">删除</button>
          </div>
          <div class="staff-quals">${chips}</div>
          ${addForm}
        </div>`;
    })
    .join('');
}

/* ---------- 资格瓶颈诊断（人手不足组：竞争簇、每簇缺口与道具/人员名单） ---------- */

function diagnosisHtml(diagnosis) {
  if (!diagnosis || !diagnosis.clusters || !diagnosis.clusters.length) return '';
  const clusters = diagnosis.clusters
    .map((c, ci) => {
      const uncoveredSet = new Set(c.uncoveredProps);
      const propChips = c.props
        .map((p) => {
          const miss = uncoveredSet.has(p);
          return `<span class="bn-prop${miss ? ' miss' : ''}">${esc(p)}${miss ? '<span class="trace-tag">未匹配</span>' : ''}</span>`;
        })
        .join('');
      const staffText = c.staff.length
        ? c.staff.map((s) => `「${esc(s)}」`).join('、')
        : '<em>无任何具备资格的人员</em>';
      return `
        <div class="bn-cluster">
          <div class="bn-cluster-head">竞争簇 ${ci + 1}：<strong>缺 ${c.shortage} 人</strong>
            <span class="hint">（簇内 ${c.props.length} 件道具争夺 ${c.staff.length} 名合格人员，最多只能排开 ${c.props.length - c.shortage} 个岗位）</span>
          </div>
          <div class="bn-line"><span class="bn-label">竞争道具</span>${propChips}</div>
          <div class="bn-line"><span class="bn-label">合格人员</span>${staffText}</div>
        </div>`;
    })
    .join('');
  return `
    <div class="bottleneck">
      <div class="bn-title">🔍 资格瓶颈诊断 · 共缺 ${diagnosis.shortage} 人，${diagnosis.clusters.length} 个互不相通的竞争簇</div>
      <p class="bn-intro hint">下列簇内道具只能由簇内人员搬运且道具多于人员，与簇外人员/资格无关；为簇内任一道具新增可搬人员（或为现有人员补授资格）即可缓解对应缺口。簇内已匹配的道具同样是瓶颈的一部分，不能只看当前未匹配道具。</p>
      ${clusters}
    </div>`;
}

function renderAssignments() {
  const list = state.assignments || [];
  const count = { ok: 0, understaffed: 0, skipped: 0 };
  for (const a of list) count[a.status]++;

  $('#assignment-summary').innerHTML = list.length
    ? `共 ${list.length} 组提示：<span class="sum-ok">${count.ok} 组人员齐备</span> · ` +
      `<span class="sum-lack">${count.understaffed} 组人手不足</span> · ` +
      `<span class="sum-skip">${count.skipped} 组无需执行</span>`
    : '暂无提示可排岗。';

  $('#assignment-list').innerHTML = list
    .map((a) => {
      if (a.status === 'skipped') {
        // 重放未生效：无需执行，不排岗
        return `
          <div class="cue-item skip">
            <div class="cue-head">
              <span class="num">提示 ${a.number}</span>
              <span class="note">${esc(a.note || '')}</span>
              <span class="badge skip">— 无需执行（整组未生效）</span>
            </div>
          </div>`;
      }
      if (a.status === 'understaffed') {
        // 整组无法完整匹配：标出未覆盖道具，不输出部分岗位表；附资格瓶颈诊断
        return `
          <div class="cue-item fail">
            <div class="cue-head">
              <span class="num">提示 ${a.number}</span>
              <span class="note">${esc(a.note || '')}</span>
              <span class="badge fail">✗ 人手不足</span>
            </div>
            <ul class="cue-errors">
              <li>本组需 ${a.transferCount} 个同时执行的岗位，现有资格人员无法整组覆盖；未覆盖道具：${a.uncovered.map((p) => `「${esc(p)}」`).join('、')}</li>
            </ul>
            ${diagnosisHtml(a.diagnosis)}
            <p class="hint">不输出部分岗位表 —— 请在 ⑦ 中补充人员或调整搬运资格，岗位表与瓶颈诊断将自动重算。</p>
          </div>`;
      }
      const rows = a.positions
        .map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(p.prop)}</td>
            <td>${esc(p.from)} <span class="arrow">→</span> ${esc(p.to)}</td>
            <td><strong>${esc(p.staff)}</strong></td>
          </tr>`)
        .join('');
      return `
        <div class="cue-item ok">
          <div class="cue-head">
            <span class="num">提示 ${a.number}</span>
            <span class="note">${esc(a.note || '')}</span>
            <span class="badge ok">✓ 人员齐备（${a.positions.length} 岗）</span>
          </div>
          <table class="table assign-table">
            <thead><tr><th>岗位</th><th>道具</th><th>转移</th><th>担当</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join('');
}

/* ---------- 连场轮换排班（整场联合求解） ---------- */

function effectiveSequenceHtml(rot, blockNumber) {
  const nums = rot.effectiveCueNumbers || [];
  if (!nums.length) return '';
  const skipped = rot.skippedCueCount || 0;
  const items = nums.map((n, i) => {
    const hit = n === blockNumber;
    return `<span class="rt-node${hit ? ' block' : ''}">轮${i + 1} · 提示 ${esc(n)}${hit ? ' ✗' : ''}</span>`;
  });
  return `
    <div class="rt-seq">
      <span class="rt-seq-label">生效提示连场轮次</span>
      ${items.join('<span class="rt-sep">→</span>')}
      ${skipped ? `<span class="rt-skip-note">（另有 ${skipped} 条失败提示不计轮次）</span>` : ''}
    </div>`;
}

function renderRotation() {
  const rot = state.rotation;
  const summaryEl = $('#rotation-summary');
  const panel = $('#rotation-panel');
  if (!rot) {
    summaryEl.textContent = '';
    panel.innerHTML = '';
    return;
  }

  summaryEl.innerHTML =
    `整场共 <strong>${rot.summary.effectiveCues}</strong> 条生效提示参与连场排班` +
    (rot.summary.skippedCues ? `，<span class="sum-skip">${rot.summary.skippedCues} 条失败提示不计轮次</span>` : '') +
    `，在册人员 ${rot.summary.staff} 名。`;

  /* 无生效提示 */
  if (rot.status === 'empty') {
    panel.innerHTML = `
      ${effectiveSequenceHtml(rot)}
      <p class="hint">当前没有任何整组生效的提示，无需连场排班（失败提示不纳入轮次）。</p>`;
    return;
  }

  /* 枚举规模超限（异常大数据量的防御分支） */
  if (rot.status === 'limited') {
    panel.innerHTML = `
      ${effectiveSequenceHtml(rot)}
      <div class="rt-blocked">
        <div class="rt-block-title">⚠️ 连场排班未计算</div>
        <p>${esc(rot.limited.message)}</p>
      </div>`;
    return;
  }

  /* 无法覆盖全场：只报首个无法形成可行前缀的提示号与前一条生效提示号，不输出部分岗位表 */
  if (rot.status === 'blocked') {
    const b = rot.block;
    const prevText = b.previousEffectiveCue === null
      ? '<strong>无</strong>（该提示就是第一条生效提示）'
      : `提示 <strong>${b.previousEffectiveCue}</strong>`;
    const reason = b.reason === 'understaffed'
      ? `提示 ${b.number} 需 ${b.transferCount} 个同时执行的岗位，无法仅由具备资格的人员整组覆盖（本组单独就没有完整匹配）。可在右侧「⑧ 逐提示岗位表」中查看该组的<strong>资格瓶颈诊断</strong>，补充人员或授予资格后将自动重算。`
      : `提示 ${b.number} <strong>单独可以排开</strong>（有 ${b.soloFeasible} 种合法动用方案），但与排到提示 ${b.previousEffectiveCue} 的任意合法分配都必然让同一人员连场出场（相邻两条生效提示不得同人）；系统已允许回头调整前序各提示的合法分配，仍找不到覆盖到该提示的可行前缀（兼容方案 ${b.compatibleWithPrevious} 种）。`;
    panel.innerHTML = `
      ${effectiveSequenceHtml(rot, b.number)}
      <div class="rt-blocked">
        <div class="rt-block-title">✗ 无法对整场形成可行连场排班</div>
        <ul class="rt-block-lines">
          <li>首个无法形成可行前缀的提示号：<strong class="rt-num">${b.number}</strong></li>
          <li>其前一条生效提示号：${prevText}</li>
        </ul>
        <p>${reason}</p>
        <p class="hint">按规则<strong>不输出部分岗位表</strong>——请在 ⑦ 中调整人员或搬运资格（或修改提示内容），排班将随最新数据实时重算。</p>
      </div>`;
    return;
  }

  /* 全场可行：逐轮岗位表 + 整场人员通览矩阵 */
  const roundCards = rot.rounds
    .map((r) => {
      const rows = r.positions
        .map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(p.prop)}</td>
            <td>${esc(p.from)} <span class="arrow">→</span> ${esc(p.to)}</td>
            <td><strong>${esc(p.staff)}</strong></td>
          </tr>`)
        .join('');
      return `
        <div class="cue-item ok rt-round">
          <div class="cue-head">
            <span class="num">轮次 ${r.round} · 提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            <span class="badge ok">✓ ${r.positions.length} 岗 · ${r.usedStaff.map((s) => esc(s)).join('、')}</span>
          </div>
          <table class="table assign-table">
            <thead><tr><th>岗位</th><th>道具</th><th>转移</th><th>担当</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join('');

  // 整场人员通览：行 = 人员，列 = 连场轮次；格内为该人员本轮搬运的道具
  const headCells = rot.rounds
    .map((r) => `<th title="${esc(r.note || '')}">轮${r.round}<br /><span class="rt-cue-no">提示 ${r.number}</span></th>`)
    .join('');
  const bodyRows = rot.roster
    .map((row) => {
      const byRound = new Map(row.appearances.map((a) => [a.round, a]));
      const cells = rot.rounds
        .map((r) => {
          const a = byRound.get(r.round);
          if (!a) return '<td class="rt-off">·</td>';
          const detail = a.positions.map((p) => `${p.prop}：${p.from} → ${p.to}`).join('\n');
          return `<td class="rt-on" title="${esc(detail)}">${a.positions.map((p) => esc(p.prop)).join('<br />')}</td>`;
        })
        .join('');
      return `
        <tr>
          <th class="rt-staff">${esc(row.staff)}<span class="rt-total">${row.positionCount} 岗</span></th>
          ${cells}
        </tr>`;
    })
    .join('');

  panel.innerHTML = `
    ${effectiveSequenceHtml(rot)}
    <div class="rt-ok-banner">✓ 整场 ${rot.rounds.length} 条生效提示均可连场轮换，共动用 ${rot.summary.usedStaff} 名人员；相邻两轮无同一人员出场。</div>
    <h3>逐轮岗位表（联合求解结果，可能已对前序提示的合法分配做出调整）</h3>
    <div id="rotation-rounds">${roundCards}</div>
    <h3>整场人员安排（行 = 人员，列 = 连场轮次；鼠标悬停格子查看转移明细）</h3>
    <div class="rt-matrix-wrap">
      <table class="table rt-matrix">
        <thead><tr><th class="rt-staff">人员 ＼ 轮次</th>${headCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

/* ---------- 事件 ---------- */

$('#location-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#location-name').value.trim();
  if (!name) return;
  api('/api/locations', 'POST', { name }).then(() => { $('#location-name').value = ''; }).catch(() => {});
});

$('#location-list').addEventListener('click', (e) => {
  const name = e.target.dataset.delLoc;
  if (!name) return;
  if (confirm(`删除区位「${name}」？`)) api(`/api/locations/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#prop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#prop-name').value.trim();
  const location = $('#prop-location').value;
  if (!name) return;
  api('/api/props', 'POST', { name, location }).then(() => { $('#prop-name').value = ''; }).catch(() => {});
});

$('#prop-rows').addEventListener('change', (e) => {
  const name = e.target.dataset.propLoc;
  if (!name) return;
  api(`/api/props/${encodeURIComponent(name)}`, 'PUT', { location: e.target.value }).catch(() => {});
});

$('#prop-rows').addEventListener('click', (e) => {
  const name = e.target.dataset.delProp;
  if (!name) return;
  if (confirm(`删除道具「${name}」？引用它的提示在重放时会报错。`))
    api(`/api/props/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#add-transfer').addEventListener('click', () => { addTransferRow(); clearPreview(); });

$('#cue-cancel').addEventListener('click', resetCueForm);

/* ---------- 试排预览（不写库） ---------- */

function collectCueForm() {
  return {
    number: Number($('#cue-number').value),
    note: $('#cue-note').value.trim(),
    transfers: [...$('#transfer-rows').querySelectorAll('tr')].map((tr) => ({
      prop: tr.querySelector('.t-prop').value,
      from: tr.querySelector('.t-from').value,
      to: tr.querySelector('.t-to').value,
    })),
  };
}

function clearPreview() {
  const panel = $('#cue-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function statusSideHtml(side) {
  if (!side) return '<span class="pv-none">（序列中不存在）</span>';
  if (side.ok) return '<span class="badge ok">✓ 生效</span>';
  return `<span class="badge fail">✗ 未生效</span>
    <ul class="cue-errors">${side.errors.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无冲突原因）</li>'}</ul>`;
}

function renderPreview(data) {
  const panel = $('#cue-preview-panel');
  const modeText = data.mode === 'replace'
    ? `假设<strong>替换</strong>提示 ${data.draft.number} 的整组内容`
    : `假设<strong>新增</strong>提示 ${data.draft.number}`;

  const cueBlocks = data.changedCues
    .map((c) => {
      const flip = !c.before || !c.after
        ? '<span class="pv-tag new">序列成员变化</span>'
        : c.after.ok
          ? '<span class="pv-flip up">未生效 → 生效 ↑</span>'
          : '<span class="pv-flip down">生效 → 未生效 ↓</span>';
      return `
        <div class="pv-cue">
          <div class="pv-cue-head"><span class="num">提示 ${c.number}</span> ${flip}</div>
          <div class="pv-sides">
            <div class="pv-side"><div class="pv-side-label">现行</div>${statusSideHtml(c.before)}</div>
            <div class="pv-arrow">→</div>
            <div class="pv-side"><div class="pv-side-label">假设</div>${statusSideHtml(c.after)}</div>
          </div>
        </div>`;
    })
    .join('');

  const movedBlocks = data.movedProps.length
    ? `<ul class="pv-moved">${data.movedProps
        .map((m) => `<li>「${esc(m.prop)}」：${m.from ? esc(m.from) : '（不存在）'} <span class="arrow">→</span> ${m.to ? esc(m.to) : '（不存在）'}</li>`)
        .join('')}</ul>`
    : '<p class="hint">没有道具的最终区位发生变化。</p>';

  panel.innerHTML = `
    <div class="pv-title">🧪 试排预览 · ${modeText}（仅内存重放，未写入数据库）</div>
    <h4>生效状态发生变化的提示</h4>
    ${cueBlocks || '<p class="hint">草稿加入后，所有提示的生效状态均无变化。</p>'}
    <h4>最终区位发生变化的道具</h4>
    ${movedBlocks}`;
  panel.classList.remove('hidden');
}

function renderPreviewError(msg) {
  const panel = $('#cue-preview-panel');
  panel.innerHTML = `<div class="pv-title">🧪 试排预览</div><div class="pv-error">草稿不合法：${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#cue-preview').addEventListener('click', async () => {
  const btn = $('#cue-preview');
  clearPreview();
  btn.disabled = true;
  btn.textContent = '重放中…';
  try {
    const res = await fetch('/api/cues/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectCueForm()),
    });
    const data = await res.json();
    if (!res.ok) {
      renderPreviewError(data.error || '预览失败');
    } else {
      renderPreview(data);
    }
  } catch (err) {
    renderPreviewError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🧪 试排预览（不保存）';
  }
});

// 表单内容一旦改动，旧预览即失效
$('#cue-form').addEventListener('input', clearPreview);
$('#cue-form').addEventListener('change', clearPreview);

$('#cue-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { number, note, transfers } = collectCueForm();
  const req = editingCue !== null
    ? api(`/api/cues/${editingCue}`, 'PUT', { note, transfers })
    : api('/api/cues', 'POST', { number, note, transfers });
  req.then(resetCueForm).catch(() => {});
});

$('#cue-list').addEventListener('click', (e) => {
  const editNum = e.target.dataset.editCue;
  const delNum = e.target.dataset.delCue;
  if (editNum) {
    const cue = state.cues.find((c) => c.number === Number(editNum));
    if (!cue) return;
    editingCue = cue.number;
    $('#cue-number').value = cue.number;
    $('#cue-note').value = cue.note || '';
    $('#transfer-rows').innerHTML = '';
    cue.transfers.forEach((t) => addTransferRow(t));
    renderCueForm();
    clearPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (delNum) {
    if (confirm(`删除提示 ${delNum}？删除后将按提示号重放全部剩余提示。`))
      api(`/api/cues/${delNum}`, 'DELETE').catch(() => {});
  }
});

/* ---------- 批量平移提示号 ---------- */

let shiftPlan = null; // 最近一次预览返回的方案（含冲突信息），输入一变即失效

function collectShiftForm() {
  return {
    from: Number($('#shift-from').value),
    to: Number($('#shift-to').value),
    shift: Number($('#shift-delta').value),
  };
}

function clearShiftPreview() {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderShiftPlan(data) {
  shiftPlan = data;
  const conflictSet = new Set(data.conflicts || []);
  const rows = data.moves
    .map((m) => {
      const hit = conflictSet.has(m.to);
      return `<li class="${hit ? 'shift-hit' : ''}">
        <span class="num">${m.from}</span> <span class="arrow">→</span> <span class="num">${m.to}</span>
        <span class="shift-note">${esc(m.note || '')}</span>
        ${hit ? '<span class="badge fail">冲突</span>' : ''}
      </li>`;
    })
    .join('');
  const summary = conflictSet.size
    ? `<div class="pv-error">新号 ${[...conflictSet].join('、')} 与区间外已有提示冲突，整批不可执行。</div>`
    : `<p class="hint">共 ${data.moves.length} 条提示，校验通过，可执行平移。</p>`;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `
    <div class="pv-title">⇄ 平移预览：闭区间每条提示的原号 → 新号（尚未写入数据库）</div>
    <ul class="shift-list">${rows}</ul>
    ${summary}`;
  panel.classList.remove('hidden');
  $('#shift-apply').disabled = conflictSet.size > 0;
}

function renderShiftError(msg) {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `<div class="pv-title">⇄ 批量平移提示号</div><div class="pv-error">${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#shift-preview').addEventListener('click', async () => {
  const btn = $('#shift-preview');
  clearShiftPreview();
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectShiftForm()),
    });
    const data = await res.json();
    if (!res.ok) renderShiftError(data.error || '预览失败');
    else renderShiftPlan(data);
  } catch (err) {
    renderShiftError('无法连接服务器');
  } finally {
    btn.disabled = false;
  }
});

// 输入一旦改动，旧预览即失效，须重新预览
$('#shift-form').addEventListener('input', clearShiftPreview);

$('#shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!shiftPlan || (shiftPlan.conflicts || []).length) return;
  const body = collectShiftForm();
  if (!confirm(`确认将区间 [${body.from}, ${body.to}] 内的 ${shiftPlan.moves.length} 条提示平移 ${body.shift > 0 ? '+' : ''}${body.shift}？`))
    return;
  const btn = $('#shift-apply');
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // 执行时校验失败（如预览后数据变化）：整批拒绝，标出冲突号
      if (data.moves) renderShiftPlan(data);
      else renderShiftError(data.error || '平移被拒绝');
      toast(data.error || '平移被拒绝');
      return;
    }
    state = data; // 成功：服务端已按新号全量重放，刷新整个页面
    render();
    clearShiftPreview();
    resetCueForm(); // 编辑中的提示号可能已被平移，退出编辑态避免指向旧号
    $('#shift-from').value = $('#shift-to').value = $('#shift-delta').value = '';
    toast('平移完成，已按新号全量重放', true);
  } catch (err) {
    renderShiftError('无法连接服务器');
  }
});

/* ---------- 现场偏差推演（不写库） ---------- */

let simBreakpoint = '';      // 选中的断点提示号
let simOverrides = {};       // 道具 -> 现场区位（'' 或缺失 = 沿用计划）
let simResult = null;        // 最近一次成功推演的结果，全局状态一变即失效

function clearSimResult() {
  simResult = null;
  const panel = $('#sim-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderSimForm(keepResult) {
  if (!keepResult) clearSimResult();

  // 道具被删除后，清理残留的现场录入
  for (const prop of Object.keys(simOverrides)) {
    if (!state.props.some((p) => p.name === prop)) delete simOverrides[prop];
  }

  // 断点下拉：复用重放结果标注该提示在计划序列中的生效情况
  const sel = $('#sim-breakpoint');
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  const opts = ['<option value="">请选择断点提示号…</option>']
    .concat(state.cues.map((c) => {
      const r = resultByNumber.get(c.number);
      const label = r
        ? `${c.number}（${r.ok ? '已生效' : '未生效'}）${c.note ? ' · ' + c.note : ''}`
        : `${c.number}`;
      return `<option value="${c.number}" ${String(c.number) === String(simBreakpoint) ? 'selected' : ''}>${esc(label)}</option>`;
    }));
  sel.innerHTML = opts.join('');
  if (!state.cues.some((c) => String(c.number) === String(simBreakpoint)))
    simBreakpoint = '';
  sel.value = simBreakpoint;

  // 道具行：断点处计划区位（推演成功后才有值）+ 现场区位录入
  const planState = simResult ? simResult.planStateAtBreakpoint : null;
  $('#sim-rows').innerHTML = state.props
    .map((p) => {
      const planLoc = planState ? planState[p.name] : null;
      const val = Object.prototype.hasOwnProperty.call(simOverrides, p.name)
        ? simOverrides[p.name]
        : '';
      return `
        <tr data-sim-prop="${esc(p.name)}">
          <td>${esc(p.name)}</td>
          <td class="sim-plan-loc">${planLoc !== null ? esc(planLoc) : '<span class="empty">—</span>'}</td>
          <td>
            <select class="sim-loc">
              <option value="" ${val === '' ? 'selected' : ''}>沿用计划</option>
              ${locationOptions(val === '' ? null : val)}
            </select>
          </td>
        </tr>`;
    })
    .join('');
}

function simStatusHtml(side) {
  if (!side) return '<span class="pv-none">（序列中不存在）</span>';
  if (side.ok) return '<span class="badge ok">✓ 生效</span>';
  return `<span class="badge fail">✗ 整组未生效</span>
    <ul class="cue-errors">${side.errors.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无冲突原因）</li>'}</ul>
    ${traceHtml(side.trace)}`;
}

function renderSimPanel(data) {
  const panel = $('#sim-panel');

  // 一、断点处计划 / 现场差异
  const breakRows = data.breakpointDiff.length
    ? data.breakpointDiff
        .map((d) => `
          <tr class="sim-diff-row">
            <td>${esc(d.prop)}${d.recorded ? ' <span class="trace-tag">现场录入</span>' : ''}</td>
            <td>${esc(d.plan)}</td>
            <td><span class="arrow">→</span></td>
            <td>${esc(d.onsite)}</td>
          </tr>`)
        .join('')
    : '<tr><td colspan="4" class="hint" style="border:none">所有道具均沿用断点处计划区位，无差异。</td></tr>';

  // 二、后续各提示：原计划 vs 现场推演
  const cueBlocks = data.followCues.length
    ? data.followCues.map((c) => {
        const flip = c.changed
          ? c.onsite.ok
            ? '<span class="pv-flip up">未生效 → 生效 ↑</span>'
            : '<span class="pv-flip down">生效 → 未生效 ↓</span>'
          : '<span class="pv-tag">生效状态不变</span>';
        return `
          <div class="pv-cue">
            <div class="pv-cue-head"><span class="num">提示 ${c.number}</span><span class="note">${esc(c.note || '')}</span>${flip}</div>
            <div class="pv-sides">
              <div class="pv-side"><div class="pv-side-label">原计划</div>${simStatusHtml(c.plan)}</div>
              <div class="pv-arrow">→</div>
              <div class="pv-side"><div class="pv-side-label">现场推演</div>${simStatusHtml(c.onsite)}</div>
            </div>
          </div>`;
      }).join('')
    : '<p class="hint">断点之后没有后续提示。</p>';

  // 三、最终道具区位差异
  const finalBlocks = data.finalDiff.length
    ? `<ul class="pv-moved">${data.finalDiff
        .map((d) => `<li>「${esc(d.prop)}」：${esc(d.plan)} <span class="arrow">→</span> ${esc(d.onsite)}${d.fromBreakpoint ? '<span class="trace-tag dim">停留在断点现场区位</span>' : ''}</li>`)
        .join('')}</ul>`
    : '<p class="hint">推演结束后，所有道具的最终区位与原计划一致。</p>';

  panel.innerHTML = `
    <div class="pv-title">🎯 现场偏差推演 · 断点为提示 ${data.breakpoint}（${esc(data.note || '无备注')}）—— 仅内存重放，未写入数据库</div>
    <h4>一、断点处计划 / 现场区位差异（另有 ${data.unchangedAtBreakpoint} 件道具无差异、沿用计划）</h4>
    <table class="table sim-diff-table">
      <thead><tr><th>道具</th><th>计划区位</th><th></th><th>现场区位</th></tr></thead>
      <tbody>${breakRows}</tbody>
    </table>
    <h4>二、断点之后各提示的生效状态（原计划 → 现场推演，失败组仍整组不生效）</h4>
    ${cueBlocks}
    <h4>三、推演结束后的最终道具区位差异（原计划 → 现场推演）</h4>
    ${finalBlocks}`;
  panel.classList.remove('hidden');
}

function renderSimError(msg, data) {
  const panel = $('#sim-panel');
  const conflicts = data && data.validation && data.validation.conflicts
    ? `<ul class="cue-errors">${data.validation.conflicts.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';

  // 现场区位不合法时，仍把已解析出的计划/现场区位并列展示，便于对照修改
  let breakTable = '';
  if (data && data.planState && data.onsiteState) {
    const rows = state.props
      .map((p) => {
        const plan = data.planState[p.name];
        const onsite = data.onsiteState[p.name];
        const diff = plan !== onsite;
        return `
          <tr class="${diff ? 'sim-diff-row' : ''}">
            <td>${esc(p.name)}</td>
            <td>${esc(plan)}</td>
            <td><span class="arrow">→</span></td>
            <td>${esc(onsite)}</td>
          </tr>`;
      })
      .join('');
    breakTable = `
      <h4>断点处计划 / 现场区位对照</h4>
      <table class="table sim-diff-table">
        <thead><tr><th>道具</th><th>计划区位</th><th></th><th>现场区位</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  panel.innerHTML = `
    <div class="pv-title">🎯 现场偏差推演 · 断点 ${data && data.breakpoint ? data.breakpoint : ''}</div>
    <div class="pv-error">${esc(msg)}</div>
    ${conflicts}
    ${breakTable}`;
  panel.classList.remove('hidden');
}

// 记录现场区位录入；录入一变，旧推演即失效
$('#sim-rows').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-sim-prop]');
  if (!row || !e.target.classList.contains('sim-loc')) return;
  simOverrides[row.dataset.simProp] = e.target.value;
  clearSimResult();
});

// 切换断点：计划区位列与旧推演都失效，保留已录入的现场区位
$('#sim-breakpoint').addEventListener('change', (e) => {
  simBreakpoint = e.target.value;
  renderSimForm();
});

$('#sim-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!simBreakpoint) {
    renderSimError('请先选择一个已执行完的提示号作为断点');
    return;
  }
  const overrides = Object.entries(simOverrides)
    .filter(([, loc]) => loc !== '')
    .map(([prop, location]) => ({ prop, location }));

  const btn = $('#sim-run');
  btn.disabled = true;
  btn.textContent = '推演中…';
  try {
    const res = await fetch('/api/onsite/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakpoint: Number(simBreakpoint), overrides }),
    });
    const data = await res.json();
    if (!res.ok) {
      renderSimError(data.error || '推演无法进行', data);
    } else {
      simResult = data;
      renderSimForm(true);
      renderSimPanel(data);
    }
  } catch (err) {
    renderSimError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🎯 开始现场推演';
  }
});

/* ---------- 换景人员维护 ---------- */

$('#staff-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#staff-name').value.trim();
  if (!name) return;
  api('/api/staff', 'POST', { name }).then(() => { $('#staff-name').value = ''; }).catch(() => {});
});

$('#staff-list').addEventListener('click', (e) => {
  const delStaff = e.target.dataset.delStaff;
  if (delStaff) {
    if (confirm(`删除人员「${delStaff}」？其搬运资格将一并删除，岗位表随即按最新数据重算。`))
      api(`/api/staff/${encodeURIComponent(delStaff)}`, 'DELETE').catch(() => {});
    return;
  }
  const delQual = e.target.dataset.delQual;
  if (delQual) {
    const prop = e.target.dataset.prop;
    api(`/api/staff/${encodeURIComponent(delQual)}/quals/${encodeURIComponent(prop)}`, 'DELETE').catch(() => {});
  }
});

// 每个人员卡片内的「授予资格」小表单（submit 事件会冒泡到列表容器）
$('#staff-list').addEventListener('submit', (e) => {
  const form = e.target.closest('.qual-form');
  if (!form) return;
  e.preventDefault();
  const staff = form.dataset.staff;
  const prop = form.querySelector('.qual-prop').value;
  api(`/api/staff/${encodeURIComponent(staff)}/quals`, 'POST', { prop }).catch(() => {});
});

/* ---------- 临时缺席试排（仅内存，不写库、不改正式排班） ---------- */

function staffOptions(selected) {
  return ['<option value="">选择人员…</option>']
    .concat(
      state.staff.map(
        (s) => `<option value="${esc(s.name)}" ${s.name === selected ? 'selected' : ''}>${esc(s.name)}</option>`
      )
    )
    .join('');
}

function addAbsenceRow(rule) {
  const tr = document.createElement('tr');
  tr.className = 'absence-row';
  tr.innerHTML = `
    <td><select class="ab-staff">${staffOptions(rule && rule.staff)}</select></td>
    <td><input class="ab-from" type="number" min="1" step="1" placeholder="如 10" value="${rule && rule.from != null ? esc(rule.from) : ''}" /></td>
    <td><input class="ab-to" type="number" min="1" step="1" placeholder="如 40" value="${rule && rule.to != null ? esc(rule.to) : ''}" /></td>
    <td><button type="button" class="link ab-remove">移除</button></td>`;
  tr.querySelector('.ab-remove').onclick = () => {
    tr.remove();
    if (!$('#absence-rows').children.length) addAbsenceRow();
    clearAbsenceResult();
  };
  $('#absence-rows').appendChild(tr);
}

// 全局状态变化后只刷新各规则行的人员下拉（保留已录入内容）；被删人员的行回到空选项
function renderAbsenceForm() {
  const rows = $('#absence-rows');
  if (!rows) return;
  if (!rows.children.length) addAbsenceRow();
  const validNames = new Set(state.staff.map((s) => s.name));
  rows.querySelectorAll('.absence-row').forEach((tr) => {
    const sel = tr.querySelector('.ab-staff');
    const current = sel.value;
    sel.innerHTML = staffOptions(validNames.has(current) ? current : '');
  });
  // 正式数据变化后，旧试排结果不再对应当前状态，自动清空
  clearAbsenceResult();
}

function clearAbsenceResult() {
  const panel = $('#absence-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function collectAbsenceRules() {
  return [...$('#absence-rows').querySelectorAll('.absence-row')].map((tr) => ({
    staff: tr.querySelector('.ab-staff').value,
    from: tr.querySelector('.ab-from').value.trim(),
    to: tr.querySelector('.ab-to').value.trim(),
  }));
}

/* 阻塞原因文案（与正式排班一致，并提示缺席造成的人手变化） */
function absenceBlockReason(b) {
  const prevText = b.previousEffectiveCue === null
    ? '<strong>无</strong>（该提示就是第一条生效提示）'
    : `提示 <strong>${b.previousEffectiveCue}</strong>`;
  const absentText = (b.absentStaff || []).length
    ? `本轮临时缺席、不能出场的人员：${b.absentStaff.map((s) => `「${esc(s)}」`).join('、')}。`
    : '本轮没有人员缺席。';
  const reason = b.reason === 'understaffed'
    ? `提示 ${b.number} 需 ${b.transferCount} 个同时执行的岗位，在缺席限制下无法仅由本轮可出场且具备资格的人员整组覆盖（本组单独就没有完整匹配）。${absentText}可调整缺席区间，或在 ⑦ 中补充人员 / 授予资格后重新试排。`
    : `提示 ${b.number} <strong>单独可以排开</strong>（有 ${b.soloFeasible} 种合法动用方案），但与排到提示 ${b.previousEffectiveCue} 的任意合法分配都必然让同一人员连场出场（相邻两条生效提示不得同人）；系统已允许回头调整前序各提示的合法分配，仍找不到覆盖到该提示的可行前缀（兼容方案 ${b.compatibleWithPrevious} 种）。${absentText}`;
  return { prevText, reason };
}

function renderAbsenceResult(data) {
  const panel = $('#absence-panel');

  // 规则回显：标出每条规则实际覆盖到的生效提示（失败提示不占轮次）
  const ruleLines = data.rules
    .map((r, i) => {
      const cov = data.ruleCoverage[i];
      const cues = cov && cov.coveredCues.length ? cov.coveredCues.join('、') : '无生效提示';
      return `<li>「${esc(r.staff)}」缺席于提示号闭区间 <strong>[${r.from}, ${r.to}]</strong>
        <span class="hint">（覆盖生效提示：${esc(cues)}${cov && cov.coveredCues.length ? `，即轮次 ${cov.affectedRounds.join('、')}` : ''}）</span></li>`;
    })
    .join('');

  const head = `
    <div class="pv-title">🧯 临时缺席试排结果（仅内存计算：规则未保存，正式排班未改动）</div>
    <ul class="ab-rules">${ruleLines}</ul>`;

  /* 无生效提示 */
  if (data.status === 'empty') {
    panel.innerHTML = `
      ${head}
      ${effectiveSequenceHtml(data)}
      <p class="hint">当前没有任何整组生效的提示，无需连场排班（失败提示不纳入轮次）。</p>`;
    panel.classList.remove('hidden');
    return;
  }

  /* 枚举规模超限 */
  if (data.status === 'limited') {
    panel.innerHTML = `
      ${head}
      ${effectiveSequenceHtml(data)}
      <div class="rt-blocked">
        <div class="rt-block-title">⚠️ 缺席试排未计算</div>
        <p>${esc(data.limited.message)}</p>
      </div>`;
    panel.classList.remove('hidden');
    return;
  }

  /* 无解：只报首个无法形成可行前缀的提示号、前一条生效提示号与原因，不显示部分岗位 */
  if (data.status === 'blocked') {
    const b = data.block;
    const { prevText, reason } = absenceBlockReason(b);
    panel.innerHTML = `
      ${head}
      ${effectiveSequenceHtml(data, b.number)}
      <div class="rt-blocked">
        <div class="rt-block-title">✗ 该缺席方案下无法对整场形成可行连场排班</div>
        <ul class="rt-block-lines">
          <li>首个无法形成可行前缀的提示号：<strong class="rt-num">${b.number}</strong></li>
          <li>其前一条生效提示号：${prevText}</li>
        </ul>
        <p>${reason}</p>
        <p class="hint">按规则<strong>不输出部分岗位表</strong>——可调整缺席人员 / 区间后重新试排。</p>
      </div>`;
    panel.classList.remove('hidden');
    return;
  }

  /* 可行：逐轮岗位表（标注本轮缺席人员） */
  const roundCards = data.rounds
    .map((r) => {
      const rows = r.positions
        .map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(p.prop)}</td>
            <td>${esc(p.from)} <span class="arrow">→</span> ${esc(p.to)}</td>
            <td><strong>${esc(p.staff)}</strong></td>
          </tr>`)
        .join('');
      const absentBadge = (r.absentStaff || []).length
        ? `<span class="badge ab-badge">本轮缺席：${r.absentStaff.map((s) => esc(s)).join('、')}</span>`
        : '';
      return `
        <div class="cue-item ok rt-round">
          <div class="cue-head">
            <span class="num">轮次 ${r.round} · 提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            ${absentBadge}
            <span class="badge ok">✓ ${r.positions.length} 岗 · ${r.usedStaff.map((s) => esc(s)).join('、')}</span>
          </div>
          <table class="table assign-table">
            <thead><tr><th>岗位</th><th>道具</th><th>转移</th><th>担当</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join('');

  // 人员 × 轮次矩阵：出场显示搬运道具，缺席格子明确标注「缺席」
  const headCells = data.rounds
    .map((r) => `<th title="${esc(r.note || '')}">轮${r.round}<br /><span class="rt-cue-no">提示 ${r.number}</span></th>`)
    .join('');
  const bodyRows = data.roster
    .map((row) => {
      const byRound = new Map(row.appearances.map((a) => [a.round, a]));
      const absentRounds = new Set((row.absentRounds || []).map((a) => a.round));
      const cells = data.rounds
        .map((r) => {
          const a = byRound.get(r.round);
          if (a) {
            const detail = a.positions.map((p) => `${p.prop}：${p.from} → ${p.to}`).join('\n');
            return `<td class="rt-on" title="${esc(detail)}">${a.positions.map((p) => esc(p.prop)).join('<br />')}</td>`;
          }
          if (absentRounds.has(r.round))
            return '<td class="rt-absent" title="该轮处于缺席区间，不能出场">缺席</td>';
          return '<td class="rt-off">·</td>';
        })
        .join('');
      const absentText = (row.absentRounds || []).length
        ? ` · <span class="ab-absent-total">缺席 ${row.absentRounds.length} 轮</span>`
        : '';
      return `
        <tr>
          <th class="rt-staff">${esc(row.staff)}<span class="rt-total">${row.positionCount} 岗${absentText}</span></th>
          ${cells}
        </tr>`;
    })
    .join('');

  panel.innerHTML = `
    ${head}
    ${effectiveSequenceHtml(data)}
    <div class="rt-ok-banner">
      ✓ 该缺席方案下整场 ${data.rounds.length} 条生效提示均可连场轮换，共动用 ${data.summary.usedStaff} 名人员，相邻两轮无同一人员出场；
      ${data.summary.affectedRounds} 个轮次受缺席规则影响、${data.summary.staffAbsent} 名人员存在缺席轮次（区间外仍正常参与）。
    </div>
    <h4>逐轮岗位与人员汇总（联合求解结果，可能已对前序提示的合法分配做出调整）</h4>
    <div id="absence-rounds">${roundCards}</div>
    <h4>整场人员安排（行 = 人员，列 = 连场轮次；「缺席」格表示该轮不能出场，悬停查看转移明细）</h4>
    <div class="rt-matrix-wrap">
      <table class="table rt-matrix">
        <thead><tr><th class="rt-staff">人员 ＼ 轮次</th>${headCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
  panel.classList.remove('hidden');
}

function renderAbsenceError(msg) {
  const panel = $('#absence-panel');
  panel.innerHTML = `<div class="pv-title">🧯 临时缺席试排</div><div class="pv-error">${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#absence-add').addEventListener('click', () => {
  addAbsenceRow();
  clearAbsenceResult();
});

$('#absence-clear').addEventListener('click', () => {
  $('#absence-rows').innerHTML = '';
  addAbsenceRow();
  clearAbsenceResult();
});

// 规则录入一变，旧试排结果即失效
$('#absence-rows').addEventListener('input', clearAbsenceResult);
$('#absence-rows').addEventListener('change', clearAbsenceResult);

$('#absence-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rules = collectAbsenceRules();
  if (!rules.length) {
    renderAbsenceError('请至少添加一条临时缺席规则');
    return;
  }
  const btn = $('#absence-run');
  btn.disabled = true;
  btn.textContent = '试排求解中…';
  try {
    const res = await fetch('/api/rotation/absence/trial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    const data = await res.json();
    if (!res.ok) renderAbsenceError(data.error || '试排失败');
    else renderAbsenceResult(data);
  } catch (err) {
    renderAbsenceError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🧯 开始临时缺席试排';
  }
});

/* ---------- 换景通道（无向边维护） ---------- */

function passageLocationOptions(selected, otherValue) {
  return state.locations
    .map((l) => `<option value="${esc(l.name)}" ${l.name === selected ? 'selected' : ''}>${esc(l.name)}</option>`)
    .join('');
}

function renderPassages() {
  const list = state.passages || [];
  const ul = $('#passage-list');
  ul.innerHTML = list.length
    ? list
        .map((p) => `
          <li class="passage-item">
            <strong>${esc(p.a)}</strong>
            <span class="passage-edge">—</span>
            <strong>${esc(p.b)}</strong>
            <button type="button" class="link" data-del-passage-a="${esc(p.a)}" data-del-passage-b="${esc(p.b)}" title="删除通道">✕</button>
          </li>`)
        .join('')
    : '<li class="hint">还没有通道，请在下方选择两个区位添加；没有通道连通的转移在通道规划中会判定为端点不连通。</li>';

  // 保留用户已选端点；区位集合变化后丢弃已不存在的选择（选项纯按区位渲染，
  // 自环由 change 监听在两端相同的瞬间清空另一端 + 服务端校验双重拦截）
  const selA = $('#passage-a');
  const selB = $('#passage-b');
  const has = (name) => state.locations.some((l) => l.name === name);
  const a = has(selA.value) ? selA.value : '';
  const b = has(selB.value) ? selB.value : '';
  selA.innerHTML = ['<option value="">选择端点区位…</option>', passageLocationOptions(a)].join('');
  selB.innerHTML = ['<option value="">选择端点区位…</option>', passageLocationOptions(b)].join('');
  selA.value = a;
  selB.value = b;
}

$('#passage-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = $('#passage-a').value;
  const b = $('#passage-b').value;
  if (!a || !b) {
    toast('请选择通道的两个端点区位');
    return;
  }
  if (a === b) {
    toast('通道的两个端点不能是同一区位（禁止自环）');
    return;
  }
  api('/api/passages', 'POST', { a, b }).catch(() => {});
});

// 任一端点改变时：若两端选成同一区位（自环），清空另一端；再刷新选项列表
$('#passage-form').addEventListener('change', (e) => {
  if (e.target.id !== 'passage-a' && e.target.id !== 'passage-b') return;
  const a = $('#passage-a');
  const b = $('#passage-b');
  if (a.value && a.value === b.value) {
    if (e.target.id === 'passage-a') b.value = '';
    else a.value = '';
    toast('通道的两个端点不能是同一区位（禁止自环）');
  }
  renderPassages();
});

$('#passage-list').addEventListener('click', (e) => {
  const a = e.target.dataset.delPassageA;
  const b = e.target.dataset.delPassageB;
  if (!a || !b) return;
  if (confirm(`删除「${a}」与「${b}」之间的通道？通道规划将立即重算。`))
    api(`/api/passages/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, 'DELETE').catch(() => {});
});

/* ---------- 换景通道规划预警（逐组联合搜索，实时重算） ---------- */

function routePathHtml(rt) {
  // 完整经过区位：来源 → … → 目标，标出经过的通道段数
  const nodes = rt.path
    .map((loc, i) => (i === 0
      ? `<strong>${esc(loc)}</strong>`
      : `<span class="rt2-node">${esc(loc)}</span>`))
    .join('<span class="arrow">→</span>');
  return `
    <div class="rt2-route">
      <span class="rt2-prop">「${esc(rt.prop)}」</span>
      ${nodes}
      <span class="rt2-hops">${rt.hops} 段通道</span>
    </div>`;
}

function routingGroupHtml(g) {
  if (g.status === 'ok') {
    const routes = g.routes.map(routePathHtml).join('');
    return `
      <div class="cue-item ok rt2-group">
        <div class="cue-head">
          <span class="num">提示 ${g.number}</span>
          <span class="note">${esc(g.note || '')}</span>
          <span class="badge ok">✓ 规划可行（${g.routes.length} 条转移，路径两两不共边）</span>
        </div>
        <div class="rt2-routes">${routes}</div>
      </div>`;
  }

  if (g.status === 'disconnected') {
    const lines = g.disconnected
      .map((d) => `<li>「${esc(d.prop)}」：${esc(d.from)} <span class="arrow">→</span> ${esc(d.to)}（两端区位在通道图上不连通，无论其他转移怎么走都无路可达）</li>`)
      .join('');
    return `
      <div class="cue-item fail rt2-group">
        <div class="cue-head">
          <span class="num">提示 ${g.number}</span>
          <span class="note">${esc(g.note || '')}</span>
          <span class="badge fail">✗ 端点不连通</span>
        </div>
        <ul class="cue-errors"><li>下列转移的来源与目标区位之间不存在任何通道路径，请在 ⑪ 中补建通道：</li>${lines}</ul>
      </div>`;
  }

  if (g.status === 'limited') {
    return `
      <div class="cue-item fail rt2-group">
        <div class="cue-head">
          <span class="num">提示 ${g.number}</span>
          <span class="note">${esc(g.note || '')}</span>
          <span class="badge fail">⚠ 未计算（路径规模超限）</span>
        </div>
        <ul class="cue-errors"><li>${esc(g.limited ? g.limited.message : '简单路径枚举量超过上限')}</li></ul>
      </div>`;
  }

  // contention：通道争用，按极小不可行子集（争用簇）列出受影响转移
  const clusters = (g.contention && g.contention.clusters || [])
    .map((c, ci) => {
      const lines = c.transfers
        .map((t) => `<li>「${esc(t.prop)}」：${esc(t.from)} <span class="arrow">→</span> ${esc(t.to)}</li>`)
        .join('');
      return `
        <div class="rt2-cluster">
          <div class="rt2-cluster-head">争用簇 ${ci + 1}：<strong>${c.transfers.length} 条转移争用同一组通道</strong>
            <span class="hint">（各转移端点本身均连通，但簇内任一条转移无论选哪条路径，都会与其余转移的路径共用通道；簇内转移少一条即可排开）</span>
          </div>
          <ul class="rt2-cluster-list">${lines}</ul>
        </div>`;
    })
    .join('');
  const truncNote = g.contention && g.contention.truncated
    ? '<p class="hint">（转移组合规模超过诊断枚举上限，已退化为把全部转移列为受影响）</p>'
    : '';
  return `
    <div class="cue-item fail rt2-group">
      <div class="cue-head">
        <span class="num">提示 ${g.number}</span>
        <span class="note">${esc(g.note || '')}</span>
        <span class="badge fail">✗ 通道争用</span>
      </div>
      <ul class="cue-errors">
        <li>每条转移的端点各自都有通道可达，但<strong>不存在一组互不共边的路径</strong>——系统已联合搜索并允许各转移改走绕行路径（非逐条固定最短路），仍无法排开；受影响转移如下，可在 ⑪ 中为争用通道补建平行通道：</li>
      </ul>
      <div class="rt2-contention">${clusters}</div>
      ${truncNote}
    </div>`;
}

function renderRouting() {
  const rt = state.routing;
  const summaryEl = $('#routing-summary');
  const alertsEl = $('#routing-alerts');
  const groupsEl = $('#routing-groups');
  if (!rt) {
    summaryEl.textContent = '';
    alertsEl.innerHTML = '';
    groupsEl.innerHTML = '';
    return;
  }

  const s = rt.summary;
  summaryEl.innerHTML =
    `共对 <strong>${s.total}</strong> 条重放生效提示规划通道线路` +
    (rt.skippedCueCount ? `，<span class="sum-skip">${rt.skippedCueCount} 条失败提示不参与规划</span>` : '') +
    `：<span class="sum-ok">${s.ok} 组可行</span>` +
    (s.disconnected ? ` · <span class="sum-lack">${s.disconnected} 组端点不连通</span>` : '') +
    (s.contention ? ` · <span class="sum-lack">${s.contention} 组通道争用</span>` : '') +
    (s.limited ? ` · <span class="sum-lack">${s.limited} 组规模超限</span>` : '') +
    `。`;

  if (rt.status === 'empty') {
    alertsEl.innerHTML = '<p class="hint">当前没有任何整组生效的提示，无需规划通道线路（失败提示不参与）。</p>';
    groupsEl.innerHTML = '';
    return;
  }

  // 独立预警条：把每组问题浓缩成一行（提示号 + 原因 + 受影响转移）
  const problemGroups = rt.groups.filter((g) => g.status !== 'ok');
  if (!problemGroups.length) {
    alertsEl.innerHTML = '<div class="rt2-banner-ok">✓ 全部生效提示均已找到两两不共边的通道线路组合，下方逐组列出完整经过区位。</div>';
  } else {
    alertsEl.innerHTML = problemGroups
      .map((g) => {
        if (g.status === 'disconnected') {
          const props = g.disconnected.map((d) => `「${esc(d.prop)}」${esc(d.from)}→${esc(d.to)}`).join('、');
          return `<div class="rt2-alert disc"><strong>提示 ${g.number} · 端点不连通</strong><span>${props}</span></div>`;
        }
        if (g.status === 'limited') {
          return `<div class="rt2-alert"><strong>提示 ${g.number} · 路径规模超限未计算</strong></div>`;
        }
        const affected = new Map();
        (g.contention.clusters || []).forEach((c) =>
          c.transfers.forEach((t) => affected.set(t.index, t))
        );
        const props = [...affected.values()]
          .map((t) => `「${esc(t.prop)}」${esc(t.from)}→${esc(t.to)}`)
          .join('、');
        return `<div class="rt2-alert cont"><strong>提示 ${g.number} · 通道争用</strong><span>${props}</span></div>`;
      })
      .join('');
  }

  groupsEl.innerHTML = `
    <h3>逐组通道线路（联合搜索结果，随区位 / 通道 / 提示变更实时重算）</h3>
    ${rt.groups.map(routingGroupHtml).join('')}`;
}

/* ---------- 启动 ---------- */

api('/api/state').then(resetCueForm).catch(() => toast('无法连接服务器'));
