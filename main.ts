// Room-by-room push-optimal Sokoban solver.
//
// The levels this competition draws are a hallway with small rooms off it
// (three or four boxes each), and a box pushed out of a room can never come
// back, so each room is an independent problem and the level's optimum is
// the sum of the rooms' optima. This program splits the level into rooms,
// solves every room with a breadth-first search over pushes (the first
// solved state a BFS meets is push-optimal), and walks the player from room
// to room. Two prunings keep the search small: a box on a square from which
// no pull-back reaches a goal is dead, and a box in a frozen 2x2 block of
// walls and boxes is dead. A state is the boxes' squares plus the player's
// reachable region, named by its lowest square, so walking never multiplies
// states. Everything is budgeted by states expanded, never by the clock,
// and the move order is fixed, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Steps: [dx, dy, letter]. Fixed order, so the search is deterministic.
const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];
// States one room search keeps before it gives up, first pass and retry.
const FIRST_PASS = 250_000;
const SECOND_PASS = 1_000_000;

/** A level: width, height, walls (1), goals, boxes and the player's square. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The live squares: a square is live when a box standing on it can still be
 * pushed onto some goal. Computed by pulling back from the goals: a square y
 * is live when some live square x sits one step beyond it (y = x - d) and the
 * square past y (y - d) is open floor for the player to stand on.
 */
function liveSquares(w, h, wall, goals) {
  const live = new Uint8Array(w * h);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= w * h || y - d < 0 || y - d >= w * h) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill from `from` over open floor with `occupied` in the way, marking
 * `seen` with `stamp`. Returns the lowest square reached (the region's name).
 * `stack` is a scratch array of board size.
 */
function flood(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(w, wall, occupied, goal, t) {
  const at = (i) => i < 0 || i >= wall.length || wall[i] === 1 || occupied[i] === 1;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!at(a) || !at(b) || !at(c) || !at(d)) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in LURD letters. Throws when unreachable. */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates` states:
 * { pushes, moves } (moves in LURD, lower case), or null when the search gives
 * up. Breadth-first over pushes: states in the order found, each holding its
 * boxes, the player's square after the push that made it, its parent and the
 * push itself. A state's key is its region's lowest square and its boxes.
 */
function solvePushOptimal(level, maxStates) {
  const { w, h, wall, goals } = level;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, h, wall, goals);
  if (level.boxes.some((b) => !live[b])) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size); // this state's region
  const mark = new Int32Array(size); // a successor state's region
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs) => bs.every((b) => goal[b]);
  // Numeric keys while size ** (boxes + 1) stays exact, string keys past that.
  const numeric = Math.pow(size, level.boxes.length + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs, low) => {
    if (!numeric) return `${low}|${bs.join(',')}`;
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  const qBoxes = [level.boxes.slice()];
  const qPlayer = [level.player];
  const qParent = [-1];
  const qPush = [null];
  const index = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, flood(w, wall, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;
  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < qBoxes.length; head++) {
    const bs = qBoxes[head];
    for (const b of bs) occupied[b] = 1;
    const here = ++stamp;
    flood(w, wall, occupied, qPlayer[head], seen, here, stack);
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const d = dy * w + dx;
        const t = b + d;
        const s = b - d;
        if (s < 0 || s >= size || t < 0 || t >= size) continue;
        if (seen[s] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let key = -1;
        let next = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, flood(w, wall, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (qBoxes.length >= maxStates) {
          for (const x of bs) occupied[x] = 0;
          return null;
        }
        index.set(key, qBoxes.length);
        qBoxes.push(next);
        qPlayer.push(b);
        qParent.push(head);
        qPush.push([b, t]);
        if (solved(next)) {
          found = qBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of bs) occupied[x] = 0;
  }
  if (found < 0) return null;
  const path = [];
  for (let s = found; s > 0; s = qParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let cur = level.boxes.slice();
  for (const s of path) {
    const [from, to] = qPush[s];
    const d = to - from;
    const k = DIRS.findIndex(([dx, dy]) => dy * w + dx === d);
    for (const b of cur) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of cur) occupied[b] = 0;
    moves += DIRS[k][2];
    player = from;
    cur = qBoxes[s];
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the player's row where a box reaches no goal (the
 * hallway) out of the floor, and each part left that holds boxes is a room.
 * Null when a box starts in the hallway, or some part's boxes and goals do
 * not match: then the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, h, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= w * h) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * One level's moves: room by room, each room solved push-optimally, the
 * other rooms' boxes standing as walls. The player walks on from where the
 * last room left it. A room the BFS gives up on is retried with a bigger
 * budget; a room no search solves leaves the level unanswered.
 */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushOptimal(level, FIRST_PASS) ?? solvePushOptimal(level, SECOND_PASS);
    return whole ? whole.moves : '';
  }
  let player = level.player;
  let moves = '';
  const currentBoxes = rooms.map((r) => r.boxes.slice());
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of currentBoxes[oj]) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved =
      solvePushOptimal(sub, FIRST_PASS) ?? solvePushOptimal(sub, SECOND_PASS);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    currentBoxes[ri] = room.goals.slice();
  }
  return moves;
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
