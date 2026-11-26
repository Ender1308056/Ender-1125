/* =========================================================================
 * 节奏探索 / Rhythm Pathfinder — 玩法验证框架
 * 全部逻辑为原生 JS + Canvas，无外部依赖。
 * ========================================================================= */

'use strict';

/* ---------------------------------------------------------------- 常量 */
const DIR_NAMES = ['up', 'down', 'left', 'right'];
const DIRS = {
  up:    { x: 0,  y: -1, glyph: '↑', label: '上' },
  down:  { x: 0,  y: 1,  glyph: '↓', label: '下' },
  left:  { x: -1, y: 0,  glyph: '←', label: '左' },
  right: { x: 1,  y: 0,  glyph: '→', label: '右' },
};
const ANGLE = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };
const PERP = {
  up: ['left', 'right'], down: ['left', 'right'],
  left: ['up', 'down'],  right: ['up', 'down'],
};
const SUBDIV = {
  whole:   { beats: 4,   label: '一分音符' },
  half:    { beats: 2,   label: '二分音符' },
  quarter: { beats: 1,   label: '四分音符' },
  eighth:  { beats: 0.5, label: '八分音符' },
};
const PX_PER_BEAT = 68;
const FORK_CHANCE = 0.35;   // 每个拐弯点出现分岔的概率
const BRANCH_BEATS = 4;     // 分岔支路长度（拍），尽头为死路
const MAX_FORKS = 4;
const LEAD_BEATS = 4;       // 起跑缓冲（同时作为一声部预备拍）
const LEAD_ROAD = 4;        // 角色身后预铺道路长度（拍）
const TOTAL_BARS = 32;
const KEYMAP = {
  w: 'up', a: 'left', s: 'down', d: 'right',
  arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right',
};

/* ------------------------------------------------- 美术资产导入占位 */
const ASSET_PATHS = {
  character:  'assets/character.png',
  roadFill:   'assets/road-fill.png',
  roadBorder: 'assets/road-border.png',
  markerTap:  'assets/marker-tap.png',
  markerHold: 'assets/marker-hold.png',
  bg:         'assets/bg.png',
};
const assets = {};
function loadAssets() {
  Object.entries(ASSET_PATHS).forEach(([name, path]) => {
    const img = new Image();
    img.onload = () => { assets[name] = img; };
    img.onerror = () => { assets[name] = null; };
    img.src = path;
  });
}

/* ---------------------------------------------------------------- DOM */
const $ = id => document.getElementById(id);
const dom = {
  bpm: $('bpm'), bpmValue: $('bpmValue'), subdiv: $('subdiv'),
  perfectWindow: $('perfectWindow'), goodWindow: $('goodWindow'),
  turnBars: $('turnBars'), holdChance: $('holdChance'), holdValue: $('holdValue'),
  forks: $('forks'),
  keyScheme: $('keyScheme'), sound: $('sound'), showRail: $('showRail'),
  startBtn: $('startBtn'), pauseBtn: $('pauseBtn'), railWrap: $('railWrap'),
  score: $('score'), combo: $('combo'), accuracy: $('accuracy'),
  barBeat: $('barBeat'), status: $('status'),
  overlay: $('overlay'), overlayTitle: $('overlayTitle'),
  overlayDesc: $('overlayDesc'), overlayBtn: $('overlayBtn'),
  game: $('game'), rail: $('rail'),
};

/* --------------------------------------------------------------- 状态 */
const state = {
  mode: 'idle',                 // idle | playing | paused | done
  bpm: 120, subdiv: 'quarter',
  turnBars: [2, 4, 6, 8],
  holdChance: 22, keyScheme: 'both', sound: true,
  beatDur: 0.5, totalBeats: TOTAL_BARS * 4,
  goodWindow: 0.18, perfectWindow: 0.09,
  startTime: 0, perfStart: 0, pausedT: 0,
  t: 0, nextClickBeat: 0,
  segments: [], notes: [], events: [], pathNodes: [], branches: [],
  forksEnabled: true, startPos: { x: 0, y: 0 },
  score: 0, combo: 0, maxCombo: 0, judgments: { perfect: 0, good: 0, miss: 0 },
  heldDirs: new Set(), activeHold: null,
  charPos: { x: 0, y: 0 }, charFrom: { x: 0, y: 0 }, charTo: { x: 0, y: 0 },
  moveStart: 0, moveDur: 0, facing: 'up', camera: { x: 0, y: 0 },
  fx: [],
  view: { ctx: null, w: 0, h: 0 }, railView: { ctx: null, w: 0, h: 0 },
  lastRAF: 0,
};

/* --------------------------------------------------------------- 工具 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpPos = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function now() {
  if (state.mode === 'paused') return state.pausedT;
  if (audio.ctx) return audio.ctx.currentTime - state.startTime;
  return performance.now() / 1000 - state.perfStart;
}

/* ------------------------------------------------------------ 节拍器 */
const audio = {
  ctx: null, timer: null,
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { this.ctx = new AC(); } catch (e) { this.ctx = null; } }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  click(when, accent) {
    if (!this.ctx || !state.sound) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1320 : 880;
    const vol = state.sound ? (accent ? 0.05 : 0.028) : 0;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(vol, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(when);
    osc.stop(when + 0.07);
  },
  schedule() {
    if (!this.ctx || state.mode !== 'playing') return;
    const horizon = this.ctx.currentTime + 0.14;
    let guard = 0;
    while (state.startTime + state.nextClickBeat * state.beatDur < horizon && guard++ < 32) {
      const b = state.nextClickBeat;
      this.click(state.startTime + b * state.beatDur, b % 4 === 0);
      state.nextClickBeat++;
      if (b > state.totalBeats + LEAD_BEATS + 2) break;
    }
  },
  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  },
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
};

/* -------------------------------------------------- 道路 / 谱面生成 */
function segmentAt(segments, beat) {
  if (beat < 0) return segments[0];
  for (const s of segments) {
    if (beat >= s.startBeat - 1e-6 && beat < s.endBeat - 1e-6) return s;
  }
  return segments[segments.length - 1];
}

/* ---- 分岔（只分叉、不汇入）：支路为死路，且不与任何已有道路相交 ---- */
function cross2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
}
function segmentsIntersect(a, b, c, d) {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false;
  const c1 = cross2(a, b, c), c2 = cross2(a, b, d);
  const c3 = cross2(c, d, a), c4 = cross2(c, d, b);
  if (Math.abs(c1) < 1e-6 && Math.abs(c2) < 1e-6) {
    // 共线时检查是否有实际重叠区间
    const useX = Math.abs(a.x - b.x) > Math.abs(a.y - b.y);
    const p1 = useX ? a.x : a.y, p2 = useX ? b.x : b.y;
    const p3 = useX ? c.x : c.y, p4 = useX ? d.x : d.y;
    return Math.max(Math.min(p1, p2), Math.min(p3, p4)) <
           Math.min(Math.max(p1, p2), Math.max(p3, p4)) - 1e-6;
  }
  // 用 <= 0 才能捕获「端点刚好落在另一条路上」的折回汇入
  return c1 * c2 <= 0 && c3 * c4 <= 0;
}
function pathIntersects(points, a, b) {
  for (let k = 0; k < points.length - 1; k++) {
    const isLastSegment = k === points.length - 2;
    // 终点落回旧节点 = 折回汇入；起点碰到非相邻旧节点同理
    if (samePoint(b, points[k]) || samePoint(b, points[k + 1])) return true;
    if (!isLastSegment && samePoint(a, points[k])) return true;
    if (segmentsIntersect(a, b, points[k], points[k + 1])) return true;
  }
  return false;
}

/* 主线自身也不能折回交叉，否则会出现视觉上的「汇入」和三角重叠 */
function tryBuildSegments(totalBeats, force) {
  const segments = [];
  const nodes = [{ x: 0, y: 0 }];
  let pos = { x: 0, y: 0 };
  let beat = 0;
  let dir = pick(DIR_NAMES);

  while (beat < totalBeats) {
    const bars = pick(state.turnBars.length ? state.turnBars : [4]);
    const len = Math.min(bars * 4, totalBeats - beat);
    const opts = PERP[dir];
    const candidates = Math.random() < 0.5 ? opts : [opts[1], opts[0]];
    let chosen = null;

    for (const cand of candidates) {
      const d = DIRS[cand];
      if (!pathIntersects(nodes, pos, {
        x: pos.x + d.x * len * PX_PER_BEAT,
        y: pos.y + d.y * len * PX_PER_BEAT,
      })) { chosen = cand; break; }
    }
    if (!chosen) {
      // 两条垂直方向都会撞上旧路时，允许直行一次；仍不行才强制生成
      const d = DIRS[dir];
      if (!pathIntersects(nodes, pos, {
        x: pos.x + d.x * len * PX_PER_BEAT,
        y: pos.y + d.y * len * PX_PER_BEAT,
      })) chosen = dir;
      else if (force) chosen = candidates[0];
      else return null;
    }

    const d = DIRS[chosen];
    pos = { x: pos.x + d.x * len * PX_PER_BEAT, y: pos.y + d.y * len * PX_PER_BEAT };
    nodes.push(pos);
    segments.push({ startBeat: beat, endBeat: beat + len, dir: chosen });
    beat += len;
    dir = chosen;
  }
  return segments;
}

function buildBranches() {
  state.branches = [];
  if (!state.forksEnabled) return;
  const nodes = state.pathNodes;
  const corners = state.events.filter(e => e.kinds.includes('corner') && e.beat >= 0);

  for (let i = 1; i < state.segments.length && state.branches.length < MAX_FORKS; i++) {
    if (Math.random() > FORK_CHANCE) continue;
    const seg = state.segments[i];
    const prev = state.segments[i - 1];
    const corner = corners.find(e => Math.abs(e.beat - seg.startBeat) < 1e-6);
    if (!corner) continue;

    // 支路取「另一条垂直方向」，既不是来路也不是主路方向
    const otherDir = PERP[prev.dir].find(d => d !== seg.dir);
    const d = DIRS[otherDir];
    const end = {
      x: corner.pos.x + d.x * BRANCH_BEATS * PX_PER_BEAT,
      y: corner.pos.y + d.y * BRANCH_BEATS * PX_PER_BEAT,
    };

    // 与主线及已有支路做相交检测，确保不会出现汇入/交叉
    let blocked = nodes.some(p => samePoint(p, end)); // 支路尽头不许落回主线路上
    for (let k = 0; k < nodes.length - 1 && !blocked; k++) {
      if (segmentsIntersect(corner.pos, end, nodes[k], nodes[k + 1])) blocked = true;
    }
    for (const br of state.branches) {
      if (samePoint(end, br.points[0]) || samePoint(end, br.points[1])) { blocked = true; break; }
      for (let k = 0; k < br.points.length - 1 && !blocked; k++) {
        if (segmentsIntersect(corner.pos, end, br.points[k], br.points[k + 1])) blocked = true;
      }
    }
    if (blocked) continue;

    state.branches.push({
      beat: seg.startBeat,
      dir: otherDir,
      points: [{ ...corner.pos }, end],
    });
  }
}

function generateRoad() {
  state.beatDur = 60 / state.bpm;
  const stepBeats = SUBDIV[state.subdiv].beats;
  const intervalSec = stepBeats * state.beatDur;
  state.goodWindow = Math.min(0.19, intervalSec * 0.45);
  state.perfectWindow = Math.min(0.09, intervalSec * 0.22);

  const totalBeats = TOTAL_BARS * 4;
  state.totalBeats = totalBeats;

  // 1) 路段：长度从 2/4/6/8 小节中随机抽取，拐弯只取垂直方向
  //    同时避开已走过的路，保证主线不自交（不会出现汇入路口）
  let segments = null;
  for (let attempt = 0; attempt < 16 && !segments; attempt++) {
    segments = tryBuildSegments(totalBeats, false);
  }
  if (!segments) segments = tryBuildSegments(totalBeats, true);
  state.segments = segments;

  // 2) 判定点：短按 / 长按。长按占满一个四分音符，结束拍上也不能再有短按
  const notes = [];
  let skipUntil = -Infinity;
  for (let b = 0; b < totalBeats - 1e-6; b += stepBeats) {
    if (b <= skipUntil + 1e-6) continue;
    const seg = segmentAt(segments, b);
    let type = 'tap';
    let endBeat = b;
    const roomForHold = b + 1 <= seg.endBeat - 1e-6 && b + 1 <= totalBeats;
    if (roomForHold && Math.random() < state.holdChance / 100) {
      type = 'hold';
      endBeat = b + 1;
    }
    notes.push({
      id: notes.length,
      beat: b, time: (b + LEAD_BEATS) * state.beatDur,
      dir: seg.dir, type,
      endBeat, endTime: (endBeat + LEAD_BEATS) * state.beatDur,
      state: 'pending', judgment: null, startDelta: 0,
      pos: null, endPos: null,
    });
    // 长按：连结束拍一起跳过，避免结束三角与短按三角重叠、逼出必 miss
    // 短按：只跳过当前拍，下一个网格点正常生成
    skipUntil = type === 'hold' ? endBeat : b;
  }
  state.notes = notes;

  // 3) 事件点（含拐角）并沿路径行走，得到世界坐标
  const evMap = new Map();
  const addEvent = (b, kind, note) => {
    const key = b.toFixed(4);
    if (!evMap.has(key)) evMap.set(key, { beat: b, kinds: [], notes: [] });
    const ev = evMap.get(key);
    ev.kinds.push(kind);
    if (note) ev.notes.push(note);
  };
  const firstDir = DIRS[segments[0].dir];
  addEvent(-LEAD_ROAD, 'corner');
  segments.forEach(s => {
    if (s.startBeat > 0) addEvent(s.startBeat, 'corner');
    addEvent(s.endBeat, 'corner');
  });
  notes.forEach(n => {
    addEvent(n.beat, 'note', n);
    if (n.type === 'hold') addEvent(n.endBeat, 'holdEnd', n);
  });
  const events = [...evMap.values()].sort((a, b) => a.beat - b.beat);

  let cursorBeat = -LEAD_ROAD;
  let cx = -firstDir.x * LEAD_ROAD * PX_PER_BEAT;
  let cy = -firstDir.y * LEAD_ROAD * PX_PER_BEAT;
  for (const ev of events) {
    while (cursorBeat < ev.beat - 1e-6) {
      const seg = segmentAt(segments, cursorBeat);
      const limit = Math.min(seg.endBeat, ev.beat);
      const d = DIRS[seg.dir];
      cx += d.x * (limit - cursorBeat) * PX_PER_BEAT;
      cy += d.y * (limit - cursorBeat) * PX_PER_BEAT;
      cursorBeat = limit;
    }
    ev.pos = { x: cx, y: cy };
    ev.dir = segmentAt(segments, clamp(ev.beat, 0, totalBeats - 1e-6)).dir;
    for (const n of ev.notes) {
      if (Math.abs(n.beat - ev.beat) < 1e-6) { n.pos = { ...ev.pos }; n.dir = ev.dir; }
      if (n.type === 'hold' && Math.abs(n.endBeat - ev.beat) < 1e-6) n.endPos = { ...ev.pos };
    }
  }
  state.events = events;
  state.pathNodes = events.map(e => e.pos).filter((p, i, arr) => {
    if (i === 0) return true;
    return Math.abs(p.x - arr[i - 1].x) > 0.01 || Math.abs(p.y - arr[i - 1].y) > 0.01;
  });
  state.startPos = { ...events[0].pos };
  buildBranches();

  // 输出谱面信息，方便调试
  const turns = segments.slice(1).map(s => `${s.startBeat / 4}小节→${DIRS[s.dir].glyph}`).join('  ');
  console.log(`[谱面] ${state.bpm}BPM / ${SUBDIV[state.subdiv].label} / 判定点 ${notes.length} 个` +
              ` / 长按 ${notes.filter(n => n.type === 'hold').length} 个 / 分岔 ${state.branches.length} 处` +
              ` / 拐弯: ${turns}`);
}

/* -------------------------------------------------------- 判定与移动 */
function moveChar(to, duration) {
  state.charFrom = { ...state.charPos };
  state.charTo = { ...to };
  state.moveStart = state.t;
  state.moveDur = Math.max(0, duration);
  if (state.moveDur === 0) state.charPos = { ...to };
}
function addFx(pos, label) {
  state.fx.push({ pos: { ...pos }, t0: state.t, label });
}
function registerHit(note, kind) {
  note.state = 'hit';
  note.judgment = kind;
  state.score += kind === 'PERFECT' ? 100 : 60;
  state.combo++;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.judgments[kind.toLowerCase()]++;
  state.facing = note.dir;
  const dest = note.type === 'hold' ? note.endPos : note.pos;
  moveChar(dest, note.type === 'hold' ? Math.max(0.1, note.endTime - state.t) : 0.2);
  addFx(dest, kind);
}
function registerMiss(note, label) {
  note.state = 'miss';
  note.judgment = label || 'MISS';
  state.combo = 0;
  state.judgments.miss++;
  state.facing = note.dir;
  // 漏判也继续沿道路前进，只是不计分、断连击
  const dest = note.type === 'hold' ? note.endPos : note.pos;
  moveChar(dest, note.type === 'hold' ? Math.max(0.1, note.endTime - state.t) : 0.2);
  addFx(note.pos, label || 'MISS');
}
function breakHold(note) {
  // 中途松手同样把角色送到长按终点，保证移动不中断
  registerMiss(note, 'BREAK');
}

function judgeQuality(delta) {
  return Math.abs(delta) <= state.perfectWindow ? 'PERFECT' : 'GOOD';
}

/* ------------------------------------------------------------ 输入 */
function allowedDir(key) {
  const dir = KEYMAP[key];
  if (!dir) return null;
  if (state.keyScheme === 'wasd' && !['w', 'a', 's', 'd'].includes(key)) return null;
  if (state.keyScheme === 'arrows' && !key.startsWith('arrow')) return null;
  return dir;
}
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  const dir = allowedDir(key);
  if (dir) e.preventDefault();
  if (state.mode !== 'playing' || !dir) return;
  if (!e.repeat) state.heldDirs.add(dir);
  if (e.repeat || state.activeHold) return;

  let best = null, bestAbs = Infinity;
  for (const n of state.notes) {
    if (n.state !== 'pending') continue;
    const d = state.t - n.time;
    if (Math.abs(d) <= state.goodWindow && Math.abs(d) < bestAbs) {
      best = n; bestAbs = Math.abs(d);
    }
  }
  if (!best) return;
  if (best.dir !== dir) { addFx(best.pos, 'WRONG'); return; }

  if (best.type === 'tap') {
    registerHit(best, judgeQuality(state.t - best.time));
  } else {
    best.state = 'active';
    best.startDelta = state.t - best.time;
    state.activeHold = best;
    state.facing = best.dir;
    moveChar(best.endPos, Math.max(0.08, best.endTime - state.t));
  }
});
document.addEventListener('keyup', e => {
  const dir = allowedDir(e.key.toLowerCase());
  if (!dir) return;
  state.heldDirs.delete(dir);
  const n = state.activeHold;
  if (n && n.dir === dir) {
    if (state.t >= n.endTime - 0.10) registerHit(n, judgeQuality(n.startDelta));
    else breakHold(n);
    state.activeHold = null;
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'playing') togglePause();
});

/* ------------------------------------------------------ 游戏流程 */
function showOverlay(title, desc, btn) {
  dom.overlayTitle.textContent = title;
  dom.overlayDesc.textContent = desc;
  dom.overlayBtn.textContent = btn;
  dom.overlay.classList.remove('hidden');
}
function hideOverlay() { dom.overlay.classList.add('hidden'); }

function startGame() {
  audio.init();
  generateRoad();

  state.score = 0; state.combo = 0; state.maxCombo = 0;
  state.judgments = { perfect: 0, good: 0, miss: 0 };
  state.fx = [];
  state.heldDirs.clear();
  state.activeHold = null;
  state.charPos = { ...state.startPos };
  state.camera = {
    x: state.charPos.x + DIRS[state.facing].x * 100,
    y: state.charPos.y + DIRS[state.facing].y * 100,
  };
  state.moveDur = 0;
  state.facing = state.segments[0].dir;
  state.perfStart = performance.now() / 1000;
  state.startTime = audio.ctx ? audio.ctx.currentTime + 0.15 : state.perfStart + 0.15;
  state.nextClickBeat = 0;
  state.mode = 'playing';
  hideOverlay();
  audio.startTimer();
}

function togglePause() {
  if (state.mode === 'playing') {
    state.pausedT = now();
    state.mode = 'paused';
    audio.stopTimer();
    dom.pauseBtn.textContent = '▶ 继续';
    dom.status.textContent = 'PAUSED';
    dom.status.className = 'status paused';
  } else if (state.mode === 'paused') {
    if (audio.ctx) state.startTime = audio.ctx.currentTime - state.pausedT;
    else state.perfStart = performance.now() / 1000 - state.pausedT;
    state.nextClickBeat = Math.floor(state.t / state.beatDur) + 1;
    state.mode = 'playing';
    dom.pauseBtn.textContent = '⏸ 暂停';
    audio.startTimer();
  }
}

function finishGame() {
  state.mode = 'done';
  audio.stopTimer();
  const judged = state.judgments.perfect + state.judgments.good + state.judgments.miss;
  const acc = judged ? ((state.judgments.perfect + state.judgments.good * 0.6) / judged * 100).toFixed(1) : '0.0';
  showOverlay(
    '探索完成',
    `得分 ${state.score} · 最大连击 ${state.maxCombo} · 准确率 ${acc}%` +
    `\nPERFECT ${state.judgments.perfect} / GOOD ${state.judgments.good} / MISS ${state.judgments.miss}`,
    '↻ 再来一次'
  );
}

/* -------------------------------------------------------------- 更新 */
function update() {
  state.t = now();

  if (state.mode === 'playing') {
    for (const n of state.notes) {
      if (n.state === 'pending' && state.t > n.time + state.goodWindow) registerMiss(n);
    }
    if (state.activeHold) {
      const n = state.activeHold;
      if (state.t >= n.endTime) {
        if (state.heldDirs.has(n.dir)) registerHit(n, judgeQuality(n.startDelta));
        else breakHold(n);
        state.activeHold = null;
      }
    }
    if (state.t > (state.totalBeats + LEAD_BEATS) * state.beatDur + 0.8) finishGame();
  }

  if (state.moveDur > 0) {
    const p = clamp((state.t - state.moveStart) / state.moveDur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    state.charPos = lerpPos(state.charFrom, state.charTo, e);
    if (p >= 1) state.moveDur = 0;
  }
  const d = DIRS[state.facing];
  const camTarget = {
    x: state.charPos.x + d.x * 100,
    y: state.charPos.y + d.y * 100,
  };
  state.camera.x = lerp(state.camera.x, camTarget.x, 0.09);
  state.camera.y = lerp(state.camera.y, camTarget.y, 0.09);

  updateHUD();
}

function updateHUD() {
  dom.score.textContent = state.score;
  dom.combo.textContent = state.combo;
  const total = state.judgments.perfect + state.judgments.good + state.judgments.miss;
  dom.accuracy.textContent = total
    ? ((state.judgments.perfect + state.judgments.good * 0.6) / total * 100).toFixed(1) + '%'
    : '—';
  const b = Math.max(0, Math.floor(state.t / state.beatDur - LEAD_BEATS));
  dom.barBeat.textContent = `${Math.floor(b / 4)} : ${b % 4 + 1}`;

  if (state.mode === 'playing') {
    const counting = state.t < LEAD_BEATS * state.beatDur;
    dom.status.textContent = counting
      ? `COUNT IN ${Math.ceil(LEAD_BEATS - state.t / state.beatDur)}`
      : 'PLAYING';
    dom.status.className = 'status' + (counting ? '' : ' playing');
  } else if (state.mode === 'idle') {
    dom.barBeat.textContent = '0 : 0';
  }
}

/* -------------------------------------------------------------- 渲染 */
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  [dom.game, dom.rail].forEach(canvas => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  });
  state.view = { ctx: dom.game.getContext('2d'), w: dom.game.clientWidth, h: dom.game.clientHeight };
  state.railView = { ctx: dom.rail.getContext('2d'), w: dom.rail.clientWidth, h: dom.rail.clientHeight };
}

function drawTriangle(ctx, pos, dir, filled, color, size) {
  const s = size || 15;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(ANGLE[dir]);
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.87, s * 0.72);
  ctx.lineTo(-s * 0.87, s * 0.72);
  ctx.closePath();
  ctx.fillStyle = filled ? color : '#ffffff';
  ctx.fill();
  ctx.lineWidth = Math.max(2, s * 0.2);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}
function drawMarkerImage(ctx, img, pos, dir, size) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(ANGLE[dir]);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
  ctx.restore();
}

function drawGrid(ctx, w, h) {
  ctx.fillStyle = '#e7eaf0';
  for (let y = 16; y < h; y += 30) {
    for (let x = 16; x < w; x += 30) ctx.fillRect(x, y, 1.5, 1.5);
  }
}

function drawRoad(ctx) {
  strokeRoad(ctx, state.pathNodes);
  // 分岔支路：只有分叉，没有汇入，尽头为死路
  for (const br of state.branches) strokeRoad(ctx, br.points);
}

function strokeRoad(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.lineWidth = 46;
  ctx.strokeStyle = assets.roadBorder
    ? (ctx.createPattern(assets.roadBorder, 'repeat') || '#aeb8ca')
    : '#aeb8ca';
  ctx.stroke();

  ctx.lineWidth = 36;
  ctx.strokeStyle = assets.roadFill
    ? (ctx.createPattern(assets.roadFill, 'repeat') || '#dde3ef')
    : '#dde3ef';
  ctx.stroke();

  ctx.setLineDash([9, 13]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#c1cada';
  ctx.stroke();
  ctx.setLineDash([]);
}

// 长按的起始三角、虚线、结束三角统一取色；命中后一起变绿
function markerColor(note) {
  if (note.state === 'hit') return '#2f9e7c';
  return note.type === 'hold' ? '#df8b3d' : '#4f6bd8';
}

function drawMarkers(ctx, w, h) {
  for (const n of state.notes) {
    const dx = n.pos.x - state.camera.x, dy = n.pos.y - state.camera.y;
    if (Math.abs(dx) > w * 1.2 || Math.abs(dy) > h * 1.2) continue;

    let alpha = 1;
    if (n.state === 'miss') alpha = 0.25;
    if (n.state === 'hit') alpha = Math.max(0, 1 - (state.t - n.time) / 0.7);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    // 起始三角与结束三角共用同一颜色，保证视觉一致
    const color = markerColor(n);

    if (n.type === 'hold') {
      ctx.save();
      ctx.setLineDash([9, 8]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(n.pos.x, n.pos.y);
      ctx.lineTo(n.endPos.x, n.endPos.y);
      ctx.stroke();
      ctx.restore();

      if (assets.markerHold) {
        drawMarkerImage(ctx, assets.markerHold, n.endPos, n.dir, 32);
      } else {
        drawTriangle(ctx, n.endPos, n.dir, false, color, 15);
      }
    }

    const img = n.type === 'hold' ? assets.markerHold : assets.markerTap;
    if (img) drawMarkerImage(ctx, img, n.pos, n.dir, 34);
    else drawTriangle(ctx, n.pos, n.dir, true, color, 15);
  }
  ctx.globalAlpha = 1;
}

function drawCharacter(ctx) {
  ctx.save();
  ctx.translate(state.charPos.x, state.charPos.y);
  ctx.beginPath();
  ctx.ellipse(0, 12, 15, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34,42,60,.10)';
  ctx.fill();
  ctx.rotate(ANGLE[state.facing]);

  if (assets.character) {
    ctx.drawImage(assets.character, -23, -25, 46, 50);
    ctx.restore();
    return;
  }

  const bob = state.moveDur > 0 ? Math.sin(state.t * 15) * 1.8 : 0;
  ctx.translate(0, bob);
  ctx.strokeStyle = '#26304a';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.arc(0, -18, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -11); ctx.lineTo(0, 8);          // 躯干
  ctx.moveTo(-10, -3); ctx.lineTo(0, -7); ctx.lineTo(10, -3);  // 手臂
  ctx.moveTo(0, 8); ctx.lineTo(-8, 19);          // 左腿
  ctx.moveTo(0, 8); ctx.lineTo(8, 19);           // 右腿
  ctx.stroke();
  ctx.restore();
}

function drawFx(ctx) {
  state.fx = state.fx.filter(f => state.t - f.t0 < 0.65);
  for (const f of state.fx) {
    const age = state.t - f.t0;
    const p = age / 0.65;
    const color = f.label === 'PERFECT' ? '#2f9e7c'
      : f.label === 'GOOD' ? '#4f6bd8'
      : f.label === 'WRONG' ? '#8d95a6' : '#d15454';
    const isMiss = f.label === 'MISS' || f.label === 'BREAK';
    ctx.globalAlpha = 1 - p;
    ctx.strokeStyle = color;
    ctx.lineWidth = isMiss ? 2.5 : 2;
    if (isMiss) ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(f.pos.x, f.pos.y, 16 + age * 95, 0, Math.PI * 2);
    ctx.stroke();
    if (isMiss) ctx.setLineDash([]);

    const tx = f.pos.x + 20;
    const ty = f.pos.y - 16 - age * (isMiss ? 32 : 22);
    ctx.font = `bold ${isMiss ? 15 : 13}px Consolas, monospace`;
    if (isMiss) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.strokeText(f.label, tx, ty);
    }
    ctx.fillStyle = color;
    ctx.fillText(f.label, tx, ty);
  }
  ctx.globalAlpha = 1;
}

function drawWorldLabels(ctx, w) {
  const next = state.notes.find(n => n.state === 'pending' || n.state === 'active');
  const dirText = DIRS[state.facing].glyph + ' ' + DIRS[state.facing].label;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(w - 186, 14, 172, 52);
  ctx.strokeStyle = '#dfe3ea';
  ctx.lineWidth = 1;
  ctx.strokeRect(w - 186, 14, 172, 52);
  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = '#788298';
  ctx.fillText('CURRENT DIR', w - 176, 31);
  ctx.font = 'bold 17px Consolas, monospace';
  ctx.fillStyle = '#4f6bd8';
  ctx.fillText(dirText, w - 176, 54);
  if (next && state.mode === 'playing') {
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = '#788298';
    const beats = Math.max(0, next.time - state.t) / state.beatDur;
    ctx.fillText(`NEXT ${DIRS[next.dir].glyph}  ${beats.toFixed(1)} 拍`, w - 108, 31);
  }

  if (state.mode === 'playing' && state.t < LEAD_BEATS * state.beatDur) {
    const count = Math.ceil(LEAD_BEATS - state.t / state.beatDur);
    ctx.font = 'bold 64px Consolas, monospace';
    ctx.fillStyle = 'rgba(79,107,216,.42)';
    ctx.textAlign = 'center';
    ctx.fillText(String(count), w / 2, state.view.h / 2 + 20);
    ctx.textAlign = 'left';
  }
}

function renderWorld() {
  const { ctx, w, h } = state.view;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fafaf8';
  ctx.fillRect(0, 0, w, h);
  if (assets.bg) {
    const pat = ctx.createPattern(assets.bg, 'repeat');
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); }
  } else {
    drawGrid(ctx, w, h);
  }

  ctx.save();
  ctx.translate(w / 2 - state.camera.x, h / 2 - state.camera.y);
  drawRoad(ctx);
  drawMarkers(ctx, w, h);
  drawCharacter(ctx);
  drawFx(ctx);
  ctx.restore();
  drawWorldLabels(ctx, w);
}

function drawSmallTriangle(ctx, x, y, dir, filled, color) {
  drawTriangle(ctx, { x, y }, dir, filled, color, 9);
}

function renderRail() {
  const { ctx, w, h } = state.railView;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fbfcfd';
  ctx.fillRect(0, 0, w, h);

  const judgeX = 96;
  const top = 20, bottom = h - 12;
  const pxPerSec = 250;
  const t = state.t;

  ctx.fillStyle = '#f2f4f8';
  ctx.fillRect(0, top, w, bottom - top);

  const firstBeat = Math.floor((t - 1) / state.beatDur);
  const lastBeat = Math.ceil((t + (w - judgeX) / pxPerSec) / state.beatDur);
  for (let b = firstBeat; b <= lastBeat; b++) {
    const x = judgeX + ((b + LEAD_BEATS) * state.beatDur - t) * pxPerSec;
    if (x < 0 || x > w) continue;
    ctx.strokeStyle = b % 4 === 0 ? '#cbd2df' : '#e5e8ee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  for (const n of state.notes) {
    if (n.state === 'hit' || n.state === 'miss') continue;
    const x = judgeX + (n.time - t) * pxPerSec;
    const xe = judgeX + (n.endTime - t) * pxPerSec;
    if (x > w + 30 || xe < -30) continue;
    const color = markerColor(n);
    const y = (top + bottom) / 2;
    if (n.type === 'hold') {
      ctx.save();
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(clamp(x, -30, w + 30), y);
      ctx.lineTo(clamp(xe, -30, w + 30), y);
      ctx.stroke();
      ctx.restore();
      drawSmallTriangle(ctx, clamp(xe, -30, w + 30), y, n.dir, false, color);
    }
    drawSmallTriangle(ctx, clamp(x, -30, w + 30), y, n.dir, true, color);
  }

  ctx.strokeStyle = '#4f6bd8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(judgeX, top - 6); ctx.lineTo(judgeX, bottom + 4);
  ctx.stroke();
  ctx.fillStyle = '#4f6bd8';
  ctx.font = '9px Consolas, monospace';
  ctx.fillText('HIT', judgeX - 10, 13);
}

/* -------------------------------------------------------------- 主循环 */
function frame(ts) {
  update();
  renderWorld();
  if (!dom.railWrap.classList.contains('hidden')) renderRail();
  state.lastRAF = ts;
  requestAnimationFrame(frame);
}

/* -------------------------------------------------------------- UI 绑定 */
function refreshWindows() {
  const step = SUBDIV[dom.subdiv.value].beats * (60 / Number(dom.bpm.value));
  dom.perfectWindow.textContent = '±' + Math.round(Math.min(0.09, step * 0.22) * 1000) + ' ms';
  dom.goodWindow.textContent = '±' + Math.round(Math.min(0.19, step * 0.45) * 1000) + ' ms';
}
function syncSettings() {
  state.bpm = Number(dom.bpm.value);
  state.subdiv = dom.subdiv.value;
  state.holdChance = Number(dom.holdChance.value);
  state.keyScheme = dom.keyScheme.value;
  state.forksEnabled = dom.forks.checked;
  state.sound = dom.sound.checked;
  state.turnBars = [...dom.turnBars.querySelectorAll('.chip.active')]
    .map(el => Number(el.dataset.bars));
  dom.bpmValue.textContent = state.bpm;
  dom.holdValue.textContent = state.holdChance + '%';
  refreshWindows();
}

dom.bpm.addEventListener('input', syncSettings);
dom.subdiv.addEventListener('change', syncSettings);
dom.holdChance.addEventListener('input', syncSettings);
dom.keyScheme.addEventListener('change', syncSettings);
dom.forks.addEventListener('change', syncSettings);
dom.sound.addEventListener('change', syncSettings);
dom.turnBars.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.classList.contains('active') && dom.turnBars.querySelectorAll('.chip.active').length === 1) return;
  chip.classList.toggle('active');
  syncSettings();
});
dom.showRail.addEventListener('change', () => {
  dom.railWrap.classList.toggle('hidden', !dom.showRail.checked);
  resize();
});
dom.startBtn.addEventListener('click', startGame);
dom.overlayBtn.addEventListener('click', startGame);
dom.pauseBtn.addEventListener('click', () => {
  if (state.mode === 'idle' || state.mode === 'done') return;
  togglePause();
});
window.addEventListener('resize', resize);

/* -------------------------------------------------------------- 启动 */
loadAssets();
syncSettings();
resize();
requestAnimationFrame(frame);
