// BAPBAP calculation engine. Formulas from the mechanics reference (code-traced), with live checks noted.
// Pure functions only, so they can be unit-tested in Node.
const f32 = Math.fround;
const trunc = (x) => Math.trunc(x);
// C# Math.Round default = banker's rounding (round half to even).
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

export const STAT_LABELS = {
  Hp: 'Max HP', HpPercent: 'Max HP % (of base)', Dmg: 'Damage (flat)', DmgPercent: 'Damage %',
  CooldownReduction: 'Cooldown reduction', AtkSpeed: 'Attack speed', CritChance: 'Crit chance', CritDmg: 'Crit damage',
  Lifesteal: 'Lifesteal', Shred: 'Shred', Luck: 'Luck', Thorns: 'Thorns', Defense: 'Defense', MoveSpeed: 'Move speed',
  HpRegen: 'HP regen', Shield: 'Shield', Cooldown: 'Cooldown',
};

/** Collect stat entries from picks. picks: [{id, level}] */
export function collectEntries(picks, augById) {
  const entries = [];
  for (const p of picks) {
    const a = augById.get(p.id);
    if (!a) continue;
    for (const s of a.stats) entries.push({ ...s, source: a.name, kind: 'hidden', uncertain: a.statsUncertain });
    const lv = Math.max(1, Math.min(p.level || 1, a.levels.length || 1));
    for (let i = 0; i < Math.min(lv, a.levels.length); i++) {
      for (const s of a.levels[i].stats) entries.push({ ...s, source: `${a.name} L${i + 1}`, kind: 'level', uncertain: false });
    }
  }
  return entries;
}

/** Apply stat entries in pick order (CharItems.ActivateItemStat). */
export function computeStats(ch, entries, { includeUncertain = true } = {}) {
  const s = {
    maxHp: ch.baseHp, dmg: 0, dmgMod: 1, cooldown: 1, attackSpeed: 1, critChance: ch.critChance, critDmg: ch.critDmg,
    lifesteal: ch.lifesteal, shred: 0, luck: 0, thorns: 0, dmgTakenMod: 1, moveSpeedAdd: 0, regenAdd: 0,
    maxAttackSpeed: ch.maxAttackSpeed,
  };
  const ignored = [], unknown = [];
  for (const e of entries) {
    if (e.uncertain && !includeUncertain) { ignored.push(e); continue; }
    const v = e.value;
    switch (e.stat) {
      case 'Hp': s.maxHp += trunc(v); break;
      case 'HpPercent': s.maxHp += roundHalfEven(f32(ch.baseHp * v)); break;
      case 'Dmg': s.dmg += v; break;
      case 'DmgPercent': s.dmgMod += v; break;
      case 'CooldownReduction': s.cooldown += v; break;
      case 'AtkSpeed': s.attackSpeed += v; break;
      case 'CritChance': s.critChance += v; break;
      case 'CritDmg': s.critDmg += v; break;
      case 'Lifesteal': s.lifesteal += v; break;
      case 'Shred': s.shred += v; break;
      case 'Luck': s.luck += v; break;
      case 'Thorns': s.thorns += v; break;
      case 'Defense': s.dmgTakenMod -= v; break;
      case 'MoveSpeed': s.moveSpeedAdd += v; break;
      case 'HpRegen': s.regenAdd += trunc(v); break;
      default: unknown.push(e);
    }
  }
  return { stats: s, ignored, unknown };
}

/** Stage A (cast): CharAbilities.GetModifiedDamage. */
export function castDamage(part, st, { crit = false, modeMult = 1, extraMult = 1 } = {}) {
  const base = f32(part.base + f32(part.scaling * st.dmg));
  let x = base;
  const steps = [{ label: `base ${part.base} + ${part.scaling} × Dmg ${fmt(st.dmg)}`, value: base }];
  if (crit) { x = f32(x * st.critDmg); steps.push({ label: `× crit damage ${fmt(st.critDmg)}`, value: x }); }
  if (st.dmgMod !== 1) { x = f32(x * st.dmgMod); steps.push({ label: `× damage modifier ${fmt(st.dmgMod)} (1 + ΣDamage %)`, value: x }); }
  if (extraMult !== 1) { x = f32(x * extraMult); steps.push({ label: `× extra multiplier ${fmt(extraMult)}`, value: x }); }
  if (modeMult !== 1) { x = f32(x * modeMult); steps.push({ label: `× mode multiplier ${fmt(modeMult)}`, value: x }); }
  const raw = trunc(x);
  steps.push({ label: 'truncate', value: raw, rounding: true });
  return { raw, steps };
}

/** Stage C (intake): CharHurtbox.ApplyHit, simplified to the inputs the calculator exposes. */
export function intake(raw, attacker, target) {
  const steps = [];
  let m = 1 - (target.defense || 0);
  const m0 = m;
  if (m < 1) m = Math.min(1, Math.max(0, m + (attacker.shred || 0)));
  m = Math.max(0.5, Math.min(999, m));
  if (m0 !== 1 || attacker.shred) steps.push({ label: `damage-taken modifier: 1 − Defense ${fmt(target.defense || 0)}${attacker.shred && m0 < 1 ? ` + Shred ${fmt(attacker.shred)}` : ''}, clamped to [0.5, 999]`, value: m });
  let dmg = trunc(f32(raw * m));
  if (m !== 1) steps.push({ label: `× ${fmt(m)}, truncate`, value: dmg, rounding: true });
  const shield = target.shield || 0;
  const toShield = Math.min(shield, dmg);
  const hpLoss = dmg - toShield;
  if (shield) steps.push({ label: `shield absorbs ${toShield}`, value: hpLoss });
  const heal = attacker.lifesteal > 0 ? Math.ceil(f32(dmg * attacker.lifesteal)) : 0;
  const thorns = target.thorns > 0 ? Math.floor(f32(dmg * target.thorns)) : 0;
  return { dmg, hpLoss, toShield, m, heal, thorns, steps };
}

export function cooldown(ab, st) {
  if (ab.cooldown == null) return null;
  let cd = ab.cooldown;
  const steps = [{ label: `base ${ab.cooldown}s`, value: cd }];
  if (ab.useCDR && st.cooldown !== 1) { cd = cd / st.cooldown; steps.push({ label: `÷ cooldown stat ${fmt(st.cooldown)} (1 + ΣCDR)`, value: cd }); }
  if (ab.useAS) { const as = Math.min(st.maxAttackSpeed, st.attackSpeed); if (as !== 1) { cd = cd / as; steps.push({ label: `÷ attack speed ${fmt(as)} (min(max ${st.maxAttackSpeed}, 1 + ΣAS))`, value: cd }); } }
  return { value: cd, steps };
}

export function regen(ch, st) {
  // CharHpRegen: per tick interval 1.0 s / (1 + bonus regen speed); the bonus-speed source is not mapped (treated as 0).
  return { inCombat: 0 + st.regenAdd, outOfCombat: ch.regenOOC + st.regenAdd, delay: ch.regenDelay };
}

export function fmt(x, d = 3) {
  if (typeof x !== 'number') return String(x);
  return Number.isInteger(x) ? String(x) : String(+x.toFixed(d));
}
