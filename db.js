'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'stage.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  name       TEXT PRIMARY KEY,
  unlimited  INTEGER NOT NULL DEFAULT 0   -- 1 = 后台，容量不限；0 = 普通区位，最多一件道具
);

CREATE TABLE IF NOT EXISTS props (
  name       TEXT PRIMARY KEY,
  location   TEXT NOT NULL REFERENCES locations(name)
);

CREATE TABLE IF NOT EXISTS cues (
  number     INTEGER PRIMARY KEY,          -- 提示号，唯一，重放按它升序
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cue_number INTEGER NOT NULL REFERENCES cues(number) ON DELETE CASCADE,
  prop       TEXT NOT NULL,
  from_loc   TEXT NOT NULL,
  to_loc     TEXT NOT NULL,
  UNIQUE (cue_number, prop)                -- 同组内每件道具最多转移一次
);

CREATE TABLE IF NOT EXISTS staff (
  name       TEXT PRIMARY KEY             -- 换景人员姓名
);

CREATE TABLE IF NOT EXISTS staff_quals (
  staff      TEXT NOT NULL REFERENCES staff(name) ON DELETE CASCADE,
  prop       TEXT NOT NULL,               -- 可搬运的道具；道具删除时由服务端一并清理
  PRIMARY KEY (staff, prop)               -- 同一人员对同一道具只记一条资格
);

CREATE TABLE IF NOT EXISTS passages (
  loc_a      TEXT NOT NULL REFERENCES locations(name) ON DELETE CASCADE,
  loc_b      TEXT NOT NULL REFERENCES locations(name) ON DELETE CASCADE,
  PRIMARY KEY (loc_a, loc_b),             -- 同一对区位只记一条通道（重复连接）
  CHECK (loc_a < loc_b)                   -- 无向边规范化存储：自环（A=B）被数据库直接拒绝
);
`);

// 首次启动时写入示例数据（区位 / 道具 / 人员 / 四条提示：30 号故意与 20 号冲突演示整组不生效，
// 40 号故意让两件道具只能由同一人搬运，演示岗位匹配的人手不足）
function seed() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM locations').get();
  if (c > 0) return;

  const tx = db.transaction(() => {
    const insLoc = db.prepare('INSERT INTO locations (name, unlimited) VALUES (?, ?)');
    insLoc.run('后台', 1);
    for (const name of ['舞台左', '舞台右', '舞台中央', '高台', '上场门', '下场门', '侧台']) insLoc.run(name, 0);

    const insProp = db.prepare('INSERT INTO props (name, location) VALUES (?, ?)');
    insProp.run('桌子', '舞台中央');
    insProp.run('花瓶', '舞台左');
    insProp.run('宝剑', '后台');
    insProp.run('屏风', '后台');
    insProp.run('椅子', '后台');

    // 无向通道（规范化为字典序端点写入）。拓扑刻意演示两种情形：
    //  - 后台↔舞台中央有一短（经上场门，2 段）一长（经高台、侧台，3 段）两条互不共边的路径，
    //    10 号同组互换若逐条取最短会抢「上场门」通道，联合搜索把一条改走长路径即可排开；
    //  - 舞台左、舞台右悬挂在「下场门」一侧，而下场门只经「下场门—后台」唯一通道连回后台、
    //    不与舞台中央相通，故 40 号两件道具撤向后台都必经同一条通道，演示通道争用无解。
    const insPassage = db.prepare('INSERT INTO passages (loc_a, loc_b) VALUES (?, ?)');
    const addPassage = (a, b) => {
      const [x, y] = a < b ? [a, b] : [b, a];
      insPassage.run(x, y);
    };
    addPassage('后台', '上场门');
    addPassage('上场门', '舞台中央');
    addPassage('后台', '高台');
    addPassage('高台', '侧台');
    addPassage('侧台', '舞台中央');
    addPassage('后台', '下场门');
    addPassage('下场门', '舞台左');
    addPassage('下场门', '舞台右');

    const insStaff = db.prepare('INSERT INTO staff (name) VALUES (?)');
    const insQual = db.prepare('INSERT INTO staff_quals (staff, prop) VALUES (?, ?)');
    insStaff.run('张三');
    insQual.run('张三', '桌子');
    insQual.run('张三', '屏风');
    insStaff.run('李四');
    insQual.run('李四', '花瓶');
    insQual.run('李四', '宝剑');
    insStaff.run('王五');
    insQual.run('王五', '屏风');
    insQual.run('王五', '椅子');

    const insCue = db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)');
    const insTr = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );

    insCue.run(10, '一幕开场：桌子与屏风互换（同组互换区位；桌子仅张三能搬，屏风须改派王五）');
    insTr.run(10, '屏风', '后台', '舞台中央');
    insTr.run(10, '桌子', '舞台中央', '后台');

    insCue.run(20, '侠客持剑上场');
    insTr.run(20, '宝剑', '后台', '舞台右');

    insCue.run(30, '花瓶移至台右（示例：与 20 号提示冲突，整组不生效）');
    insTr.run(30, '花瓶', '舞台左', '舞台右');

    insCue.run(40, '花瓶与宝剑同时撤下（示例：仅李四两者都能搬，人手不足）');
    insTr.run(40, '花瓶', '舞台左', '后台');
    insTr.run(40, '宝剑', '舞台右', '后台');
  });
  tx();
  console.log('[db] 已写入示例数据');
}

seed();

module.exports = db;
