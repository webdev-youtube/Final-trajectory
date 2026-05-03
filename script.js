// ============================================================
// TURRET // DEFENSE  -  Full Roguelite Engine
// ============================================================

'use strict';

// ─── SEEDED RNG ──────────────────────────────────────────────
class SeededRNG {
  constructor(seed) {
    this.seed = this.hashSeed(String(seed));
    this.state = this.seed;
  }
  hashSeed(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0) || 1;
  }
  next() {
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return ((this.state >>> 0) / 4294967296);
  }
  range(min, max) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ─── SAVE / LOAD ─────────────────────────────────────────────
const Save = {
  defaults() {
    return {
      currency: 0,
      permUpgrades: {},
      bestScore: 0,
      bestTime: 0,
      lifetimeKills: 0,
      bestShot: 0,
    };
  },
  load() {
    try {
      const raw = localStorage.getItem('tdrogue_v1');
      if (!raw) return this.defaults();
      return Object.assign(this.defaults(), JSON.parse(raw));
    } catch { return this.defaults(); }
  },
  save(data) {
    try { localStorage.setItem('tdrogue_v1', JSON.stringify(data)); } catch {}
  },
  reset() {
    try { localStorage.removeItem('tdrogue_v1'); } catch {}
  }
};

// ─── CONSTANTS ───────────────────────────────────────────────
const C = {
  BASE_RELOAD: 1200,
  MIN_RELOAD: 300,
  BASE_DAMAGE: 1,
  BASE_SPEED: 280,
  BASE_LIFETIME: 3.2,
  BASE_PIERCE: 1,
  BULLET_RADIUS: 5,
  TURRET_RADIUS: 18,
  MAX_BULLETS: 25,
  MAX_PARTICLES: 180,
  TURRET_HP: 10,
  SLOW_FACTOR: 0.78,
  ARENA_PADDING: 12,
  KILL_BAR_MAX: 20,
  SPAWN_BASE_INTERVAL: 2400,
  BOSS_FIRST: 9999999,      // never time-based — see updateBossTimers
  BOSS_MIN_TIME: 90,        // must survive at least 90s before first boss
  BOSS_INTERVAL_FIRST: 30,  // countdown for first boss once conditions met
  BOSS_INTERVAL: 30,        // 30s between bosses after first
  SCORE_DRONE: 10,
  SCORE_RUNNER: 12,
  SCORE_TANK: 30,
  SCORE_SPLITTER: 20,
  SCORE_ZIGZAG: 15,
  SCORE_ORBITER: 18,
  SCORE_BOSS: 200,
  CURRENCY_DRONE: 1,
  CURRENCY_RUNNER: 1,
  CURRENCY_TANK: 3,
  CURRENCY_SPLITTER: 2,
  CURRENCY_ZIGZAG: 2,
  CURRENCY_ORBITER: 2,
  CURRENCY_BOSS: 25,
};

// ─── GAME STATE ──────────────────────────────────────────────
const GS = {
  state: 'MENU',   // MENU | RUNNING | PAUSED | UPGRADE_SELECTION | GAME_OVER
  prevState: 'MENU',
  rng: null,
  seed: '',

  // run vars
  score: 0,
  currency: 0,
  hp: C.TURRET_HP,
  maxHp: C.TURRET_HP,
  time: 0,
  kills: 0,
  runKills: 0,
  killBar: 0,
  bestShotRun: 0,
  comboCount: 0,

  // timing
  lastTime: 0,
  dt: 0,
  timeScale: 1,
  slowTimer: 0,

  // shooting
  reloadTimer: 0,
  canShoot: true,

  // input
  mouse: { x: 0, y: 0 },
  aiming: false,
  aimStart: { x: 0, y: 0 },
  aimEnd: { x: 0, y: 0 },

  // boss
  nextBossTime: C.BOSS_FIRST,
  bossIntervalCurrent: C.BOSS_INTERVAL_START,
  bossCount: 0,
  activeBoss: null,

  // upgrades in run
  runUpgrades: {},  // upgrade_id -> level
  permData: null,

  // canvas
  canvas: null,
  ctx: null,
  W: 0, H: 0,
  arenaX: 0, arenaY: 0, arenaW: 0, arenaH: 0,
  cx: 0, cy: 0,

  // entity pools
  bullets: [],
  enemies: [],
  particles: [],
  floatingTexts: [],

  // effects
  shakeIntensity: 0,
  shakeTimer: 0,
  globalGlow: 0,
};

// ─── PERMANENT UPGRADES DEFINITION ───────────────────────────
const PERM_UPGRADES = [
  { id: 'damage',     name: 'Damage',         cat: 'COMBAT',  max: 10, costBase: 20,  desc: '+10% damage per level',       apply(gs, lvl) { gs._pDamage = 1 + lvl * 0.1; } },
  { id: 'crit',       name: 'Crit Chance',    cat: 'COMBAT',  max: 10, costBase: 25,  desc: '+5% crit chance (max 95%)',   apply(gs, lvl) { gs._pCrit = Math.min(0.95, lvl * 0.05); } },
  { id: 'critMul',    name: 'Crit Power',     cat: 'COMBAT',  max: 8,  costBase: 30,  desc: '+0.25x crit multiplier',      apply(gs, lvl) { gs._pCritMul = 1.5 + lvl * 0.25; } },
  { id: 'lifetime',   name: 'Bullet Life',    cat: 'UTILITY', max: 6,  costBase: 20,  desc: '+0.5s bullet lifetime',       apply(gs, lvl) { gs._pLifetime = C.BASE_LIFETIME + lvl * 0.5; } },
  { id: 'speed',      name: 'Bullet Speed',   cat: 'UTILITY', max: 8,  costBase: 18,  desc: '+15% bullet speed',           apply(gs, lvl) { gs._pSpeed = C.BASE_SPEED * (1 + lvl * 0.15); } },
  { id: 'cooldown',   name: 'Fire Rate',      cat: 'UTILITY', max: 9,  costBase: 22,  desc: '-10% reload time',            apply(gs, lvl) { gs._pReload = Math.max(C.MIN_RELOAD, C.BASE_RELOAD * Math.pow(0.9, lvl)); } },
  { id: 'maxhp',      name: 'Max HP',         cat: 'UTILITY', max: 5,  costBase: 35,  desc: '+2 max turret HP',            apply(gs, lvl) { gs._pMaxHp = C.TURRET_HP + lvl * 2; } },
  { id: 'luck',       name: 'Luck',           cat: 'SCALING', max: 5,  costBase: 40,  desc: '+15% upgrade drop rate',      apply(gs, lvl) { gs._pLuck = 1 + lvl * 0.15; } },
  { id: 'economy',    name: 'Economy',        cat: 'SCALING', max: 5,  costBase: 30,  desc: '+25% currency per kill',      apply(gs, lvl) { gs._pEconomy = 1 + lvl * 0.25; } },
  { id: 'barspeed',   name: 'Bar Speed',      cat: 'SCALING', max: 5,  costBase: 25,  desc: '+20% kill bar speed',         apply(gs, lvl) { gs._pBarSpeed = 1 + lvl * 0.20; } },
];

// ─── IN-RUN UPGRADES DEFINITION ──────────────────────────────
const RUN_UPGRADES = [
  {
    id: 'bounce', name: 'Bounce', icon: '↯',
    levels: [
      { rarity: 'common',    stat: '+1 Bounce',      desc: 'Bullets reflect off walls once.' },
      { rarity: 'common',    stat: '+2 Bounces',     desc: 'Bullets reflect twice.' },
      { rarity: 'rare',      stat: '+3 Bounces',     desc: 'Bullets gain slight homing after bouncing.' },
      { rarity: 'legendary', stat: '+4 Bounces',     desc: 'Bullets ricochet off enemies on kill.' },
    ]
  },
  {
    id: 'split', name: 'Split', icon: '⊹',
    levels: [
      { rarity: 'common',    stat: 'Split x2',       desc: 'Bullet splits into 2 on expiry.' },
      { rarity: 'common',    stat: 'Split x3',       desc: 'Splits into 3 copies.' },
      { rarity: 'rare',      stat: 'Split x4',       desc: 'Splits into 4 copies.' },
      { rarity: 'legendary', stat: 'Split x5',       desc: 'Splits into 5 copies.' },
    ]
  },
  {
    id: 'chain', name: 'Chain Lightning', icon: '⚡',
    levels: [
      { rarity: 'rare',      stat: 'Chain 3',        desc: 'Hits arc to 3 nearby enemies.' },
      { rarity: 'rare',      stat: 'Chain 5',        desc: 'Arcs to 5 enemies, wider radius.' },
      { rarity: 'legendary', stat: 'Chain 8',        desc: 'Arcs to 8 enemies, full damage.' },
    ]
  },
  {
    id: 'kb', name: 'Kinetic Burst', icon: '💥',
    levels: [
      { rarity: 'common',    stat: 'Burst r40',      desc: 'Explosion on bullet death.' },
      { rarity: 'rare',      stat: 'Burst r70',      desc: 'Larger explosion radius.' },
      { rarity: 'legendary', stat: 'Burst r100',     desc: 'Massive explosion + periodic blasts.' },
    ]
  },
  {
    id: 'pierce', name: 'Pierce', icon: '▶▶',
    levels: [
      { rarity: 'common',    stat: '+1 Pierce',      desc: 'Bullet passes through 1 extra enemy.' },
      { rarity: 'common',    stat: '+2 Pierce',      desc: 'Passes through 2 extra enemies.' },
      { rarity: 'rare',      stat: '+4 Pierce',      desc: 'High pierce count.' },
      { rarity: 'legendary', stat: '∞ Pierce',       desc: 'Unlimited pierce.' },
    ]
  },
  {
    id: 'multishoot', name: 'Multishot', icon: '⫸',
    levels: [
      { rarity: 'rare',      stat: '2 bullets',      desc: 'Fire 2 bullets per shot.' },
      { rarity: 'rare',      stat: '3 bullets',      desc: 'Fire 3 bullets per shot.' },
      { rarity: 'legendary', stat: '5 bullets',      desc: 'Fire 5 bullets in spread.' },
    ]
  },
];

// ─── OBJECT POOLS ────────────────────────────────────────────
class Pool {
  constructor(factory, reset) {
    this.factory = factory;
    this.reset = reset;
    this.pool = [];
  }
  get(args) {
    const obj = this.pool.pop() || this.factory();
    this.reset(obj, args);
    obj.active = true;
    return obj;
  }
  release(obj) {
    obj.active = false;
    this.pool.push(obj);
  }
}

// ─── MATH HELPERS ────────────────────────────────────────────
const M = {
  dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); },
  norm(vx, vy) { const l = Math.hypot(vx, vy) || 1; return [vx / l, vy / l]; },
  lerp(a, b, t) { return a + (b - a) * t; },
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
  angle(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); },
};

// ─── BULLET ──────────────────────────────────────────────────
function makeBullet() {
  return {
    active: false, x: 0, y: 0, vx: 0, vy: 0,
    radius: C.BULLET_RADIUS, damage: 1, pierceLeft: 1,
    lifetime: 0, maxLifetime: 3.2, speed: C.BASE_SPEED,
    trail: [],
    canBounce: false, bounceCount: 0, bounceLeft: 0, homingAfterBounce: false, enemyRicochet: false,
    canSplit: false, splitCount: 0,
    chainCount: 0, chainRadius: 0,
    kbRadius: 0, kbPeriodic: false, kbTimer: 0,
    crit: false,
    fromSplit: false,
    hitEnemies: null,  // set of enemy ids hit this frame
    currentCombo: 0,
  };
}

const bulletPool = new Pool(makeBullet, (b, args) => {
  Object.assign(b, {
    x: args.x, y: args.y, vx: args.vx, vy: args.vy,
    radius: C.BULLET_RADIUS, damage: args.damage || 1,
    pierceLeft: args.pierceLeft || 1,
    lifetime: 0, maxLifetime: args.maxLifetime || C.BASE_LIFETIME,
    trail: [],
    canBounce: args.canBounce || false,
    bounceCount: args.bounceCount || 0,
    bounceLeft: args.bounceLeft || 0,
    homingAfterBounce: args.homingAfterBounce || false,
    enemyRicochet: args.enemyRicochet || false,
    canSplit: args.canSplit || false,
    splitCount: args.splitCount || 0,
    chainCount: args.chainCount || 0,
    chainRadius: args.chainRadius || 0,
    kbRadius: args.kbRadius || 0,
    kbPeriodic: args.kbPeriodic || false,
    kbTimer: 0,
    crit: args.crit || false,
    fromSplit: args.fromSplit || false,
    hitEnemies: new Set(),
    currentCombo: 0,
  });
});

// ─── PARTICLE ────────────────────────────────────────────────
function makeParticle() {
  return { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0.4, r: 2, color: '#fff', type: 'dot' };
}

const particlePool = new Pool(makeParticle, (p, args) => {
  Object.assign(p, { active: true, x: args.x, y: args.y, vx: args.vx || 0, vy: args.vy || 0,
    life: 0, maxLife: args.maxLife || 0.4, r: args.r || 2, color: args.color || '#fff', type: args.type || 'dot' });
});

// ─── ENEMY BASE ───────────────────────────────────────────────
let _enemyId = 0;
function makeEnemy() {
  return { active: false, id: 0, x: 0, y: 0, vx: 0, vy: 0, hp: 1, maxHp: 1, speed: 60, radius: 12,
    type: 'drone', phase: 0, angle: 0, orbitAngle: 0, zigDir: 1, zigTimer: 0,
    flashTimer: 0, deathFlag: false, boss: false, bossPhase: 0, shieldTimer: 0,
    shieldActive: false, phaseTimer: 0, phased: false, spawnChildren: null,
    orbitRadius: 0, pulseTimer: 0, reflectTimer: 0, cracksLevel: 0,
    slowMod: 1, slowTimer: 0,
  };
}

const enemyPool = new Pool(makeEnemy, (e, args) => {
  _enemyId++;
  Object.assign(e, {
    active: true, id: _enemyId, x: args.x, y: args.y, vx: 0, vy: 0,
    hp: args.hp || 1, maxHp: args.hp || 1,
    speed: args.speed || 60, radius: args.radius || 12,
    type: args.type || 'drone', phase: 0, angle: 0, orbitAngle: args.orbitAngle || 0,
    zigDir: 1, zigTimer: 0,
    flashTimer: 0, deathFlag: false,
    boss: args.boss || false, bossPhase: 0,
    shieldTimer: 0, shieldActive: false,
    phaseTimer: 0, phased: false,
    spawnChildren: null,
    orbitRadius: args.orbitRadius || 0,
    pulseTimer: 0, reflectTimer: 0, cracksLevel: 0,
    slowMod: 1, slowTimer: 0,
    splitDone: false,
  });
});

// ─── SPAWNING LOGIC ──────────────────────────────────────────
const ENEMY_TYPES = ['drone', 'runner', 'tank', 'splitter', 'zigzag', 'orbiter'];
const ENEMY_UNLOCK_TIMES = { drone: 0, runner: 20, tank: 30, splitter: 50, zigzag: 80, orbiter: 100 };

function spawnEnemy(type, gs) {
  const pad = 30;
  const side = gs.rng.int(0, 3);
  let x, y;
  const t = gs.time;

  // spawn distance: edges only, no push-in. cleaner and more readable
  if (side === 0) { x = gs.rng.range(gs.arenaX + pad, gs.arenaX + gs.arenaW - pad); y = gs.arenaY + pad; }
  else if (side === 1) { x = gs.arenaX + gs.arenaW - pad; y = gs.rng.range(gs.arenaY + pad, gs.arenaY + gs.arenaH - pad); }
  else if (side === 2) { x = gs.rng.range(gs.arenaX + pad, gs.arenaX + gs.arenaW - pad); y = gs.arenaY + gs.arenaH - pad; }
  else { x = gs.arenaX + pad; y = gs.rng.range(gs.arenaY + pad, gs.arenaY + gs.arenaH - pad); }

  // smooth speed scale: linear, clamped — max +55% at 5 min
  const speedScale = 1 + Math.min(0.55, t * 0.00183);

  // hp scale: integer steps, slow — every 2 min add 1 hp to elites
  const hpBonus = Math.floor(t / 120);

  const configs = {
    drone:    { hp: 1,   speed: 52 * speedScale,  radius: 11, type: 'drone' },
    runner:   { hp: 1,   speed: 105 * speedScale, radius: 9,  type: 'runner' },
    tank:     { hp: Math.min(8, 3 + hpBonus + gs.rng.int(0, 2)), speed: 30 * speedScale, radius: 17, type: 'tank' },
    splitter: { hp: 2,   speed: 56 * speedScale,  radius: 13, type: 'splitter' },
    zigzag:   { hp: gs.rng.int(1, 2), speed: 60 * speedScale, radius: 11, type: 'zigzag' },
    orbiter:  { hp: gs.rng.int(1, 2), speed: 40 * speedScale, radius: 10, type: 'orbiter',
                orbitAngle: gs.rng.range(0, Math.PI * 2),
                orbitRadius: gs.rng.range(100, 160) },
  };

  const cfg = configs[type] || configs.drone;
  return enemyPool.get({ ...cfg, x, y });
}

function spawnSplitterChild(parent, gs, idx) {
  const angle = idx === 0 ? Math.PI * 0.7 : Math.PI * 1.3;
  const dx = Math.cos(angle) * 20;
  const dy = Math.sin(angle) * 20;
  const e = enemyPool.get({ hp: 1, speed: parent.speed * 1.1, radius: 8, type: 'drone', x: parent.x + dx, y: parent.y + dy });
  return e;
}

// ─── BOSS CONFIGS ────────────────────────────────────────────
const BOSS_CONFIGS = [
  {
    id: 0, name: 'CORE BREAKER', hp: 80, speed: 35, radius: 34,
    desc: 'Periodic shield. Time your shots.',
    type: 'boss_corebreaker'
  },
  {
    id: 1, name: 'SPLIT MONARCH', hp: 60, speed: 42, radius: 30,
    desc: 'Splits at HP thresholds.',
    type: 'boss_splitmonarch'
  },
  {
    id: 2, name: 'PULSE ENTITY', hp: 70, speed: 30, radius: 28,
    desc: 'Emits deflecting pulses.',
    type: 'boss_pulseentity'
  },
  {
    id: 3, name: 'SWARM CORE', hp: 90, speed: 28, radius: 32,
    desc: 'Protected by orbiting shields.',
    type: 'boss_swarmcore'
  },
  {
    id: 4, name: 'PHANTOM GLIDE', hp: 65, speed: 55, radius: 26,
    desc: 'Phases out periodically.',
    type: 'boss_phantom'
  },
  {
    id: 5, name: 'GRAVITY WELL', hp: 75, speed: 25, radius: 30,
    desc: 'Pulls bullets toward it.',
    type: 'boss_gravitywell'
  },
  {
    id: 6, name: 'RICOCHET BEAST', hp: 70, speed: 45, radius: 28,
    desc: 'Reflects bullets back at you.',
    type: 'boss_ricochet'
  },
  {
    id: 7, name: 'SPLITTER QUEEN', hp: 85, speed: 30, radius: 32,
    desc: 'Constantly spawns minions.',
    type: 'boss_splitterqueen'
  },
  {
    id: 8, name: 'TIME LEECH', hp: 60, speed: 50, radius: 24,
    desc: 'Slows bullets on each hit.',
    type: 'boss_timeleech'
  },
  {
    id: 9, name: 'DOOMSDAY CORE', hp: 100, speed: 38, radius: 36,
    desc: 'Rushes you. Gets faster at low HP.',
    type: 'boss_doomsday'
  },
];

function spawnBoss(gs) {
  const idx = gs.bossCount % BOSS_CONFIGS.length;
  const cfg = BOSS_CONFIGS[idx];
  const hpScale = 1 + gs.bossCount * 0.15;
  const e = enemyPool.get({
    hp: Math.floor(cfg.hp * hpScale),
    speed: cfg.speed,
    radius: cfg.radius,
    type: cfg.type,
    x: gs.cx,
    y: gs.arenaY + cfg.radius + 20,
    boss: true,
  });
  e.bossId = cfg.id;
  e.bossName = cfg.name;
  e.shieldTimer = 0;
  e.shieldActive = false;
  e.phased = false;
  e.phaseTimer = 0;
  e.pulseTimer = 0;
  e.reflectTimer = 0;
  e.splitDone = false;
  e.splitDone2 = false;
  e.cracksLevel = 0;
  e.orbitRadius = 0;
  e.spawnTimer = 0;
  return e;
}

// ─── SHOOT ───────────────────────────────────────────────────
function getEffectiveBulletProps(gs) {
  const pd = gs.permData;
  const ru = gs.runUpgrades;

  let damage = (gs._pDamage || 1);
  const critRoll = (gs.rng.next() < (gs._pCrit || 0));
  if (critRoll) damage *= (gs._pCritMul || 1.5);

  let speed = gs._pSpeed || C.BASE_SPEED;
  let lifetime = gs._pLifetime || C.BASE_LIFETIME;
  let bounceLeft = 0;
  let homingAfterBounce = false;
  let enemyRicochet = false;
  let splitCount = 0;
  let chainCount = 0;
  let chainRadius = 0;
  let kbRadius = 0;
  let kbPeriodic = false;
  let pierce = C.BASE_PIERCE;

  const bounceLvl = ru.bounce || 0;
  if (bounceLvl >= 1) bounceLeft = bounceLvl;
  if (bounceLvl >= 3) homingAfterBounce = true;
  if (bounceLvl >= 4) enemyRicochet = true;

  const splitLvl = ru.split || 0;
  if (splitLvl >= 1) splitCount = splitLvl + 1;

  const chainLvl = ru.chain || 0;
  if (chainLvl >= 1) { chainCount = [3, 5, 8][chainLvl - 1]; chainRadius = [100, 130, 160][chainLvl - 1]; }

  const kbLvl = ru.kb || 0;
  if (kbLvl >= 1) { kbRadius = [40, 70, 100][kbLvl - 1]; kbPeriodic = kbLvl >= 3; }

  const pierceLvl = ru.pierce || 0;
  if (pierceLvl >= 4) pierce = 999;
  else if (pierceLvl >= 1) pierce = [2, 3, 5][pierceLvl - 1];

  const multiLvl = ru.multishoot || 0;
  const multiCount = multiLvl >= 3 ? 5 : multiLvl >= 2 ? 3 : multiLvl >= 1 ? 2 : 1;

  return { damage, crit: critRoll, speed, lifetime, bounceLeft, homingAfterBounce, enemyRicochet,
    splitCount, chainCount, chainRadius, kbRadius, kbPeriodic, pierce, multiCount };
}

function fireBullet(gs, angle) {
  if (!gs.canShoot) return;
  const activeBullets = gs.bullets.filter(b => b.active).length;
  if (activeBullets >= C.MAX_BULLETS) return;

  const props = getEffectiveBulletProps(gs);
  const count = props.multiCount;
  const spread = count > 1 ? 0.08 : 0;

  let spawned = 0;
  for (let i = 0; i < count; i++) {
    if (activeBullets + spawned >= C.MAX_BULLETS) break;
    const aOff = (i - (count - 1) / 2) * spread;
    const a = angle + aOff;
    const b = bulletPool.get({
      x: gs.cx, y: gs.cy,
      vx: Math.cos(a) * props.speed, vy: Math.sin(a) * props.speed,
      damage: props.damage, crit: props.crit,
      maxLifetime: props.lifetime,
      bounceLeft: props.bounceLeft, canBounce: props.bounceLeft > 0,
      homingAfterBounce: props.homingAfterBounce,
      enemyRicochet: props.enemyRicochet,
      splitCount: props.splitCount, canSplit: props.splitCount > 0,
      chainCount: props.chainCount, chainRadius: props.chainRadius,
      kbRadius: props.kbRadius, kbPeriodic: props.kbPeriodic,
      pierceLeft: props.pierce,
    });
    gs.bullets.push(b);
    spawned++;
  }

  gs.canShoot = false;
  gs.reloadTimer = gs._pReload || C.BASE_RELOAD;
  gs.reloadBarVisible = true;
  gs.reloadBarFadeTimer = 0;
  gs.muzzleFlash = 1;
  // micro time dilation on fire — snappy "moment" feel
  gs.slowTimer = Math.max(gs.slowTimer, 0.06);
}

// ─── EXPLOSION ───────────────────────────────────────────────
function spawnExplosion(x, y, radius, damage, gs, isChain) {
  // KB ring flash
  if (!isChain) {
    gs.kbRings = gs.kbRings || [];
    gs.kbRings.push({ x, y, radius, maxRadius: radius, life: 0, maxLife: 0.35 });
  }

  // visual particles
  const count = Math.min(20, Math.floor(radius * 0.4));
  for (let i = 0; i < count; i++) {
    if (gs.particles.filter(p => p.active).length >= C.MAX_PARTICLES) break;
    const angle = gs.rng.range(0, Math.PI * 2);
    const spd = gs.rng.range(30, 100);
    const p = particlePool.get({
      x, y,
      vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
      maxLife: gs.rng.range(0.3, 0.7), r: gs.rng.range(2, 5),
      color: isChain ? '#88aaff' : '#e8a040',
    });
    gs.particles.push(p);
  }
  // damage enemies
  for (const e of gs.enemies) {
    if (!e.active || e.deathFlag) continue;
    if (e.boss && e.shieldActive) continue;
    const d = M.dist(x, y, e.x, e.y);
    if (d < radius + e.radius) {
      damageEnemy(e, damage, gs, null);
    }
  }
}

// ─── CHAIN LIGHTNING ─────────────────────────────────────────
function triggerChain(sourceX, sourceY, chainCount, chainRadius, damage, gs, excludeIds) {
  const hit = new Set(excludeIds || []);
  let targets = gs.enemies.filter(e => e.active && !e.deathFlag && !hit.has(e.id)
    && M.dist(sourceX, sourceY, e.x, e.y) < chainRadius);
  targets.sort((a, b) => M.dist(sourceX, sourceY, a.x, a.y) - M.dist(sourceX, sourceY, b.x, b.y));
  targets = targets.slice(0, chainCount);

  let prevX = sourceX, prevY = sourceY;
  let dmg = damage;
  for (const t of targets) {
    gs.chainArcs = gs.chainArcs || [];
    gs.chainArcs.push({ x1: prevX, y1: prevY, x2: t.x, y2: t.y, life: 0.25 });
    damageEnemy(t, Math.max(1, Math.round(dmg)), gs, null);
    hit.add(t.id);
    prevX = t.x; prevY = t.y;
    dmg *= 0.7;
  }
}

// ─── DAMAGE ENEMY ────────────────────────────────────────────
function damageEnemy(enemy, dmg, gs, bullet) {
  if (!enemy.active || enemy.deathFlag) return;
  if (enemy.boss && enemy.shieldActive) return;
  if (enemy.phased) return;

  enemy.hp -= dmg;
  enemy.flashTimer = 0.12;

  // tiered impact flash: boss hit is larger and lasts longer
  gs.impactFlashes = gs.impactFlashes || [];
  if (gs.impactFlashes.length < 20) {
    const isBossHit = enemy.boss;
    const flashR = isBossHit ? enemy.radius * 0.9 : enemy.radius * 0.65;
    const flashLife = isBossHit ? 0.18 : 0.10;
    gs.impactFlashes.push({ x: enemy.x, y: enemy.y, life: 0, maxLife: flashLife, r: flashR, boss: isBossHit });
  }

  if (enemy.hp <= 0) {
    killEnemy(enemy, gs, bullet);
  }
}

function killEnemy(enemy, gs, bullet) {
  if (enemy.deathFlag) return;
  enemy.deathFlag = true;

  // score
  const scoreMap = {
    drone: C.SCORE_DRONE, runner: C.SCORE_RUNNER, tank: C.SCORE_TANK,
    splitter: C.SCORE_SPLITTER, zigzag: C.SCORE_ZIGZAG, orbiter: C.SCORE_ORBITER,
  };
  const currMap = {
    drone: C.CURRENCY_DRONE, runner: C.CURRENCY_RUNNER, tank: C.CURRENCY_TANK,
    splitter: C.CURRENCY_SPLITTER, zigzag: C.CURRENCY_ZIGZAG, orbiter: C.CURRENCY_ORBITER,
  };

  let pts = enemy.boss ? C.SCORE_BOSS * (enemy.bossId + 1) : (scoreMap[enemy.type] || C.SCORE_DRONE);
  let curr = enemy.boss ? C.CURRENCY_BOSS : (currMap[enemy.type] || C.CURRENCY_DRONE);

  if (bullet) {
    bullet.currentCombo = (bullet.currentCombo || 0) + 1;
    const combo = bullet.currentCombo;
    // drift: track peak kill chain
    if (gs.drift) {
      gs.drift.totalBulletKills++;
      if (combo > gs.drift.peakCombo) gs.drift.peakCombo = combo;
    }
    if (combo >= 5) pts = Math.round(pts * (1 + combo * 0.1));
    if (combo > gs.bestShotRun) {
      gs.bestShotRun = combo;
      if (combo > (gs.permData.bestShot || 0)) gs.permData.bestShot = combo;
      updateUI(gs);
    }
    if (combo >= 10) {
      gs.slowTimer = Math.max(gs.slowTimer, 0.18);
      gs.globalGlow = 1;
      spawnFloatText(gs, enemy.x, enemy.y - 20, `x${combo} CHAIN!`, 'combo');
    }
    if (combo >= 15) triggerShake(gs, 'lg');
    else if (combo >= 5) triggerShake(gs, 'md');
    else triggerShake(gs, 'sm');
  }

  curr = Math.round(curr * (gs._pEconomy || 1));
  gs.score += pts;
  gs.currency += curr;
  gs.runKills++;
  gs.kills++;
  if (gs.permData) gs.permData.lifetimeKills = (gs.permData.lifetimeKills || 0) + 1;

  // 10% chance to heal 2 HP on kill
  if (gs.rng.next() < 0.10) {
    const healed = Math.min(2, gs.maxHp - gs.hp);
    if (healed > 0) {
      gs.hp += healed;
      spawnFloatText(gs, enemy.x, enemy.y - 28, `+${healed}♦`, 'heal');
    }
  }

  // kill bar
  const barInc = (1 / C.KILL_BAR_MAX) * (gs._pBarSpeed || 1);
  gs.killBar = Math.min(1, gs.killBar + barInc);
  if (gs.killBar >= 1) triggerUpgradeSelection(gs);

  // splitter children
  if (enemy.type === 'splitter' && !enemy.splitDone) {
    enemy.splitDone = true;
    enemy.spawnChildren = [0, 1];
  }

  // enemy ricochet for bullets
  if (bullet && bullet.enemyRicochet && bullet.bounceLeft > 0) {
    const norm = M.norm(bullet.vx, bullet.vy);
    bullet.vx = -norm[0] * bullet.speed * 1.1;
    bullet.vy = -norm[1] * bullet.speed * 1.1;
    bullet.bounceLeft--;
  }

  // spawn particles
  spawnDeathParticles(enemy, gs);

  // kill glow flash — distinct from hit flash, larger and slower
  gs.impactFlashes = gs.impactFlashes || [];
  if (gs.impactFlashes.length < 20) {
    const isMultiKill = bullet && (bullet.currentCombo || 0) >= 3;
    const isChainKill = bullet && (bullet.currentCombo || 0) >= 8;
    gs.impactFlashes.push({
      x: enemy.x, y: enemy.y,
      life: 0,
      maxLife: isChainKill ? 0.32 : isMultiKill ? 0.22 : 0.16,
      r: enemy.boss ? enemy.radius * 1.4 : isChainKill ? enemy.radius * 1.2 : enemy.radius * 0.9,
      boss: enemy.boss,
      kill: true,
      chain: isChainKill,
    });
  }

  // currency float text
  if (curr > 0) spawnFloatText(gs, enemy.x, enemy.y - 12, `+${curr}◈`, 'currency');
  if (enemy.boss) {
    spawnFloatText(gs, enemy.x, enemy.y - 30, `+${curr}◈ BOSS!`, 'boss-kill');
    triggerShake(gs, 'lg');
  }

  // random drop
  const dropChance = 0.06 * (gs._pLuck || 1);
  if (gs.rng.next() < dropChance && !enemy.boss) triggerUpgradeSelection(gs);

  updateUI(gs);
}

function spawnDeathParticles(enemy, gs) {
  const count = Math.min(14, enemy.boss ? 22 : 10);
  const colors = enemy.boss ? ['#e84040', '#e8a040', '#c84080'] : ['#c84040', '#d46820', '#c8a840'];
  for (let i = 0; i < count; i++) {
    if (gs.particles.filter(p => p.active).length >= C.MAX_PARTICLES) break;
    const angle = gs.rng.range(0, Math.PI * 2);
    const spd = gs.rng.range(40, 140);
    const p = particlePool.get({
      x: enemy.x, y: enemy.y,
      vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
      maxLife: gs.rng.range(0.25, 0.55), r: gs.rng.range(2, enemy.boss ? 7 : 4),
      color: gs.rng.pick(colors),
    });
    gs.particles.push(p);
  }
}

// ─── UPGRADE SELECTION ───────────────────────────────────────
let _upgradeSelectPending = false;
function isUpgradePoolEmpty(gs) {
  for (const def of RUN_UPGRADES) {
    const currentLevel = gs.runUpgrades[def.id] || 0;
    if (currentLevel < def.levels.length) return false;
  }
  return true;
}

function triggerUpgradeSelection(gs) {
  if (gs.state !== 'RUNNING') return;
  if (_upgradeSelectPending) return;
  // if all upgrades are maxed, silently skip — don't hard lock
  if (isUpgradePoolEmpty(gs)) {
    gs.killBar = 0;
    return;
  }
  gs.killBar = 0;
  _upgradeSelectPending = true;
  setTimeout(() => {
    if (gs.state !== 'RUNNING') { _upgradeSelectPending = false; return; }
    // double-check pool hasn't emptied between trigger and now
    if (isUpgradePoolEmpty(gs)) { _upgradeSelectPending = false; return; }
    gs.prevState = gs.state;
    gs.state = 'UPGRADE_SELECTION';
    gs.timeScale = 0;
    showUpgradeSelection(gs);
    _upgradeSelectPending = false;
  }, 80);
}

function showUpgradeSelection(gs) {
  const el = document.getElementById('upgrade-selection');
  const cards = document.getElementById('upgrade-cards');
  el.classList.remove('hidden');
  el.classList.add('active');
  cards.innerHTML = '';

  const pool = buildUpgradePool(gs);
  const selected = pickThreeUpgrades(pool, gs);

  for (const upg of selected) {
    const card = document.createElement('div');
    card.className = 'upgrade-card';
    const lvlText = upg.currentLevel > 0 ? `LEVEL ${upg.currentLevel} → ${upg.currentLevel + 1}` : 'NEW';
    card.innerHTML = `
      <div class="card-rarity rarity-${upg.levelData.rarity}">${upg.levelData.rarity.toUpperCase()}</div>
      <div class="card-icon">${upg.def.icon}</div>
      <div class="card-name">${upg.def.name}</div>
      <div class="card-level">${lvlText}</div>
      <div class="card-stat">${upg.levelData.stat}</div>
      <div class="card-desc">${upg.levelData.desc}</div>
    `;
    card.addEventListener('click', () => selectUpgrade(upg, gs));
    card.addEventListener('touchend', (e) => { e.preventDefault(); selectUpgrade(upg, gs); });
    cards.appendChild(card);
  }
}

function buildUpgradePool(gs) {
  const pool = [];
  for (const def of RUN_UPGRADES) {
    const currentLevel = gs.runUpgrades[def.id] || 0;
    if (currentLevel >= def.levels.length) continue;
    pool.push({ def, currentLevel, levelData: def.levels[currentLevel] });
  }
  return pool;
}

function pickThreeUpgrades(pool, gs) {
  if (pool.length === 0) return [];
  const shuffled = gs.rng.shuffle(pool);
  // rarity weighting
  const weighted = [];
  for (const u of shuffled) {
    const r = u.levelData.rarity;
    const weight = r === 'legendary' ? 1 : r === 'rare' ? 2 : 3;
    for (let i = 0; i < weight; i++) weighted.push(u);
  }
  const result = [];
  const seen = new Set();
  for (const u of weighted) {
    if (seen.has(u.def.id)) continue;
    seen.add(u.def.id);
    result.push(u);
    if (result.length >= 3) break;
  }
  // fill if needed
  for (const u of pool) {
    if (result.length >= 3) break;
    if (!seen.has(u.def.id)) { seen.add(u.def.id); result.push(u); }
  }
  return result.slice(0, 3);
}

function selectUpgrade(upg, gs) {
  gs.runUpgrades[upg.def.id] = (gs.runUpgrades[upg.def.id] || 0) + 1;
  document.getElementById('upgrade-selection').classList.remove('active');
  document.getElementById('upgrade-selection').classList.add('hidden');
  gs.state = 'RUNNING';
  gs.timeScale = 1;
}

// ─── PERM UPGRADES UI ────────────────────────────────────────
function showPermUpgradePanel(gs, returnState) {
  const panel = document.getElementById('perm-upgrade-panel');
  const grid = document.getElementById('perm-upgrades-grid');
  panel.classList.remove('hidden');
  panel.classList.add('active');
  grid.innerHTML = '';

  document.getElementById('perm-currency').textContent = gs.permData.currency;

  let lastCat = '';
  for (const upg of PERM_UPGRADES) {
    const lvl = gs.permData.permUpgrades[upg.id] || 0;
    const maxed = lvl >= upg.max;
    const cost = Math.round(upg.costBase * Math.pow(1.45, lvl));

    if (upg.cat !== lastCat) {
      lastCat = upg.cat;
      const label = document.createElement('div');
      label.className = 'perm-category-label';
      label.textContent = upg.cat;
      grid.appendChild(label);
    }

    const row = document.createElement('div');
    row.className = 'perm-upgrade-row';
    row.innerHTML = `
      <div class="perm-upgrade-info">
        <div class="perm-upgrade-name">${upg.name}</div>
        <div class="perm-upgrade-desc">${upg.desc}</div>
      </div>
      <div class="perm-upgrade-level">LV ${lvl}/${upg.max}</div>
      <div class="perm-upgrade-cost">${maxed ? 'MAX' : `◈${cost}`}</div>
      <button class="btn-buy" ${maxed || gs.permData.currency < cost ? 'disabled' : ''} data-id="${upg.id}" data-cost="${cost}">BUY</button>
    `;
    grid.appendChild(row);
  }

  grid.querySelectorAll('.btn-buy').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const cost = parseInt(btn.dataset.cost);
      if (gs.permData.currency >= cost) {
        gs.permData.currency -= cost;
        gs.permData.permUpgrades[id] = (gs.permData.permUpgrades[id] || 0) + 1;
        applyPermUpgrades(gs);
        Save.save(gs.permData);
        showPermUpgradePanel(gs, returnState);
      }
    });
  });

  document.getElementById('btn-close-perm').onclick = () => {
    panel.classList.remove('active');
    panel.classList.add('hidden');
    if (returnState === 'MENU') {
      // make sure main menu is still visible
      const menu = document.getElementById('main-menu');
      menu.classList.remove('hidden');
      menu.classList.add('active');
    } else if (returnState === 'PAUSE') {
      document.getElementById('pause-menu').classList.add('active');
      document.getElementById('pause-menu').classList.remove('hidden');
    }
    // GAMEOVER: game over screen stays, no action needed
  };
}

function applyPermUpgrades(gs) {
  gs._pDamage = 1;
  gs._pCrit = 0;
  gs._pCritMul = 1.5;
  gs._pLifetime = C.BASE_LIFETIME;
  gs._pSpeed = C.BASE_SPEED;
  gs._pReload = C.BASE_RELOAD;
  gs._pMaxHp = C.TURRET_HP;
  gs._pLuck = 1;
  gs._pEconomy = 1;
  gs._pBarSpeed = 1;

  for (const upg of PERM_UPGRADES) {
    const lvl = gs.permData.permUpgrades[upg.id] || 0;
    if (lvl > 0) upg.apply(gs, lvl);
  }
}

// ─── FLOAT TEXTS ─────────────────────────────────────────────
function spawnFloatText(gs, x, y, text, cls) {
  const container = document.getElementById('float-texts');
  const el = document.createElement('div');
  el.className = `float-text ${cls || ''}`;
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1300);
}

// ─── SCREEN SHAKE ────────────────────────────────────────────
function triggerShake(gs, size) {
  const sizes = { sm: 1, md: 2, lg: 3 };
  gs.shakeIntensity = Math.max(gs.shakeIntensity, sizes[size] || 1);
  gs.shakeTimer = 0.3;
  const canvas = gs.canvas;
  canvas.classList.remove('shake-sm', 'shake-md', 'shake-lg');
  void canvas.offsetWidth;
  canvas.classList.add(`shake-${size}`);
  setTimeout(() => canvas.classList.remove(`shake-${size}`), 400);
}

// ─── UI UPDATES ──────────────────────────────────────────────
function updateUI(gs) {
  document.getElementById('ui-currency').textContent = gs.currency;
  document.getElementById('ui-hp').textContent = gs.hp;
  document.getElementById('ui-score').textContent = gs.score;
  const mins = Math.floor(gs.time / 60);
  const secs = Math.floor(gs.time % 60);
  document.getElementById('ui-time').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  document.getElementById('ui-best-shot-run').textContent = gs.bestShotRun;

  // boss countdown timer
  const totalRunUpgrades = Object.values(gs.runUpgrades).reduce((s, v) => s + v, 0);
  const upgradesReady = totalRunUpgrades >= 6;
  const timeReady = gs.time >= C.BOSS_MIN_TIME;
  const bossUnlocked = upgradesReady && timeReady;
  const bossWrap = document.getElementById('boss-timer-wrap');

  if (bossUnlocked && !gs.activeBoss) {
    bossWrap.classList.remove('hidden');
    const cd = Math.max(0, gs.bossCountdown || 0);
    const bm = Math.floor(cd / 60);
    const bs = Math.floor(cd % 60);
    document.getElementById('ui-boss-timer').textContent = `${bm}:${bs.toString().padStart(2, '0')}`;
    if (cd < 10) bossWrap.classList.add('urgent');
    else bossWrap.classList.remove('urgent');
  } else {
    bossWrap.classList.add('hidden');
    bossWrap.classList.remove('urgent');
  }

  const fillEl = document.getElementById('kill-bar-fill');
  fillEl.style.width = `${gs.killBar * 100}%`;
  if (gs.killBar >= 0.99) fillEl.classList.add('full');
  else fillEl.classList.remove('full');
}

function updateMenuStats(gs) {
  const d = gs.permData;
  document.getElementById('menu-best-score').textContent = d.bestScore || 0;
  document.getElementById('menu-best-shot').textContent = d.bestShot || 0;
  document.getElementById('menu-lifetime-kills').textContent = d.lifetimeKills || 0;
}

// ─── GAME OVER ───────────────────────────────────────────────
function triggerGameOver(gs) {
  gs.state = 'GAME_OVER';
  gs.timeScale = 0;

  const earned = gs.currency;
  gs.permData.currency = (gs.permData.currency || 0) + earned;

  const newBestScore = gs.score > (gs.permData.bestScore || 0);
  if (newBestScore) gs.permData.bestScore = gs.score;
  if (gs.time > (gs.permData.bestTime || 0)) gs.permData.bestTime = gs.time;
  gs.permData.lifetimeKills = gs.permData.lifetimeKills || 0;

  Save.save(gs.permData);

  const el = document.getElementById('game-over');
  const title = document.getElementById('gameover-title');
  const stats = document.getElementById('gameover-stats');
  const currEl = document.getElementById('gameover-currency');

  title.textContent = newBestScore ? 'NEW RECORD' : 'RUN TERMINATED';
  title.className = `gameover-title${newBestScore ? ' new-record' : ''}`;

  const mins = Math.floor(gs.time / 60);
  const secs = Math.floor(gs.time % 60);
  stats.innerHTML = `
    <div class="go-stat-row"><span class="go-stat-label">SCORE</span><span class="go-stat-val ${newBestScore ? 'highlight' : ''}">${gs.score}</span></div>
    <div class="go-stat-row"><span class="go-stat-label">TIME SURVIVED</span><span class="go-stat-val">${mins}:${secs.toString().padStart(2, '0')}</span></div>
    <div class="go-stat-row"><span class="go-stat-label">KILLS THIS RUN</span><span class="go-stat-val">${gs.runKills}</span></div>
    <div class="go-stat-row"><span class="go-stat-label">BEST SHOT</span><span class="go-stat-val highlight">${gs.bestShotRun} kills</span></div>
    <div class="go-stat-row"><span class="go-stat-label">ALL-TIME BEST SCORE</span><span class="go-stat-val">${gs.permData.bestScore}</span></div>
  `;
  currEl.textContent = `◈ +${earned} currency earned`;

  el.classList.remove('hidden');
  el.classList.add('active');
}

// ─── MAIN GAME LOOP ──────────────────────────────────────────
function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  const gs = window._gs;
  if (!gs || gs.state === 'MENU') return;

  const rawDt = Math.min((timestamp - gs.lastTime) / 1000, 0.05);
  gs.lastTime = timestamp;

  if (gs.state !== 'RUNNING') {
    render(gs, rawDt);
    return;
  }

  // time scale — aiming takes priority, then slowTimer, then normal
  if (gs.aiming) {
    gs.timeScale = M.lerp(gs.timeScale, C.SLOW_FACTOR, 0.15);
    if (gs.slowTimer > 0) gs.slowTimer -= rawDt;  // drain but don't apply
  } else if (gs.slowTimer > 0) {
    gs.slowTimer -= rawDt;
    gs.timeScale = M.lerp(gs.timeScale, 0.28, 0.25);
  } else {
    gs.timeScale = M.lerp(gs.timeScale, 1.0, 0.18);
  }

  const dt = rawDt * gs.timeScale;
  gs.dt = dt;
  gs.time += dt;

  // reload
  if (!gs.canShoot) {
    gs.reloadTimer -= rawDt * 1000;
    if (gs.reloadTimer <= 0) {
      gs.canShoot = true;
      gs.reloadBarFadeTimer = 0.5;  // start 0.5s fade-out countdown
    }
  }
  if (gs.reloadBarFadeTimer > 0) {
    gs.reloadBarFadeTimer -= rawDt;
    if (gs.reloadBarFadeTimer <= 0) gs.reloadBarVisible = false;
  }

  // perm currency sync
  gs.permData.currency = (gs.permData.currency || 0);

  updateBullets(gs, dt, rawDt);
  updateEnemies(gs, dt);
  updateParticles(gs, dt);
  updateChainArcs(gs, dt);
  updateKbRings(gs, dt);
  updateFeelState(gs, dt, rawDt);
  updateSpawning(gs, dt);
  updateBossTimers(gs, dt);

  // compact arrays — remove inactive objects periodically to prevent unbounded growth
  gs._compactTimer = (gs._compactTimer || 0) + rawDt;
  if (gs._compactTimer > 3) {
    gs._compactTimer = 0;
    gs.bullets   = gs.bullets.filter(b => b.active);
    gs.enemies   = gs.enemies.filter(e => e.active);
    gs.particles = gs.particles.filter(p => p.active);
  }
  updateUI(gs);
  render(gs, rawDt);
}

// ─── UPDATE BULLETS ──────────────────────────────────────────
function updateBullets(gs, dt, rawDt) {
  const toRemove = [];
  for (let i = 0; i < gs.bullets.length; i++) {
    const b = gs.bullets[i];
    if (!b.active) continue;

    // gravity well
    for (const e of gs.enemies) {
      if (!e.active || e.deathFlag) continue;
      if (e.type === 'boss_gravitywell') {
        const dx = e.x - b.x, dy = e.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < 250 && d > e.radius) {
          const force = 180 / (d * d + 1) * 8000;
          b.vx += (dx / d) * force * dt;
          b.vy += (dy / d) * force * dt;
        }
      }
      // pulse entity deflect
      if (e.type === 'boss_pulseentity' && e.activePulseRadius) {
        const dx = b.x - e.x, dy = b.y - e.y;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - e.activePulseRadius) < 14) {
          const norm = [dx / d, dy / d];
          const dot = b.vx * norm[0] + b.vy * norm[1];
          b.vx -= 2 * dot * norm[0] * 0.6;
          b.vy -= 2 * dot * norm[1] * 0.6;
        }
      }
      // time leech slow
      if (e.type === 'boss_timeleech' && b.slowMod > 0.2) {
        // applied on hit, see collision
      }
    }

    const spd = Math.hypot(b.vx, b.vy);
    const normSpd = spd || 1;

    // homing after bounce
    if (b.homingAfterBounce && b.bounceLeft < (gs.runUpgrades.bounce || 0)) {
      const nearest = nearestEnemy(b.x, b.y, gs);
      if (nearest) {
        const dx = nearest.x - b.x, dy = nearest.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        b.vx = M.lerp(b.vx, (dx / d) * spd, 0.06);
        b.vy = M.lerp(b.vy, (dy / d) * spd, 0.06);
      }
    }

    // trail
    b.trail.push({ x: b.x, y: b.y });
    if (b.trail.length > 18) b.trail.shift();

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.lifetime += dt;

    // KB periodic
    if (b.kbPeriodic && b.kbRadius > 0) {
      b.kbTimer += dt;
      if (b.kbTimer > 0.55) {
        b.kbTimer = 0;
        spawnExplosion(b.x, b.y, b.kbRadius * 0.6, Math.ceil(b.damage * 0.4), gs, false);
      }
    }

    // wall bounce / collision
    let dead = false;
    const { arenaX: ax, arenaY: ay, arenaW: aw, arenaH: ah } = gs;
    if (b.x - b.radius < ax) {
      if (b.canBounce && b.bounceLeft > 0) { b.vx = Math.abs(b.vx); b.bounceLeft--; spawnWallRipple(gs, ax, b.y); if (gs.drift) gs.drift.totalBounces++; }
      else dead = true;
    }
    if (b.x + b.radius > ax + aw) {
      if (b.canBounce && b.bounceLeft > 0) { b.vx = -Math.abs(b.vx); b.bounceLeft--; spawnWallRipple(gs, ax + aw, b.y); if (gs.drift) gs.drift.totalBounces++; }
      else dead = true;
    }
    if (b.y - b.radius < ay) {
      if (b.canBounce && b.bounceLeft > 0) { b.vy = Math.abs(b.vy); b.bounceLeft--; spawnWallRipple(gs, b.x, ay); if (gs.drift) gs.drift.totalBounces++; }
      else dead = true;
    }
    if (b.y + b.radius > ay + ah) {
      if (b.canBounce && b.bounceLeft > 0) { b.vy = -Math.abs(b.vy); b.bounceLeft--; spawnWallRipple(gs, b.x, ay + ah); if (gs.drift) gs.drift.totalBounces++; }
      else dead = true;
    }

    // lifetime
    if (b.lifetime >= b.maxLifetime) dead = true;

    if (dead) {
      expireBullet(b, gs);
      bulletPool.release(b);
      toRemove.push(i);
      continue;
    }

    // collision vs enemies
    for (const e of gs.enemies) {
      if (!e.active || e.deathFlag) continue;
      if (b.hitEnemies.has(e.id)) continue;
      if (e.phased) continue;
      if (e.boss && e.shieldActive) continue;

      const d = M.dist(b.x, b.y, e.x, e.y);
      if (d < b.radius + e.radius) {
        b.hitEnemies.add(e.id);

        // ricochet beast
        if (e.type === 'boss_ricochet' && !e.reflectUsed) {
          e.reflectUsed = true;
          const norm = M.norm(b.vx, b.vy);
          const reflected = bulletPool.get({
            x: e.x, y: e.y,
            vx: -norm[0] * Math.hypot(b.vx, b.vy),
            vy: -norm[1] * Math.hypot(b.vx, b.vy),
            damage: b.damage, maxLifetime: 1.5, pierceLeft: 1,
          });
          reflected._reflectedAtTurret = true;
          gs.bullets.push(reflected);
          triggerShake(gs, 'md');
        }

        // time leech slow
        if (e.type === 'boss_timeleech') {
          const totalSpd = Math.hypot(b.vx, b.vy);
          const slowFactor = 0.55;
          b.vx *= slowFactor;
          b.vy *= slowFactor;
        }

        damageEnemy(e, b.damage, gs, b);

        // chain
        if (b.chainCount > 0) {
          triggerChain(e.x, e.y, b.chainCount, b.chainRadius, Math.max(1, Math.ceil(b.damage * 0.6)), gs, [e.id]);
        }

        b.pierceLeft--;
        if (b.pierceLeft <= 0) {
          expireBullet(b, gs);
          bulletPool.release(b);
          toRemove.push(i);
          break;
        }
      }
    }

    // reflected bullet hits turret
    if (b._reflectedAtTurret) {
      const d = M.dist(b.x, b.y, gs.cx, gs.cy);
      if (d < C.TURRET_RADIUS + b.radius) {
        gs.hp = Math.max(0, gs.hp - 1);
        triggerShake(gs, 'md');
        bulletPool.release(b);
        toRemove.push(i);
        if (gs.hp <= 0) triggerGameOver(gs);
        continue;
      }
    }
  }

  for (let i = toRemove.length - 1; i >= 0; i--) gs.bullets.splice(toRemove[i], 1);
}

function expireBullet(b, gs) {
  // drift: record lifetime and increment fired count
  if (gs.drift && !b.fromSplit) {
    gs.drift.totalBulletsFired++;
    gs.drift.totalBulletLifetime += b.lifetime;
  }
  if (b.kbRadius > 0) {
    spawnExplosion(b.x, b.y, b.kbRadius, Math.ceil(b.damage * 0.7), gs, false);
    triggerShake(gs, b.kbRadius > 60 ? 'md' : 'sm');
  }
  if (b.canSplit && b.splitCount > 0 && !b.fromSplit) {
    splitBullet(b, gs);
  }
}

function splitBullet(b, gs) {
  if (gs.drift) gs.drift.totalSplits++;
  const count = Math.min(b.splitCount, C.MAX_BULLETS - gs.bullets.filter(x => x.active).length);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const spd = Math.hypot(b.vx, b.vy) * 0.85 || (gs._pSpeed || C.BASE_SPEED) * 0.85;
    const nb = bulletPool.get({
      x: b.x, y: b.y,
      vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
      damage: b.damage, maxLifetime: b.maxLifetime * 0.55,
      pierceLeft: b.pierceLeft,
      canBounce: b.canBounce, bounceLeft: b.bounceLeft,
      chainCount: b.chainCount, chainRadius: b.chainRadius,
      kbRadius: 0, fromSplit: true,
    });
    gs.bullets.push(nb);
  }
}

function spawnWallRipple(gs, x, y) {
  for (let i = 0; i < 5; i++) {
    if (gs.particles.filter(p => p.active).length >= C.MAX_PARTICLES) break;
    const angle = gs.rng.range(0, Math.PI * 2);
    const p = particlePool.get({
      x, y, vx: Math.cos(angle) * 40, vy: Math.sin(angle) * 40,
      maxLife: 0.25, r: 2, color: '#8899bb',
    });
    gs.particles.push(p);
  }
}

function nearestEnemy(x, y, gs) {
  let best = null, bestD = Infinity;
  for (const e of gs.enemies) {
    if (!e.active || e.deathFlag || e.phased) continue;
    const d = M.dist(x, y, e.x, e.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ─── UPDATE ENEMIES ──────────────────────────────────────────
function updateEnemies(gs, dt) {
  const toRemove = [];
  const newSpawns = [];

  for (let i = 0; i < gs.enemies.length; i++) {
    const e = gs.enemies[i];
    if (!e.active) continue;

    if (e.deathFlag) {
      if (e.spawnChildren) {
        for (const idx of e.spawnChildren) newSpawns.push(spawnSplitterChild(e, gs, idx));
        e.spawnChildren = null;
      }
      enemyPool.release(e);
      toRemove.push(i);
      continue;
    }

    if (e.flashTimer > 0) e.flashTimer -= dt;

    const dx = gs.cx - e.x, dy = gs.cy - e.y;
    const dist = Math.hypot(dx, dy) || 1;

    // MOVEMENT PER TYPE
    const spd = e.speed * (e.slowMod || 1);

    if (e.type === 'orbiter') {
      e.orbitAngle += dt * (spd / (e.orbitRadius || 120));
      e.orbitRadius = Math.max(e.radius + C.TURRET_RADIUS + 5, e.orbitRadius - dt * 8);
      e.x = gs.cx + Math.cos(e.orbitAngle) * e.orbitRadius;
      e.y = gs.cy + Math.sin(e.orbitAngle) * e.orbitRadius;
    } else if (e.type === 'zigzag') {
      e.zigTimer += dt;
      if (e.zigTimer > 0.35) { e.zigDir *= -1; e.zigTimer = 0; }
      const perpX = -dy / dist, perpY = dx / dist;
      e.x += (dx / dist * spd + perpX * e.zigDir * spd * 0.5) * dt;
      e.y += (dy / dist * spd + perpY * e.zigDir * spd * 0.5) * dt;
    } else if (e.type === 'boss_corebreaker') {
      // moves toward turret, stops at distance
      const targetDist = 120;
      if (dist > targetDist) {
        e.x += dx / dist * spd * dt;
        e.y += dy / dist * spd * dt;
      }
      e.shieldTimer += dt;
      if (e.shieldTimer > 4) { e.shieldTimer = 0; e.shieldActive = !e.shieldActive; }
    } else if (e.type === 'boss_phantom') {
      e.x += dx / dist * spd * dt;
      e.y += dy / dist * spd * dt;
      e.phaseTimer += dt;
      if (!e.phased && e.phaseTimer > 3) { e.phased = true; e.phaseTimer = 0; }
      if (e.phased && e.phaseTimer > 1.5) { e.phased = false; e.phaseTimer = 0; }
    } else if (e.type === 'boss_pulseentity') {
      if (dist > 100) { e.x += dx / dist * spd * dt; e.y += dy / dist * spd * dt; }
      e.pulseTimer += dt;
      if (e.pulseTimer > 2.2) {
        e.pulseTimer = 0;
        e.activePulseRadius = 0;
        e.pulsing = true;
      }
      if (e.pulsing) {
        e.activePulseRadius = (e.activePulseRadius || 0) + dt * 220;
        if (e.activePulseRadius > 300) { e.pulsing = false; e.activePulseRadius = 0; }
      }
    } else if (e.type === 'boss_gravitywell') {
      if (dist > 90) { e.x += dx / dist * spd * dt; e.y += dy / dist * spd * dt; }
    } else if (e.type === 'boss_ricochet') {
      e.x += dx / dist * spd * dt;
      e.y += dy / dist * spd * dt;
      e.reflectTimer += dt;
      if (e.reflectTimer > 2.5) { e.reflectTimer = 0; e.reflectUsed = false; }
    } else if (e.type === 'boss_swarmcore') {
      if (dist > 130) { e.x += dx / dist * spd * dt; e.y += dy / dist * spd * dt; }
      // shield enemies orbit it
    } else if (e.type === 'boss_splitmonarch') {
      e.x += dx / dist * spd * dt;
      e.y += dy / dist * spd * dt;
      const hpPct = e.hp / e.maxHp;
      if (!e.splitDone && hpPct < 0.6) {
        e.splitDone = true;
        for (let s = 0; s < 2; s++) {
          const ne = enemyPool.get({ hp: Math.ceil(e.maxHp * 0.3), speed: e.speed * 1.1, radius: e.radius * 0.65,
            type: 'boss_splitmonarch', x: e.x + (s === 0 ? -50 : 50), y: e.y, boss: true });
          ne.bossId = 1; ne.bossName = 'SPLIT MONARCH'; ne.splitDone = true;
          newSpawns.push(ne);
        }
      }
    } else if (e.type === 'boss_splitterqueen') {
      if (dist > 110) { e.x += dx / dist * spd * dt; e.y += dy / dist * spd * dt; }
      e.spawnTimer = (e.spawnTimer || 0) + dt;
      if (e.spawnTimer > 2.5) {
        e.spawnTimer = 0;
        const type = gs.rng.pick(['drone', 'runner', 'splitter']);
        newSpawns.push(spawnEnemy(type, gs));
      }
    } else if (e.type === 'boss_timeleech') {
      e.x += dx / dist * spd * dt;
      e.y += dy / dist * spd * dt;
    } else if (e.type === 'boss_doomsday') {
      const hpPct = e.hp / e.maxHp;
      const speedMul = 1 + (1 - hpPct) * 2.2;
      e.x += dx / dist * spd * speedMul * dt;
      e.y += dy / dist * spd * speedMul * dt;
      e.cracksLevel = Math.floor((1 - hpPct) * 4);
    } else {
      e.x += dx / dist * spd * dt;
      e.y += dy / dist * spd * dt;
    }

    // hit turret
    if (dist < C.TURRET_RADIUS + e.radius * 0.7 && !e.phased) {
      const dmg = e.boss ? 3 : e.type === 'tank' ? 2 : 1;
      gs.hp = Math.max(0, gs.hp - dmg);
      triggerShake(gs, dmg >= 2 ? 'md' : 'sm');
      spawnFloatText(gs, gs.cx, gs.cy - 30, `-${dmg}`, 'kill');
      enemyPool.release(e);
      toRemove.push(i);
      if (gs.hp <= 0) { triggerGameOver(gs); return; }
    }
  }

  for (let i = toRemove.length - 1; i >= 0; i--) gs.enemies.splice(toRemove[i], 1);
  for (const e of newSpawns) gs.enemies.push(e);
}

// ─── UPDATE PARTICLES ────────────────────────────────────────
function updateParticles(gs, dt) {
  const toRemove = [];
  for (let i = 0; i < gs.particles.length; i++) {
    const p = gs.particles[i];
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.maxLife) { particlePool.release(p); toRemove.push(i); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  for (let i = toRemove.length - 1; i >= 0; i--) gs.particles.splice(toRemove[i], 1);
}

function updateChainArcs(gs, dt) {
  if (!gs.chainArcs) return;
  gs.chainArcs = gs.chainArcs.filter(a => { a.life -= dt; return a.life > 0; });
}

function updateKbRings(gs, dt) {
  if (!gs.kbRings) return;
  gs.kbRings = gs.kbRings.filter(r => { r.life += dt; return r.life < r.maxLife; });
}

// ─── FEEL STATE ──────────────────────────────────────────────
function updateFeelState(gs, dt, rawDt) {
  // smooth barrel angle toward target
  const targetAngle = gs.aiming
    ? Math.atan2(gs.aimEnd.y - gs.cy, gs.aimEnd.x - gs.cx) + Math.PI
    : Math.atan2(gs.mouse.y - gs.cy, gs.mouse.x - gs.cx);

  // shortest-path angle lerp
  let diff = targetAngle - (gs.barrelAngle || 0);
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  gs.barrelAngle = (gs.barrelAngle || 0) + diff * Math.min(1, 14 * rawDt);

  // aim charge builds while dragging (0→1 over 0.5s)
  if (gs.aiming) {
    gs.aimCharge = Math.min(1, (gs.aimCharge || 0) + rawDt / 0.45);
  } else {
    gs.aimCharge = Math.max(0, (gs.aimCharge || 0) - rawDt * 6);
  }

  // muzzle flash decays fast
  if (gs.muzzleFlash > 0) gs.muzzleFlash = Math.max(0, gs.muzzleFlash - rawDt * 12);

  // impact flashes
  gs.impactFlashes = (gs.impactFlashes || []).filter(f => {
    f.life += rawDt;
    return f.life < f.maxLife;
  });

  // ── drift score update (lazy, every ~0.5s) ──
  gs._driftTick = (gs._driftTick || 0) + rawDt;
  if (gs._driftTick > 0.5 && gs.drift) {
    gs._driftTick = 0;
    const d = gs.drift;
    const fired = Math.max(1, d.totalBulletsFired);
    // bounceScore: how bounce-heavy the session is
    d.bounceScore = Math.min(1, d.totalBounces / Math.max(1, fired * 1.5));
    // splitScore: split usage
    d.splitScore = Math.min(1, d.totalSplits / Math.max(1, fired * 0.8));
    // killChainScore: avg kills per bullet
    d.killChainScore = Math.min(1, (d.totalBulletKills / fired) / 3);
    // lifetimeScore: avg lifetime vs max possible
    const avgLife = d.totalBulletLifetime / fired;
    d.lifetimeScore = Math.min(1, avgLife / (gs._pLifetime || C.BASE_LIFETIME));
  }
}

// ─── SPAWNING ────────────────────────────────────────────────
//
// Difficulty phases (time in seconds):
//   0–10s   : warmup — no spawns
//   10–30s  : intro — one drone at a time, long intervals
//   30–90s  : early — variety unlocks, interval tightens smoothly
//   90–180s : mid   — pressure builds, extras start appearing
//   180s+   : late  — high density, events fire, max variety
//
function updateSpawning(gs, dt) {
  const t = gs.time;

  // absolute warmup — nothing
  if (t < 10) return;

  gs.spawnTimer = (gs.spawnTimer || 0) + dt * 1000;

  // ── spawn interval ──
  // base: 2400ms → 700ms over 5 min, linear, clamped
  const baseInterval = 2400;
  const minInterval  = 700;
  const rampDuration = 300;  // 5 min to reach minimum
  const rawInterval  = baseInterval - ((baseInterval - minInterval) * Math.min(1, (t - 10) / rampDuration));

  // gentle intro multiplier: 10-30s gets 2.5x slower
  const introMul = t < 30 ? M.lerp(2.5, 1.0, (t - 10) / 20) : 1;

  // breathing rhythm: subtle ±12% sine wave to prevent pure monotony
  const breathe = 1 + 0.12 * Math.sin(t * 0.08);

  const interval = Math.max(minInterval, rawInterval * introMul * breathe);

  if (gs.spawnTimer < interval) return;
  gs.spawnTimer = 0;

  // ── enemy type availability ──
  const available = ENEMY_TYPES.filter(type => t >= ENEMY_UNLOCK_TIMES[type]);

  // ── event spawns ── (only mid/late game + needs 3 upgrades)
  const totalRunUpgrades = Object.values(gs.runUpgrades).reduce((s, v) => s + v, 0);
  const eventsUnlocked = totalRunUpgrades >= 3 && t >= 90;

  if (eventsUnlocked && gs.rng.next() < 0.07) {
    // rush event: pack of runners
    const rushCount = t > 180 ? 5 : 4;
    for (let i = 0; i < rushCount; i++) gs.enemies.push(spawnEnemy('runner', gs));
    spawnFloatText(gs, gs.cx, gs.cy - 60, 'RUSH!', 'combo');
    return;
  }
  if (eventsUnlocked && gs.rng.next() < 0.06) {
    // swarm event: drones
    const swarmCount = t > 240 ? 8 : 6;
    for (let i = 0; i < swarmCount; i++) gs.enemies.push(spawnEnemy('drone', gs));
    spawnFloatText(gs, gs.cx, gs.cy - 60, 'SWARM!', 'combo');
    return;
  }

  // ── base spawn ──
  const type = gs.rng.pick(available);
  gs.enemies.push(spawnEnemy(type, gs));

  // ── extra enemies (mid/late) ──
  // 90–180s: 25% chance of one extra
  if (t >= 90 && gs.rng.next() < Math.min(0.55, (t - 90) / 240)) {
    gs.enemies.push(spawnEnemy(gs.rng.pick(available), gs));
  }
  // 180s+: 30% chance of a second extra (so max 3 per tick)
  if (t >= 180 && gs.rng.next() < Math.min(0.35, (t - 180) / 300)) {
    gs.enemies.push(spawnEnemy(gs.rng.pick(available), gs));
  }
}

function updateBossTimers(gs, dt) {
  const totalRunUpgrades = Object.values(gs.runUpgrades).reduce((s, v) => s + v, 0);
  const upgradesReady = totalRunUpgrades >= 6;
  const timeReady = gs.time >= C.BOSS_MIN_TIME;

  // conditions not met yet — hold timer at starting value, don't tick
  if (!upgradesReady || !timeReady) {
    if (!gs.bossUnlocked) gs.bossCountdown = C.BOSS_INTERVAL_FIRST;
    return;
  }

  // first time conditions were met — mark unlocked and start countdown
  if (!gs.bossUnlocked) {
    gs.bossUnlocked = true;
    gs.bossCountdown = C.BOSS_INTERVAL_FIRST;
  }

  // don't tick while a boss is alive
  if (gs.activeBoss) {
    // clean up if boss died
    if (!gs.activeBoss.active || gs.activeBoss.deathFlag) {
      gs.activeBoss = null;
      gs.bossCountdown = C.BOSS_INTERVAL;
    }
    return;
  }

  // tick countdown
  gs.bossCountdown -= dt;
  if (gs.bossCountdown <= 0) {
    gs.bossCountdown = C.BOSS_INTERVAL;
    const boss = spawnBoss(gs);
    gs.enemies.push(boss);
    gs.activeBoss = boss;
    gs.bossCount++;
    showBossWarning(boss.bossName);
  }
}

function showBossWarning(name) {
  const el = document.getElementById('boss-warning');
  const text = document.getElementById('boss-warn-text');
  text.textContent = `⚠ ${name} ⚠`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2800);
}

// ─── RENDER ──────────────────────────────────────────────────
function render(gs, dt) {
  const ctx = gs.ctx;
  const W = gs.W, H = gs.H;
  const charge = gs.aimCharge || 0;
  const muzzle = gs.muzzleFlash || 0;
  const gameTime = gs.time || 0;
  const intensity = Math.min(1, gameTime / 180);
  const bossActive = !!gs.activeBoss;

  ctx.clearRect(0, 0, W, H);

  // background — slightly darker at late game / during boss
  const bgDark = bossActive ? 0.04 : intensity * 0.02;
  ctx.fillStyle = `rgb(${Math.floor(8 - bgDark * 80)},${Math.floor(8 - bgDark * 80)},${Math.floor(11 - bgDark * 60)})`;
  ctx.fillRect(0, 0, W, H);

  // grid — two scales for depth
  ctx.strokeStyle = 'rgba(100,120,160,0.028)';
  ctx.lineWidth = 0.5;
  const gridSm = 24;
  for (let x = gs.arenaX % gridSm; x < W; x += gridSm) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = gs.arenaY % gridSm; y < H; y += gridSm) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(100,130,180,0.055)';
  const gridLg = 96;
  for (let x = gs.arenaX % gridLg; x < W; x += gridLg) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = gs.arenaY % gridLg; y < H; y += gridLg) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // vignette — deeper at corners
  const vig = ctx.createRadialGradient(gs.cx, gs.cy, gs.arenaW * 0.18, gs.cx, gs.cy, gs.arenaW * 0.82);
  vig.addColorStop(0, 'transparent');
  vig.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // floor light under turret — reactive to aiming charge
  const floorR = 90 + charge * 30;
  const floorGrad = ctx.createRadialGradient(gs.cx, gs.cy, 0, gs.cx, gs.cy, floorR);
  floorGrad.addColorStop(0, `rgba(80,120,160,${0.055 + charge * 0.045})`);
  floorGrad.addColorStop(0.5, `rgba(60,90,130,${0.025 + charge * 0.02})`);
  floorGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = floorGrad;
  ctx.beginPath(); ctx.arc(gs.cx, gs.cy, floorR, 0, Math.PI * 2); ctx.fill();

  // arena border — brightens slightly on muzzle flash
  const borderAlpha = 0.5 + muzzle * 0.3;
  ctx.strokeStyle = `rgba(58,68,95,${borderAlpha})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(gs.arenaX, gs.arenaY, gs.arenaW, gs.arenaH);

  if (gs.state !== 'MENU') {
    renderEnemies(ctx, gs);
    renderBullets(ctx, gs);
    renderParticles(ctx, gs);
    renderChainArcs(ctx, gs);
    renderKbRings(ctx, gs);
    renderTurret(ctx, gs);
    renderAimLine(ctx, gs);
    renderGlobalGlow(ctx, gs, dt);
  }
}

function renderTurret(ctx, gs) {
  const { cx, cy } = gs;
  const hpPct = gs.hp / gs.maxHp;
  const aimAngle = gs.barrelAngle || 0;
  const charge = gs.aimCharge || 0;
  const muzzle = gs.muzzleFlash || 0;

  // soft ground glow that brightens when aiming
  const glowR = C.TURRET_RADIUS + 28 + charge * 14;
  const glowAlpha = 0.06 + charge * 0.06;
  const glowGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glowGrad.addColorStop(0, `rgba(126,184,212,${glowAlpha})`);
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();

  // muzzle flash bloom at barrel tip
  if (muzzle > 0) {
    const tipX = cx + Math.cos(aimAngle) * (C.TURRET_RADIUS + 8);
    const tipY = cy + Math.sin(aimAngle) * (C.TURRET_RADIUS + 8);
    const mGrad = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 28 * muzzle);
    mGrad.addColorStop(0, `rgba(220,235,255,${muzzle * 0.55})`);
    mGrad.addColorStop(0.4, `rgba(160,200,240,${muzzle * 0.25})`);
    mGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = mGrad;
    ctx.beginPath(); ctx.arc(tipX, tipY, 28 * muzzle, 0, Math.PI * 2); ctx.fill();
  }

  // base ring — pulses on low HP
  const ringAlpha = hpPct < 0.3
    ? 0.5 + Math.sin(Date.now() * 0.008) * 0.3
    : 0.22 + charge * 0.15;
  ctx.strokeStyle = hpPct < 0.3
    ? `rgba(200,64,64,${ringAlpha})`
    : `rgba(160,185,215,${ringAlpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, C.TURRET_RADIUS + 6, 0, Math.PI * 2); ctx.stroke();

  // base body
  ctx.fillStyle = hpPct < 0.3 ? '#5a3030' : '#1e2230';
  ctx.strokeStyle = hpPct < 0.3 ? '#c84040' : `rgba(72,110,140,${0.7 + charge * 0.3})`;
  ctx.lineWidth = 1.5 + charge * 0.5;
  ctx.beginPath(); ctx.arc(cx, cy, C.TURRET_RADIUS, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // cracks at low HP
  if (hpPct < 0.5) {
    ctx.strokeStyle = `rgba(200,100,100,${(0.5 - hpPct) * 1.5})`;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
      ctx.lineTo(cx + Math.cos(a + 0.4) * (C.TURRET_RADIUS - 2), cy + Math.sin(a + 0.4) * (C.TURRET_RADIUS - 2));
      ctx.stroke();
    }
  }

  // barrel — pulls back slightly during aim (recoil anticipation)
  const recoilPull = charge * 2.5;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(aimAngle);
  // charge tension: barrel brightens subtly
  const barrelBright = Math.floor(160 + charge * 40);
  ctx.fillStyle = `rgb(${barrelBright},${barrelBright + 10},${barrelBright + 20})`;
  ctx.strokeStyle = `rgba(80,110,160,${0.6 + charge * 0.4})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-3 + recoilPull, -4, C.TURRET_RADIUS + 8 - recoilPull, 8, 2);
  ctx.fill(); ctx.stroke();

  // charge pulse ring at barrel tip when fully charged
  if (charge > 0.6) {
    const pulseAlpha = (charge - 0.6) / 0.4 * 0.4;
    ctx.strokeStyle = `rgba(180,220,255,${pulseAlpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(C.TURRET_RADIUS + 4, 0, 5 + charge * 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  // hp pips
  for (let i = 0; i < gs.maxHp; i++) {
    const a = (i / gs.maxHp) * Math.PI * 2 - Math.PI / 2;
    const r = C.TURRET_RADIUS + 12;
    const active = i < gs.hp;
    ctx.fillStyle = active ? (hpPct < 0.3 ? '#c84040' : '#4a9abe') : '#2a2a3a';
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  // reload bar arc
  if (gs.reloadBarVisible) {
    const arcR = C.TURRET_RADIUS + 22;
    const totalReload = gs._pReload || C.BASE_RELOAD;

    let progress, alpha;
    if (!gs.canShoot) {
      progress = 1 - (gs.reloadTimer / totalReload);
      alpha = 1;
    } else {
      progress = 1;
      alpha = Math.max(0, gs.reloadBarFadeTimer / 0.5);
    }

    ctx.strokeStyle = `rgba(40,50,70,${alpha * 0.8})`;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);
    ctx.stroke();

    const fillColor = progress >= 1
      ? `rgba(80,220,140,${alpha})`
      : `rgba(126,184,212,${alpha})`;
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();
    ctx.lineCap = 'butt';

    if (progress >= 1) {
      ctx.fillStyle = `rgba(80,220,140,${alpha})`;
      ctx.shadowColor = `rgba(80,220,140,${alpha * 0.8})`;
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(cx, cy - arcR, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

function renderAimLine(ctx, gs) {
  if (!gs.aiming && (gs.aimCharge || 0) < 0.02) return;
  const charge = gs.aimCharge || 0;
  const fireAngle = Math.atan2(gs.aimEnd.y - gs.cy, gs.aimEnd.x - gs.cx) + Math.PI;

  let tx = gs.cx, ty = gs.cy;
  const stepLen = 10;
  const maxSteps = 60;
  let bounceLeft = gs.runUpgrades.bounce || 0;
  let cvx = Math.cos(fireAngle), cvy = Math.sin(fireAngle);

  // collect path segments for gradient rendering
  const pts = [{ x: tx, y: ty }];
  for (let s = 0; s < maxSteps; s++) {
    tx += cvx * stepLen;
    ty += cvy * stepLen;
    if (tx < gs.arenaX && bounceLeft > 0) { cvx = Math.abs(cvx); bounceLeft--; tx = gs.arenaX; }
    else if (tx > gs.arenaX + gs.arenaW && bounceLeft > 0) { cvx = -Math.abs(cvx); bounceLeft--; tx = gs.arenaX + gs.arenaW; }
    if (ty < gs.arenaY && bounceLeft > 0) { cvy = Math.abs(cvy); bounceLeft--; ty = gs.arenaY; }
    else if (ty > gs.arenaY + gs.arenaH && bounceLeft > 0) { cvy = -Math.abs(cvy); bounceLeft--; ty = gs.arenaY + gs.arenaH; }
    if (tx < gs.arenaX || tx > gs.arenaX + gs.arenaW || ty < gs.arenaY || ty > gs.arenaY + gs.arenaH) break;
    pts.push({ x: tx, y: ty });
  }

  ctx.save();
  // draw line with fade: bright near turret, dim at far end
  for (let i = 1; i < pts.length; i++) {
    const tVal = i / pts.length;
    const lineAlpha = (1 - tVal * 0.85) * charge * 0.5;
    ctx.strokeStyle = `rgba(185,215,245,${lineAlpha})`;
    ctx.lineWidth = (1 - tVal * 0.5) * (0.8 + charge * 0.6);
    ctx.setLineDash([6, 9]);
    ctx.lineDashOffset = -Date.now() * 0.04;   // animated dash flow
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.restore();

  // endpoint dot — grows with charge
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    ctx.fillStyle = `rgba(185,215,245,${charge * 0.6})`;
    ctx.beginPath(); ctx.arc(last.x, last.y, 2 + charge * 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function renderBullets(ctx, gs) {
  const d = gs.drift || {};
  const bounceScore = d.bounceScore || 0;
  const splitScore = d.splitScore || 0;
  const killScore = d.killChainScore || 0;
  const lifeScore = d.lifetimeScore || 0;

  // dynamic intensity: 0→1 over first 3 mins, extra bump during boss
  const gameTime = gs.time || 0;
  const intensity = Math.min(1, gameTime / 180);
  const bossBoost = gs.activeBoss ? 0.18 : 0;

  for (const b of gs.bullets) {
    if (!b.active) continue;
    const combo = b.currentCombo || 0;
    const isCrit = b.crit;
    const hasSplit = b.canSplit;
    const hasBounce = b.canBounce && (gs.runUpgrades.bounce || 0) > 0;

    // drift: split stagger — tiny positional offset on split-originated bullets
    const splitStagger = (splitScore > 0.3 && b.fromSplit)
      ? Math.sin(Date.now() * 0.008 + b.x * 0.03) * splitScore * 0.9
      : 0;

    // trail
    if (b.trail.length > 1) {
      const baseW = isCrit ? 2.5 : hasSplit ? 2.2 : 1.8;
      const comboBonus = Math.min(2.5, combo * 0.18);
      const trailAlphaMul = 1 + killScore * 0.45 + intensity * 0.3 + bossBoost;

      for (let i = 1; i < b.trail.length; i++) {
        const tFrac = i / b.trail.length;
        const alpha = Math.min(0.88, tFrac * tFrac * (isCrit ? 0.65 : 0.45) * trailAlphaMul);
        let col;
        if (isCrit) col = `rgba(255,210,100,${alpha})`;
        else if (hasBounce) col = `rgba(150,210,255,${alpha})`;
        else col = `rgba(190,220,255,${alpha})`;
        ctx.strokeStyle = col;
        ctx.lineWidth = (baseW + comboBonus) * tFrac;
        ctx.lineCap = 'round';
        // drift: bounce personality — very subtle path variation on trail points
        const px = b.trail[i - 1].x + (bounceScore > 0.4 ? Math.sin(i * 0.85) * bounceScore * 0.7 : 0);
        const py = b.trail[i - 1].y + (bounceScore > 0.4 ? Math.cos(i * 0.85) * bounceScore * 0.7 : 0);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(b.trail[i].x + splitStagger, b.trail[i].y);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }

    // glow — stronger mid/late and on bosses
    const glowR = b.radius + 4 + combo * 0.2 + intensity * 2 + bossBoost * 8;
    const glowAlpha = (isCrit ? 0.22 : 0.14) + intensity * 0.07 + bossBoost * 0.08 + killScore * 0.06;
    const gGrad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR * 2.2);
    gGrad.addColorStop(0, isCrit ? `rgba(255,200,80,${glowAlpha})` : `rgba(160,200,240,${glowAlpha})`);
    gGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = gGrad;
    ctx.beginPath(); ctx.arc(b.x, b.y, glowR * 2.2, 0, Math.PI * 2); ctx.fill();

    // core
    const coreR = b.radius + (combo > 5 ? Math.min(3, combo * 0.22) : 0);
    ctx.fillStyle = isCrit ? '#ffe090' : '#deeeff';
    ctx.beginPath(); ctx.arc(b.x, b.y, coreR, 0, Math.PI * 2); ctx.fill();

    if (isCrit) {
      ctx.strokeStyle = 'rgba(255,200,80,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, coreR + 2.5, 0, Math.PI * 2); ctx.stroke();
    }

    // split indicator: small orbiting dot
    if (hasSplit) {
      const oAngle = Date.now() * 0.005 + b.x * 0.01;
      const ox = b.x + Math.cos(oAngle) * (coreR + 4);
      const oy = b.y + Math.sin(oAngle) * (coreR + 4);
      ctx.fillStyle = 'rgba(160,220,200,0.6)';
      ctx.beginPath(); ctx.arc(ox, oy, 2, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function renderEnemies(ctx, gs) {
  // draw approach shadows first (under everything)
  for (const e of gs.enemies) {
    if (!e.active || e.deathFlag || e.phased) continue;
    const distToTurret = M.dist(e.x, e.y, gs.cx, gs.cy);
    const proximity = Math.max(0, 1 - distToTurret / 260);
    if (proximity > 0.05) {
      const sR = e.radius * (1 + proximity * 0.6);
      const sGrad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, sR * 2.5);
      sGrad.addColorStop(0, `rgba(180,40,40,${proximity * 0.08})`);
      sGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = sGrad;
      ctx.beginPath(); ctx.arc(e.x, e.y, sR * 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // impact flashes — full feedback hierarchy
  for (const f of (gs.impactFlashes || [])) {
    const t = f.life / f.maxLife;
    const inv = 1 - t;

    if (f.boss && f.kill) {
      // boss kill: large warm burst + outer ring
      const r = f.r * (0.4 + t * 0.8);
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      grad.addColorStop(0, `rgba(255,200,100,${inv * 0.45})`);
      grad.addColorStop(0.6, `rgba(220,120,40,${inv * 0.18})`);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,180,60,${inv * 0.6})`;
      ctx.lineWidth = 2 * inv;
      ctx.beginPath(); ctx.arc(f.x, f.y, r * 1.15, 0, Math.PI * 2); ctx.stroke();
    } else if (f.chain) {
      // chain kill: layered expanding rings
      for (let ring = 0; ring < 2; ring++) {
        const rr = f.r * (0.35 + t * 0.65 + ring * 0.25);
        ctx.strokeStyle = `rgba(200,230,255,${inv * (0.45 - ring * 0.15)})`;
        ctx.lineWidth = (1.8 - ring * 0.5) * inv;
        ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (f.kill) {
      // normal kill: slightly larger white flash with ring
      ctx.fillStyle = `rgba(255,255,255,${inv * 0.32})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.5 + t * 0.7), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(200,220,255,${inv * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.6 + t * 0.6), 0, Math.PI * 2); ctx.stroke();
    } else if (f.boss) {
      // boss hit (non-kill): warm orange ring
      ctx.strokeStyle = `rgba(255,180,80,${inv * 0.65})`;
      ctx.lineWidth = 2.5 * inv;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.6 + t * 0.7), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(255,160,60,${inv * 0.15})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.4 + t * 0.6), 0, Math.PI * 2); ctx.fill();
    } else {
      // normal hit: clean small white flash
      ctx.fillStyle = `rgba(255,255,255,${inv * 0.38})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.5 + t * 0.8), 0, Math.PI * 2); ctx.fill();
    }
  }

  // enemies
  for (const e of gs.enemies) {
    if (!e.active || e.deathFlag) continue;
    if (e.phased && Math.floor(Date.now() / 120) % 2 === 0) continue;

    ctx.save();
    ctx.translate(e.x, e.y);

    // hit flash: white overlay composited cleanly
    if (e.flashTimer > 0) {
      ctx.globalAlpha = 0.85 + e.flashTimer * 1.2;
      ctx.filter = 'brightness(2.2)';
    }

    const hpPct = e.hp / e.maxHp;

    if (e.boss) {
      renderBoss(ctx, e, gs, hpPct);
    } else {
      renderEnemyShape(ctx, e, hpPct);
    }

    ctx.filter = 'none';
    ctx.globalAlpha = 1;

    // HP bar for bosses and tankier enemies
    if (e.boss || e.maxHp >= 3) {
      const bw = e.radius * 2.2;
      const bh = 4;
      const bx = -bw / 2;
      const by = e.radius + 6;
      ctx.fillStyle = '#1a1a20';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = hpPct > 0.5 ? '#4a9a5a' : hpPct > 0.25 ? '#c8a840' : '#c84040';
      ctx.fillRect(bx, by, bw * hpPct, bh);
    }

    ctx.restore();
  }
}

function renderEnemyShape(ctx, e, hpPct) {
  switch (e.type) {
    case 'drone': {
      // triangle pointing toward turret
      ctx.fillStyle = '#c84040';
      ctx.beginPath();
      ctx.moveTo(e.radius, 0);
      ctx.lineTo(-e.radius * 0.7, -e.radius * 0.7);
      ctx.lineTo(-e.radius * 0.7, e.radius * 0.7);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'runner': {
      // diamond
      ctx.fillStyle = '#e05020';
      ctx.strokeStyle = '#ff7040';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -e.radius); ctx.lineTo(e.radius * 0.7, 0);
      ctx.lineTo(0, e.radius); ctx.lineTo(-e.radius * 0.7, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // motion trail effect is handled by trail
      break;
    }
    case 'tank': {
      // thick square
      ctx.fillStyle = '#6a3828';
      ctx.strokeStyle = '#a05040';
      ctx.lineWidth = 2;
      const s = e.radius * 0.9;
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      break;
    }
    case 'splitter': {
      // hexagon
      ctx.fillStyle = '#c06820';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        i === 0 ? ctx.moveTo(Math.cos(a) * e.radius, Math.sin(a) * e.radius)
          : ctx.lineTo(Math.cos(a) * e.radius, Math.sin(a) * e.radius);
      }
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'zigzag': {
      // skewed rect
      ctx.fillStyle = '#c8a020';
      ctx.strokeStyle = '#e0c040';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-e.radius, -e.radius * 0.4);
      ctx.lineTo(e.radius * 0.5, -e.radius * 0.7);
      ctx.lineTo(e.radius, e.radius * 0.4);
      ctx.lineTo(-e.radius * 0.5, e.radius * 0.7);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      break;
    }
    case 'orbiter': {
      // small circle
      ctx.fillStyle = '#b07030';
      ctx.strokeStyle = '#d09050';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      break;
    }
  }
}

function renderBoss(ctx, e, gs, hpPct) {
  switch (e.type) {
    case 'boss_corebreaker': {
      // rotating outer shell
      ctx.save();
      ctx.rotate(Date.now() * 0.001);
      ctx.strokeStyle = e.shieldActive ? 'rgba(180,180,220,0.7)' : '#6a4a30';
      ctx.lineWidth = e.shieldActive ? 4 : 2;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(Math.cos(a) * e.radius * 0.7, Math.sin(a) * e.radius * 0.7, 6, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#3a2820';
      ctx.strokeStyle = e.shieldActive ? '#aaaaee' : '#c84030';
      ctx.lineWidth = e.shieldActive ? 5 : 2;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // inner core
      ctx.fillStyle = '#e84030';
      ctx.beginPath(); ctx.arc(0, 0, e.radius * 0.35, 0, Math.PI * 2); ctx.fill();
      if (e.shieldActive) {
        ctx.strokeStyle = 'rgba(180,180,240,0.3)';
        ctx.lineWidth = 8;
        ctx.beginPath(); ctx.arc(0, 0, e.radius + 10, 0, Math.PI * 2); ctx.stroke();
      }
      break;
    }
    case 'boss_splitmonarch': {
      ctx.fillStyle = '#5a3520';
      ctx.strokeStyle = '#e05030';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Date.now() * 0.0005;
        i === 0 ? ctx.moveTo(Math.cos(a) * e.radius, Math.sin(a) * e.radius)
          : ctx.lineTo(Math.cos(a) * e.radius, Math.sin(a) * e.radius);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e05030';
      ctx.beginPath(); ctx.arc(0, 0, e.radius * 0.3, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'boss_pulseentity': {
      ctx.fillStyle = '#303060';
      ctx.strokeStyle = '#6060e0';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8080ff';
      ctx.beginPath(); ctx.arc(0, 0, e.radius * 0.4, 0, Math.PI * 2); ctx.fill();
      if (e.pulsing && e.activePulseRadius) {
        const alpha = Math.max(0, 1 - e.activePulseRadius / 300);
        ctx.strokeStyle = `rgba(120,120,255,${alpha * 0.7})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, e.activePulseRadius, 0, Math.PI * 2); ctx.stroke();
      }
      break;
    }
    case 'boss_swarmcore': {
      ctx.fillStyle = '#3a2030';
      ctx.strokeStyle = '#c040a0';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e060c0';
      ctx.beginPath(); ctx.arc(0, 0, e.radius * 0.3, 0, Math.PI * 2); ctx.fill();
      // orbiting shield visuals
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Date.now() * 0.0015;
        const sx = Math.cos(a) * (e.radius + 20);
        const sy = Math.sin(a) * (e.radius + 20);
        ctx.fillStyle = 'rgba(200,60,160,0.6)';
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'boss_phantom': {
      ctx.fillStyle = `rgba(40,60,80,${e.phased ? 0.3 : 0.9})`;
      ctx.strokeStyle = `rgba(100,160,200,${e.phased ? 0.3 : 0.8})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -e.radius); ctx.lineTo(e.radius, 0);
      ctx.lineTo(0, e.radius); ctx.lineTo(-e.radius, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      break;
    }
    case 'boss_gravitywell': {
      ctx.fillStyle = '#0a0a1a';
      ctx.strokeStyle = '#2030a0';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // warp rings
      for (let r = 1; r <= 3; r++) {
        ctx.strokeStyle = `rgba(40,60,180,${0.2 * (4 - r)})`;
        ctx.lineWidth = 1;
        const warpR = e.radius + r * 18 + Math.sin(Date.now() * 0.003 + r) * 5;
        ctx.beginPath(); ctx.arc(0, 0, warpR, 0, Math.PI * 2); ctx.stroke();
      }
      break;
    }
    case 'boss_ricochet': {
      ctx.fillStyle = '#3a2820';
      ctx.strokeStyle = '#e0a030';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const spikes = 8;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2;
        const r2 = i % 2 === 0 ? e.radius : e.radius * 0.6;
        i === 0 ? ctx.moveTo(Math.cos(a) * r2, Math.sin(a) * r2)
          : ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      break;
    }
    case 'boss_splitterqueen': {
      ctx.fillStyle = '#3a1820';
      ctx.strokeStyle = '#e04060';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const frags = Math.floor(hpPct * 5);
      for (let i = 0; i < frags; i++) {
        const a = (i / 5) * Math.PI * 2 + Date.now() * 0.001;
        ctx.fillStyle = 'rgba(220,60,80,0.5)';
        ctx.beginPath(); ctx.arc(Math.cos(a) * e.radius * 0.8, Math.sin(a) * e.radius * 0.8, 7, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'boss_timeleech': {
      ctx.fillStyle = '#202040';
      ctx.strokeStyle = '#8040c0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, e.radius * 1.4, e.radius * 0.7, Date.now() * 0.0005, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(120,60,200,0.4)';
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(i * 8, 0, e.radius * 1.4 * 0.5, e.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'boss_doomsday': {
      const crackColor = `rgba(255,${80 - hpPct * 60},${40 - hpPct * 40},${(1 - hpPct) * 0.9})`;
      ctx.fillStyle = '#1a1010';
      ctx.strokeStyle = '#c03020';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // cracks
      for (let c = 0; c < e.cracksLevel * 2; c++) {
        const a = (c / (e.cracksLevel * 2)) * Math.PI * 2;
        ctx.strokeStyle = crackColor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * e.radius, Math.sin(a) * e.radius); ctx.stroke();
      }
      // glow at low hp
      if (hpPct < 0.3) {
        ctx.shadowColor = '#ff4020';
        ctx.shadowBlur = 20;
        ctx.fillStyle = 'rgba(255,64,32,0.15)';
        ctx.beginPath(); ctx.arc(0, 0, e.radius + 8, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
      break;
    }
  }
}

function renderParticles(ctx, gs) {
  for (const p of gs.particles) {
    if (!p.active) continue;
    const t = p.life / p.maxLife;
    const alpha = (1 - t) * (1 - t);   // ease-out fade, feels heavier
    ctx.globalAlpha = alpha;

    // soft halo
    if (p.r >= 3) {
      const hGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.5);
      hGrad.addColorStop(0, p.color);
      hGrad.addColorStop(1, 'transparent');
      ctx.globalAlpha = alpha * 0.3;
      ctx.fillStyle = hGrad;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 2.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function renderChainArcs(ctx, gs) {
  if (!gs.chainArcs) return;
  for (const arc of gs.chainArcs) {
    const alpha = arc.life / 0.25;
    ctx.strokeStyle = `rgba(120,160,255,${alpha * 0.8})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // jagged line
    const steps = 6;
    ctx.moveTo(arc.x1, arc.y1);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const mx = arc.x1 + (arc.x2 - arc.x1) * t + (gs.rng.next() - 0.5) * 14;
      const my = arc.y1 + (arc.y2 - arc.y1) * t + (gs.rng.next() - 0.5) * 14;
      ctx.lineTo(mx, my);
    }
    ctx.lineTo(arc.x2, arc.y2);
    ctx.stroke();
  }
}

function renderKbRings(ctx, gs) {
  if (!gs.kbRings) return;
  for (const ring of gs.kbRings) {
    const t = ring.life / ring.maxLife;           // 0→1
    const inv = 1 - t;
    const currentR = ring.maxRadius * (0.15 + t * 0.85);

    // inner hot fill — fades very fast, gives "punch" at center
    if (t < 0.25) {
      const fillAlpha = ((0.25 - t) / 0.25) * 0.28;
      const fillGrad = ctx.createRadialGradient(ring.x, ring.y, 0, ring.x, ring.y, currentR * 0.7);
      fillGrad.addColorStop(0, `rgba(255,210,120,${fillAlpha})`);
      fillGrad.addColorStop(0.5, `rgba(240,140,40,${fillAlpha * 0.5})`);
      fillGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = fillGrad;
      ctx.beginPath(); ctx.arc(ring.x, ring.y, currentR * 0.7, 0, Math.PI * 2); ctx.fill();
    }

    // main expanding ring
    ctx.strokeStyle = `rgba(255,165,45,${inv * 0.7})`;
    ctx.lineWidth = 3 * inv + 0.5;
    ctx.beginPath(); ctx.arc(ring.x, ring.y, currentR, 0, Math.PI * 2); ctx.stroke();

    // secondary outer ring — slightly behind, softer
    const outerR = currentR * 1.18;
    ctx.strokeStyle = `rgba(220,120,30,${inv * 0.3})`;
    ctx.lineWidth = 1.5 * inv;
    ctx.beginPath(); ctx.arc(ring.x, ring.y, outerR, 0, Math.PI * 2); ctx.stroke();
  }
}

function renderGlobalGlow(ctx, gs, dt) {
  if (gs.globalGlow > 0) {
    gs.globalGlow -= dt * 3;
    ctx.fillStyle = `rgba(126,184,212,${gs.globalGlow * 0.06})`;
    ctx.fillRect(0, 0, gs.W, gs.H);
  }
}

// ─── INIT / START RUN ────────────────────────────────────────
function initCanvas(gs) {
  const canvas = document.getElementById('game-canvas');
  gs.canvas = canvas;
  gs.ctx = canvas.getContext('2d');

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const topBar = document.getElementById('top-bar');
    const topBarH = topBar ? topBar.offsetHeight : 60;
    canvas.width = w;
    canvas.height = h;
    gs.W = w; gs.H = h;

    const pad = C.ARENA_PADDING;
    gs.arenaX = pad;
    gs.arenaY = topBarH + pad;
    gs.arenaW = w - pad * 2;
    gs.arenaH = h - topBarH - pad * 2;
    gs.cx = w / 2;
    gs.cy = topBarH + gs.arenaH / 2 + pad;
    gs.maxHp = gs._pMaxHp || C.TURRET_HP;
  }

  resize();
  window.addEventListener('resize', resize);
}

function startRun(gs, seedStr) {
  const seed = seedStr || String(Math.floor(Math.random() * 999999));
  gs.seed = seed;
  document.getElementById('seed-input').value = seed;
  gs.rng = new SeededRNG(seed);

  gs.score = 0;
  gs.currency = 0;
  gs.hp = gs._pMaxHp || C.TURRET_HP;
  gs.maxHp = gs._pMaxHp || C.TURRET_HP;
  gs.time = 0;
  gs.kills = 0;
  gs.runKills = 0;
  gs.killBar = 0;
  gs.bestShotRun = 0;
  gs.reloadTimer = 0;
  gs.canShoot = true;
  gs.reloadBarVisible = false;
  gs.reloadBarFadeTimer = 0;
  gs.aiming = false;
  gs.bullets = [];
  gs.enemies = [];
  gs.particles = [];
  gs.chainArcs = [];
  gs.spawnTimer = 0;
  gs.bossCount = 0;
  gs.activeBoss = null;
  gs.bossCountdown = C.BOSS_INTERVAL_FIRST;
  gs.bossUnlocked = false;
  gs.runUpgrades = {};
  gs.timeScale = 1;
  gs.slowTimer = 0;
  gs.globalGlow = 0;
  gs.kbRings = [];
  gs.barrelAngle = 0;
  gs.aimCharge = 0;
  gs.muzzleFlash = 0;
  gs.impactFlashes = [];
  // ── bullet personality drift ──
  gs.drift = {
    totalBounces: 0, totalSplits: 0,
    totalBulletKills: 0, totalBulletsFired: 0,
    totalBulletLifetime: 0, peakCombo: 0,
    bounceScore: 0, splitScore: 0, killChainScore: 0, lifetimeScore: 0,
  };
  _upgradeSelectPending = false;

  gs.state = 'RUNNING';

  document.getElementById('main-menu').classList.add('hidden');
  document.getElementById('main-menu').classList.remove('active');
  document.getElementById('game-over').classList.remove('active');
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('pause-menu').classList.remove('active');
  document.getElementById('pause-menu').classList.add('hidden');
  document.getElementById('upgrade-selection').classList.remove('active');
  document.getElementById('upgrade-selection').classList.add('hidden');
  document.getElementById('game-ui').classList.remove('hidden');
  document.getElementById('boss-warning').classList.add('hidden');

  updateUI(gs);
}

// ─── INPUT ───────────────────────────────────────────────────
function setupInput(gs) {
  const canvas = gs.canvas;

  function getCanvasPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // MOUSE
  canvas.addEventListener('mousemove', (e) => {
    const pos = getCanvasPos(e.clientX, e.clientY);
    gs.mouse.x = pos.x;
    gs.mouse.y = pos.y;
    if (gs.aiming) gs.aimEnd = { ...pos };
  });

  canvas.addEventListener('mousedown', (e) => {
    if (gs.state !== 'RUNNING') return;
    const pos = getCanvasPos(e.clientX, e.clientY);
    gs.aiming = true;
    gs.aimStart = { ...pos };
    gs.aimEnd = { ...pos };
    e.preventDefault();
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!gs.aiming) return;
    const pos = getCanvasPos(e.clientX, e.clientY);
    gs.aimEnd = { ...pos };
    gs.aiming = false;
    if (gs.state === 'RUNNING') {
      const angle = Math.atan2(pos.y - gs.cy, pos.x - gs.cx) + Math.PI;
      fireBullet(gs, angle);
    }
  });

  // TOUCH
  let touchId = null;
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (gs.state !== 'RUNNING') return;
    const touch = e.changedTouches[0];
    touchId = touch.identifier;
    const pos = getCanvasPos(touch.clientX, touch.clientY);
    gs.aiming = true;
    gs.aimStart = { ...pos };
    gs.aimEnd = { ...pos };
    gs.mouse = { ...pos };
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchId) {
        const pos = getCanvasPos(touch.clientX, touch.clientY);
        gs.aimEnd = { ...pos };
        gs.mouse = { ...pos };
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchId) {
        touchId = null;
        const pos = getCanvasPos(touch.clientX, touch.clientY);
        gs.aiming = false;
        if (gs.state === 'RUNNING') {
          const angle = Math.atan2(pos.y - gs.cy, pos.x - gs.cx) + Math.PI;
          fireBullet(gs, angle);
        }
      }
    }
  }, { passive: false });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (gs.state === 'RUNNING') {
        gs.state = 'PAUSED';
        gs.timeScale = 0;
        showPauseMenu(gs);
      } else if (gs.state === 'PAUSED') {
        gs.state = 'RUNNING';
        gs.timeScale = 1;
        document.getElementById('pause-menu').classList.remove('active');
        document.getElementById('pause-menu').classList.add('hidden');
      }
    }
  });
}

function showPauseMenu(gs) {
  const el = document.getElementById('pause-menu');
  const stats = document.getElementById('pause-stats');
  el.classList.remove('hidden');
  el.classList.add('active');
  const mins = Math.floor(gs.time / 60);
  const secs = Math.floor(gs.time % 60);
  stats.innerHTML = `
    <div class="pause-stat-row"><span>SCORE</span><span>${gs.score}</span></div>
    <div class="pause-stat-row"><span>TIME</span><span>${mins}:${secs.toString().padStart(2, '0')}</span></div>
    <div class="pause-stat-row"><span>KILLS</span><span>${gs.runKills}</span></div>
    <div class="pause-stat-row"><span>SEED</span><span>${gs.seed}</span></div>
  `;
}

// ─── BOOTSTRAP ───────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const gs = window._gs = GS;
  gs.permData = Save.load();
  applyPermUpgrades(gs);
  gs.maxHp = gs._pMaxHp || C.TURRET_HP;

  initCanvas(gs);
  setupInput(gs);
  updateMenuStats(gs);

  // button wiring
  document.getElementById('btn-start').addEventListener('click', () => {
    const seed = document.getElementById('seed-input').value.trim() || null;
    startRun(gs, seed);
  });

  document.getElementById('btn-random-seed').addEventListener('click', () => {
    document.getElementById('seed-input').value = Math.floor(Math.random() * 999999).toString();
  });

  document.getElementById('btn-upgrades-menu').addEventListener('click', () => {
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('active');
    showPermUpgradePanel(gs, 'MENU');
  });

  document.getElementById('btn-pause').addEventListener('click', () => {
    if (gs.state === 'RUNNING') {
      gs.state = 'PAUSED';
      gs.timeScale = 0;
      showPauseMenu(gs);
    }
  });

  document.getElementById('btn-upgrade-tab').addEventListener('click', () => {
    if (gs.state === 'RUNNING' || gs.state === 'PAUSED') {
      gs.state = 'PAUSED';
      gs.timeScale = 0;
      showPermUpgradePanel(gs, 'PAUSE');
    }
  });

  document.getElementById('btn-resume').addEventListener('click', () => {
    gs.state = 'RUNNING';
    gs.timeScale = 1;
    document.getElementById('pause-menu').classList.remove('active');
    document.getElementById('pause-menu').classList.add('hidden');
  });

  document.getElementById('btn-upgrades-pause').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.remove('active');
    document.getElementById('pause-menu').classList.add('hidden');
    showPermUpgradePanel(gs, 'PAUSE');
  });

  document.getElementById('btn-quit').addEventListener('click', () => {
    triggerGameOver(gs);
    document.getElementById('pause-menu').classList.remove('active');
    document.getElementById('pause-menu').classList.add('hidden');
  });

  document.getElementById('btn-reset-progress').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.remove('active');
    document.getElementById('pause-menu').classList.add('hidden');
    document.getElementById('reset-confirm').classList.remove('hidden');
    document.getElementById('reset-confirm').classList.add('active');
  });

  document.getElementById('btn-reset-confirm-no').addEventListener('click', () => {
    document.getElementById('reset-confirm').classList.remove('active');
    document.getElementById('reset-confirm').classList.add('hidden');
    // go back to pause
    showPauseMenu(gs);
  });

  document.getElementById('btn-reset-confirm-yes').addEventListener('click', () => {
    // full wipe
    Save.reset();
    gs.permData = Save.load();   // fresh defaults
    applyPermUpgrades(gs);
    gs.maxHp = gs._pMaxHp || C.TURRET_HP;

    document.getElementById('reset-confirm').classList.remove('active');
    document.getElementById('reset-confirm').classList.add('hidden');

    // force game over → go to menu so run ends cleanly
    gs.state = 'MENU';
    gs.timeScale = 0;
    document.getElementById('game-ui').classList.add('hidden');
    document.getElementById('game-over').classList.remove('active');
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('pause-menu').classList.remove('active');
    document.getElementById('pause-menu').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
    document.getElementById('main-menu').classList.add('active');

    updateMenuStats(gs);
  });

  document.getElementById('btn-restart').addEventListener('click', () => {
    document.getElementById('game-over').classList.remove('active');
    document.getElementById('game-over').classList.add('hidden');
    startRun(gs, null);
    updateMenuStats(gs);
  });

  document.getElementById('btn-upgrades-gameover').addEventListener('click', () => {
    showPermUpgradePanel(gs, 'GAMEOVER');
  });

  document.getElementById('btn-main-menu').addEventListener('click', () => {
    document.getElementById('game-over').classList.remove('active');
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('game-ui').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
    document.getElementById('main-menu').classList.add('active');
    gs.state = 'MENU';
    updateMenuStats(gs);
  });

  // start loop
  gs.lastTime = performance.now();
  requestAnimationFrame(gameLoop);
});
