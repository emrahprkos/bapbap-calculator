import { collectEntries, computeStats, castDamage, intake, cooldown, regen, fmt, STAT_LABELS } from './calc.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\{(\d+)\}/g, '…');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Augment effects that the calculator computes beyond their stat entries (code-traced).
const EFFECT_CALC = {
  278: 'Healing Skills heal', // trunc(maxHp × healMaxHpPercentage) on ability hit vs a player, ~2.52 s internal cooldown
  99: 'More Rocks More Muscle', // Rocky Earthquake: + max(0, trunc((maxHp − baseHp) × 0.7)) added to base damage
};
const STAT_ONLY = (a) => a.trigger === 'pickup / level-up';
const augClass = (a) => (STAT_ONLY(a) || EFFECT_CALC[a.id]) ? 'calc' : (a.status === 'unsupported' ? 'desc' : 'part');
const AUG_BADGE = { calc: ['calc', 'Calculated'], part: ['part', 'Effect described'], desc: ['desc', 'Description only'] };

let D, augById, charById;
const state = { char: 12, picks: [], target: { char: 12, hp: 0, shield: 0, def: 0, thorns: 0 }, crit: false, league: false };
let filter = 'all', query = '';

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }

function encodeBuild() {
  const b = { c: state.char, p: state.picks.map((p) => [p.id, p.level]), t: state.target, x: state.crit ? 1 : 0, l: state.league ? 1 : 0 };
  return btoa(unescape(encodeURIComponent(JSON.stringify(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBuild(s) {
  try {
    const b = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
    if (!charById.has(b.c)) return false;
    state.char = b.c;
    state.picks = (b.p || []).filter(([id]) => augById.has(id)).map(([id, level]) => ({ id, level: Math.max(1, level | 0) }));
    state.target = { ...state.target, ...(b.t || {}) };
    if (!charById.has(state.target.char)) state.target.char = state.char;
    state.crit = !!b.x; state.league = !!b.l;
    return true;
  } catch { return false; }
}

function available(a) {
  const ch = charById.get(state.char);
  return a.kind === 'generic' || a.chars.includes(ch.name);
}
function blockedReason(a) {
  if (state.league && D.league.disabledAugments.includes(a.id)) return 'Disabled by league preset';
  const pickedIds = state.picks.map((p) => p.id);
  const inc = (a.incompatible || []).find((x) => pickedIds.includes(x));
  if (inc != null) return `Incompatible with ${augById.get(inc)?.name || inc}`;
  for (const p of state.picks) { const o = augById.get(p.id); if ((o.incompatible || []).includes(a.id)) return `Incompatible with ${o.name}`; }
  return null;
}
function maxLevel(a) { return Math.max(1, a.levels.length); }

function addAug(id) {
  const a = augById.get(id);
  const ex = state.picks.find((p) => p.id === id);
  if (ex) {
    if (ex.level < maxLevel(a)) ex.level++; else return toast(`${a.name} is already at its max level`);
  } else state.picks.push({ id, level: 1 });
  render();
}

function applyLeague() {
  if (!state.league) return;
  const removed = state.picks.filter((p) => D.league.disabledAugments.includes(p.id));
  if (removed.length) {
    state.picks = state.picks.filter((p) => !removed.includes(p));
    toast(`Removed ${removed.map((p) => augById.get(p.id).name).join(', ')} (league preset)`);
  }
  if (D.league.bannedCharacters.includes(state.char)) {
    const next = D.characters.find((c) => !D.league.bannedCharacters.includes(c.id));
    toast(`${charById.get(state.char).name} is banned under the league preset; switched to ${next.name}`);
    state.char = next.id; state.picks = state.picks.filter((p) => available(augById.get(p.id)));
  }
}

// ---------- rendering ----------
function renderChars() {
  $('#chars').innerHTML = D.characters.map((c) => {
    const banned = state.league && D.league.bannedCharacters.includes(c.id);
    return `<button class="char ${c.id === state.char ? 'on' : ''} ${banned ? 'banned' : ''}" data-id="${c.id}" role="option" aria-selected="${c.id === state.char}">
      ${esc(c.name)}<small>${c.baseHp} HP</small>${banned ? '<span class="ban">BANNED</span>' : ''}</button>`;
  }).join('');
  $('#tChar').innerHTML = D.characters.map((c) => `<option value="${c.id}" ${c.id === state.target.char ? 'selected' : ''}>${esc(c.name)} (${c.baseHp} HP)</option>`).join('');
}

function renderPicked() {
  $('#pickCount').textContent = state.picks.length ? `${state.picks.length} selected` : '';
  $('#picked').innerHTML = state.picks.map((p) => {
    const a = augById.get(p.id), ml = maxLevel(a), [cls, lab] = AUG_BADGE[augClass(a)];
    return `<div class="pick"><span class="name" title="${esc(a.desc)}">${esc(a.name)}</span><span class="badge ${cls}">${lab}</span>
      ${ml > 1 ? `<span class="stepper"><button data-lv="-1" data-id="${a.id}" aria-label="Lower level">−</button><span>L${p.level}/${ml}</span><button data-lv="1" data-id="${a.id}" aria-label="Raise level">+</button></span>` : ''}
      <button class="x" data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">×</button></div>`;
  }).join('') || '<div class="empty">No augments selected. Add some below.</div>';
}

function statLine(a) {
  const all = [...a.stats.map((s) => ({ ...s, h: true }))];
  if (a.levels.length) a.levels[0].stats.forEach((s) => all.push(s));
  return all.map((s) => `${STAT_LABELS[s.stat] || s.stat} ${s.value > 0 ? '+' : ''}${fmt(s.value)}${s.h ? '*' : ''}`).join(', ');
}

function renderAugList() {
  const q = query.trim().toLowerCase();
  const list = D.augments.filter((a) => available(a) && (filter === 'all' || a.kind === filter) &&
    (!q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)));
  $('#augList').innerHTML = list.map((a) => {
    const reason = blockedReason(a), [cls, lab] = AUG_BADGE[augClass(a)], st = statLine(a);
    const picked = state.picks.find((p) => p.id === a.id);
    return `<div class="aug ${reason ? 'disabled' : ''}">
      <span class="name">${esc(a.name)}</span>
      <button data-add="${a.id}" ${reason ? 'disabled' : ''} aria-label="Add ${esc(a.name)}">${picked ? (picked.level < maxLevel(a) ? 'Level up' : 'Max') : 'Add'}</button>
      <span class="d">${esc(clean(a.desc)) || '<i>No description text</i>'}</span>
      <span class="meta"><span class="badge ${cls}">${lab}</span>
        ${a.kind === 'character' ? `<span class="badge code">${esc(a.chars.join(', '))}</span>` : ''}
        ${a.levels.length > 1 ? `<span class="muted">${a.levels.length} levels</span>` : ''}
        ${!a.offeredNormally ? '<span class="badge warn">Not in offer pools</span>' : ''}
        ${a.statsUncertain ? '<span class="badge warn">Stats may not apply</span>' : ''}
        ${reason ? `<span class="badge off">${esc(reason)}</span>` : ''}
        ${st ? `<span class="muted">${esc(st)}</span>` : ''}</span>
    </div>`;
  }).join('') || '<div class="empty">No augments match.</div>';
}

function compute() {
  const ch = charById.get(state.char);
  const entries = collectEntries(state.picks, augById);
  const { stats, unknown } = computeStats(ch, entries);
  const base = computeStats(ch, []).stats;
  return { ch, entries, stats, unknown, base };
}

function renderStats(c) {
  const { ch, stats: s, base: b } = c;
  const row = (k, v, bv, f = (x) => fmt(x)) => {
    const d = v - bv;
    return `<div class="stat"><div class="k">${k}</div><div class="v">${f(v)}${Math.abs(d) > 1e-9 ? `<span class="delta ${d < 0 ? 'neg' : ''}">${d > 0 ? '+' : '−'}${String(f(Math.abs(d))).replace(/^[×÷]/, '')}</span>` : ''}</div></div>`;
  };
  const pct = (x) => `${fmt(x * 100, 1)}%`;
  $('#charTitle').textContent = `${ch.name}${ch.title ? ' — ' + ch.title : ''}`;
  $('#stats').innerHTML = [
    row('Max HP', s.maxHp, b.maxHp), row('Damage (flat)', s.dmg, b.dmg), row('Damage modifier', s.dmgMod, b.dmgMod, (x) => '×' + fmt(x)),
    row('Crit chance', s.critChance, b.critChance, pct), row('Crit damage', s.critDmg, b.critDmg, (x) => '×' + fmt(x)),
    row('Cooldown stat', s.cooldown, b.cooldown, (x) => '÷' + fmt(x)), row('Attack speed', s.attackSpeed, b.attackSpeed, (x) => '×' + fmt(x)),
    row('Lifesteal', s.lifesteal, b.lifesteal, pct), row('Defense', 1 - s.dmgTakenMod, 0, pct), row('Shred', s.shred, 0, pct),
    row('Thorns', s.thorns, 0, pct), row('HP regen bonus', s.regenAdd, 0), row('Move speed bonus', s.moveSpeedAdd, 0), row('Luck', s.luck, 0),
  ].join('');
  $('#statBadge').innerHTML = '<span class="badge code">Code-derived stat pipeline</span>';
}

function warningsFor(c) {
  const out = [], perSlot = {};
  const notIn = [];
  for (const p of state.picks) {
    const a = augById.get(p.id), k = augClass(a);
    if (k === 'calc') continue;
    if (a.targetSlot != null) (perSlot[a.targetSlot] ||= []).push(a);
    else notIn.push(a);
  }
  if (notIn.length) out.push(`<div class="alert warn"><b>Some selected effects are not in the numbers</b>Their stats (if any) are included, but these effects are not, so every damage, healing and cooldown result below may be incomplete:<ul>${notIn.map((a) => `<li><b>${esc(a.name)}</b> — ${augClass(a) === 'desc' ? 'not traced' : esc(a.formula.slice(0, 220)) + (a.formula.length > 220 ? '…' : '')}</li>`).join('')}</ul></div>`);
  const unc = state.picks.map((p) => augById.get(p.id)).filter((a) => a.statsUncertain);
  if (unc.length) out.push(`<div class="alert warn"><b>Stats that may not apply</b>${unc.map((a) => esc(a.name)).join(', ')}: the game code overrides their activation without the usual stat step. Their listed stats are included here but could be absent in-game (not yet live-checked).</div>`);
  if (c.unknown.length) out.push(`<div class="alert warn"><b>Stat entries without a calculator effect</b>${c.unknown.map((e) => `${esc(e.source)}: ${esc(e.stat)} ${fmt(e.value)}`).join('; ')}. These stat types have no effect in the game's stat step or their formula is unknown.</div>`);
  if (state.league && D.league.bannedCharacters.includes(state.target.char)) out.push(`<div class="alert bad"><b>League preset</b>The target character is banned under the league preset.</div>`);
  return { html: out.join(''), perSlot };
}

function partResult(ab, part, c, tgt, slotWarn) {
  const { stats: s, ch } = c;
  let p = { ...part };
  const extra = [];
  if (state.picks.some((x) => x.id === 99) && ch.name === 'Rocky' && ab.cmdId === 3) {
    const bonus = Math.max(0, Math.trunc((s.maxHp - ch.baseHp) * 0.7));
    extra.push({ label: `More Rocks More Muscle: + trunc((maxHp ${s.maxHp} − base ${ch.baseHp}) × 0.7)`, value: bonus });
    p = { ...p, base: p.base + bonus };
  }
  const nc = castDamage(p, s);
  const cr = ab.crit ? castDamage(p, s, { crit: true }) : null;
  const tin = intake(nc.raw, s, tgt), tcr = cr ? intake(cr.raw, s, tgt) : null;
  const pCrit = ab.crit ? Math.min(1, Math.max(0, s.critChance)) : 0;
  const expected = (1 - pCrit) * tin.dmg + pCrit * (tcr ? tcr.dmg : tin.dmg);
  const effHp = tgt.hp + tgt.shield;
  const kill = tin.dmg > 0 ? Math.ceil(effHp / tin.dmg) : null;
  const cleanBase = s.dmg === 0 && !extra.length;
  // Live label is scoped to the exact tested conditions: training session 2026-11-16, no augments, Dmg 0,
  // damage modifier 1, non-crit, target without defense. Mitigation, lifesteal, thorns and kill counts are never live-tested.
  const live = part.liveBase && cleanBase && s.dmgMod === 1 && state.picks.length === 0 && tgt.def === 0 && !slotWarn;
  const badge = live
    ? '<span class="badge live" title="The per-hit value was observed in game (training, 2026-11-16) under these exact conditions: no augments, Dmg 0, ×1 damage modifier, non-crit, no target defense. Other figures on this card are code-derived.">Live-verified hit</span>'
    : '<span class="badge code" title="Computed from code-traced formulas; not observed under these conditions">Code-derived</span>';
  const label = ab.tickRate ? 'per tick' : 'per hit';
  const ticks = ab.tickRate && ab.ttl ? Math.floor(ab.ttl / ab.tickRate + 1e-9) : null;
  const steps = [...extra, ...nc.steps, ...tin.steps, { label: `damage to ${tgt.name}`, value: tin.dmg }];
  return `<div class="part">
    <div class="row-between"><span class="muted">${esc(part.key)} · ${p.base} + ${part.scaling}×Dmg · ${label}</span>${badge}</div>
    <div class="nums">
      <div class="num"><span class="k">Hit (${label})</span><span class="v">${tin.dmg}</span></div>
      ${tcr && state.crit ? `<div class="num"><span class="k">Crit hit</span><span class="v">${tcr.dmg}</span></div>` : ''}
      ${ab.crit && pCrit > 0 ? `<div class="num"><span class="k">Expected (crit ${fmt(pCrit * 100, 1)}%)</span><span class="v small">${fmt(expected, 1)}</span></div>` : ''}
      ${ticks ? `<div class="num"><span class="k">≈ ${ticks} ticks over ${ab.ttl}s</span><span class="v small">${tin.dmg * ticks}</span></div>` : ''}
      ${kill ? `<div class="num"><span class="k">Hits to deplete ${effHp}</span><span class="v small">${kill}</span></div>` : ''}
      ${tin.heal ? `<div class="num"><span class="k">Lifesteal heal</span><span class="v small">+${tin.heal}</span></div>` : ''}
      ${tin.thorns ? `<div class="num"><span class="k">Thorns back to you</span><span class="v small">−${tin.thorns}</span></div>` : ''}
    </div>
    <details class="breakdown"><summary>Calculation breakdown</summary><ul class="steps">${steps.map((x) => `<li class="${x.rounding ? 'r' : ''}"><span>${esc(x.label)}</span><b>${fmt(x.value)}</b></li>`).join('')}
      ${tin.heal ? `<li class="r"><span>lifesteal: ceil(${tin.dmg} × ${fmt(s.lifesteal)})</span><b>${tin.heal}</b></li>` : ''}
      ${tin.thorns ? `<li class="r"><span>thorns: floor(${tin.dmg} × ${fmt(tgt.thorns)})</span><b>${tin.thorns}</b></li>` : ''}</ul>
      ${ticks ? '<p class="hint">Tick count is approximate (ttl ÷ tick rate); exact tick timing is not modelled.</p>' : ''}
      ${!ab.crit ? '<p class="hint">This hit cannot crit (enableCritDmg = false).</p>' : ''}</details>
  </div>`;
}

function renderAbilities(c, perSlot) {
  const { ch, stats: s } = c;
  const tc = charById.get(state.target.char);
  const tgt = { name: tc.name, hp: tc.baseHp + (+state.target.hp || 0), shield: Math.max(0, +state.target.shield || 0), def: +state.target.def || 0, defense: +state.target.def || 0, thorns: +state.target.thorns || 0 };
  $('#abilities').innerHTML = ch.abilities.map((ab) => {
    const cd = cooldown(ab, s);
    const sw = perSlot[ab.cmdId];
    return `<div class="card ability">
      <div class="ab-head"><div><div class="slot">${esc(ab.slot)}</div><h3>${esc(ab.title)}</h3></div>
        ${cd ? `<div class="num"><span class="k">Cooldown</span><span class="v small">${fmt(cd.value, 2)}s</span></div>` : ''}</div>
      ${ab.tooltip ? `<p class="tooltip">${esc(clean(ab.tooltip))}</p>` : ''}
      ${sw ? `<div class="incomplete">⚠ Incomplete: ${sw.map((a) => esc(a.name)).join(', ')} changes this ability; that change is not in these numbers.</div>` : ''}
      ${ab.parts.length ? ab.parts.map((p) => partResult(ab, p, c, tgt, sw)).join('') : '<p class="hint">No direct damage values for this ability (utility, or values live in spawned objects).</p>'}
      ${cd && cd.steps.length > 1 ? `<details class="breakdown"><summary>Cooldown breakdown</summary><ul class="steps">${cd.steps.map((x) => `<li><span>${esc(x.label)}</span><b>${fmt(x.value, 3)}s</b></li>`).join('')}</ul></details>` : ''}
    </div>`;
  }).join('');
}

function renderHealing(c) {
  const { ch, stats: s } = c;
  const r = regen(ch, s);
  let h = `<div class="nums">
    <div class="num"><span class="k">Regen in combat</span><span class="v small">${r.inCombat}/s</span></div>
    <div class="num"><span class="k">Regen after ${r.delay}s unhit</span><span class="v small">${r.outOfCombat + r.inCombat}/s</span></div>
    <div class="num"><span class="k">Lifesteal</span><span class="v small">${fmt(s.lifesteal * 100, 1)}%</span></div></div>
    <p class="hint">${s.regenAdd ? '<span class="badge code">Code-derived</span> HP-regen bonus added to both ticks (stat → regen field mapping partly inferred).' : '<span class="badge live">Live-verified</span> base regen: 0 in combat, +25/s from about 6 s after the last hit. Heals never exceed max HP.'}</p>`;
  if (state.picks.some((p) => p.id === 278)) {
    const a = augById.get(278);
    const pctv = a.values.healMaxHpPercentage ?? a.levels[0]?.values?.healMaxHpPercentage ?? 0.15;
    h += `<div class="part"><div class="row-between"><b>Healing Skills</b><span class="badge code">Code-derived</span></div>
      <div class="nums"><div class="num"><span class="k">Heal per ability hit on a player</span><span class="v">${Math.trunc(s.maxHp * pctv)}</span></div></div>
      <p class="hint">trunc(maxHp ${s.maxHp} × ${pctv}); primary attacks excluded; about once per 2.5 s.</p></div>`;
  }
  $('#healing').innerHTML = h;
}

function renderSaved() {
  const builds = store.get('bapbap-calc-builds', []);
  $('#saved').innerHTML = builds.map((b, i) => `<div class="item"><button class="load" data-load="${i}">${esc(b.name)} <span class="muted">· ${esc(charById.get(b.char)?.name || '?')}</span></button><button class="x" data-del="${i}" aria-label="Delete ${esc(b.name)}">×</button></div>`).join('') || '<div class="empty">Saved builds stay in this browser.</div>';
}

function render() {
  applyLeague();
  renderChars(); renderPicked(); renderAugList();
  const c = compute();
  renderStats(c);
  const w = warningsFor(c);
  $('#warnings').innerHTML = w.html;
  renderAbilities(c, w.perSlot);
  renderHealing(c);
  $('#league').checked = state.league; $('#crit').checked = state.crit;
  for (const [id, k] of [['tHp', 'hp'], ['tShield', 'shield'], ['tDef', 'def'], ['tThorns', 'thorns']]) if (document.activeElement !== $('#' + id)) $('#' + id).value = state.target[k];
  history.replaceState(null, '', '#b=' + encodeBuild());
}

// ---------- events ----------
function bind() {
  $('#chars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    const id = +b.dataset.id;
    if (state.league && D.league.bannedCharacters.includes(id)) return toast(`${charById.get(id).name} is banned under the league preset`);
    state.char = id;
    const before = state.picks.length;
    state.picks = state.picks.filter((p) => available(augById.get(p.id)));
    if (state.picks.length < before) toast('Removed character augments that belong to another character');
    render();
  });
  $('#augList').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b && !b.disabled) addAug(+b.dataset.add); });
  $('#picked').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]'); if (rm) { state.picks = state.picks.filter((p) => p.id !== +rm.dataset.rm); return render(); }
    const lv = e.target.closest('[data-lv]'); if (!lv) return;
    const p = state.picks.find((x) => x.id === +lv.dataset.id), a = augById.get(p.id);
    p.level = Math.max(1, Math.min(maxLevel(a), p.level + +lv.dataset.lv)); render();
  });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderAugList(); });
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b)); filter = b.dataset.f; renderAugList();
  }));
  $('#league').addEventListener('change', (e) => { state.league = e.target.checked; render(); });
  $('#crit').addEventListener('change', (e) => { state.crit = e.target.checked; render(); });
  $('#tChar').addEventListener('change', (e) => { state.target.char = +e.target.value; render(); });
  for (const [id, k] of [['tHp', 'hp'], ['tShield', 'shield'], ['tDef', 'def'], ['tThorns', 'thorns']])
    $('#' + id).addEventListener('input', (e) => { const v = parseFloat(e.target.value); state.target[k] = Number.isFinite(v) ? v : 0; render(); });
  $('#save').addEventListener('click', () => {
    const name = $('#buildName').value.trim() || `${charById.get(state.char).name} build`;
    const builds = store.get('bapbap-calc-builds', []);
    builds.unshift({ name, char: state.char, code: encodeBuild() }); store.set('bapbap-calc-builds', builds.slice(0, 50));
    $('#buildName').value = ''; renderSaved(); toast('Build saved in this browser');
  });
  $('#saved').addEventListener('click', (e) => {
    const builds = store.get('bapbap-calc-builds', []);
    const l = e.target.closest('[data-load]'); if (l) { decodeBuild(builds[+l.dataset.load].code); render(); return toast('Build loaded'); }
    const d = e.target.closest('[data-del]'); if (d) { builds.splice(+d.dataset.del, 1); store.set('bapbap-calc-builds', builds); renderSaved(); }
  });
  $('#share').addEventListener('click', async () => {
    const url = location.href.split('#')[0] + '#b=' + encodeBuild();
    try { await navigator.clipboard.writeText(url); toast('Share link copied'); } catch { prompt('Copy this link:', url); }
  });
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store.set('bapbap-calc-theme', next);
  });
  window.addEventListener('hashchange', () => { const m = location.hash.match(/#b=(.+)/); if (m && m[1] !== encodeBuild() && decodeBuild(m[1])) render(); });
}

async function main() {
  const th = store.get('bapbap-calc-theme', null); if (th) document.documentElement.dataset.theme = th;
  D = await (await fetch('data.json')).json();
  augById = new Map(D.augments.map((a) => [a.id, a]));
  charById = new Map(D.characters.map((c) => [c.id, c]));
  $('#build').textContent = `${D.build.metadata} · data ${D.generated}`;
  const m = location.hash.match(/#b=(.+)/);
  if (!(m && decodeBuild(m[1]))) { state.char = charById.has(12) ? 12 : D.characters[0].id; state.target.char = state.char; }
  bind(); renderSaved(); render();
  requestAnimationFrame(() => document.body.classList.add("ready"));
  if (location.search.includes('probe')) { // layout self-check used by local browser tests
    const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map((el) => (el.id || el.className || el.tagName) + ":" + (el.type || "") + ":" + Math.round(el.getBoundingClientRect().left) + "-" + Math.round(el.getBoundingClientRect().right));
    document.title = `probe league=${document.querySelector('#league').checked} track=${getComputedStyle(document.querySelector('.track')).backgroundColor} vw=${innerWidth} sw=${document.documentElement.scrollWidth} over=${wide.join('|')}`;
  }
}
main().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div class="alert bad" style="margin:16px"><b>Could not load data</b>${esc(e.message)}</div>`); });
