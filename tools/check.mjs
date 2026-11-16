// Focused formula checks against code-traced and live-observed values.
import { castDamage, intake, cooldown, computeStats, roundHalfEven } from '../public/calc.js';
let fail = 0;
const eq = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(ok ? 'ok  ' : 'FAIL', name, got, ok ? '' : `(want ${want})`); };
const st0 = { dmg: 0, dmgMod: 1, critDmg: 1.4, cooldown: 1, attackSpeed: 1, maxAttackSpeed: 10 };
eq('Eve Ice Lance base [LIVE 220]', castDamage({ base: 220, scaling: 0.85 }, st0).raw, 220);
eq('Ice Lance with Dmg 60 (reference example 271)', castDamage({ base: 220, scaling: 0.85 }, { ...st0, dmg: 60 }).raw, 271);
for (const [b, w] of [[145, 203], [240, 336], [250, 350]]) eq(`Chuck Rage ×1.4 ${b} [LIVE ${w}]`, castDamage({ base: b, scaling: 0.45 }, { ...st0, dmgMod: 1.4 }).raw, w);
eq('lifesteal ceil 271×0.25 = 68', intake(271, { lifesteal: 0.25 }, {}).heal, 68);
eq('defense floor 0.5', intake(100, {}, { defense: 0.8 }).dmg, 50);
eq('shred only cancels defense', intake(100, { shred: 0.5 }, { defense: 0.2 }).dmg, 100);
eq('cooldown CDR', cooldown({ cooldown: 7, useCDR: true }, { ...st0, cooldown: 1.25 }).value, 5.6);
const { stats } = computeStats({ baseHp: 1400, critChance: 0, critDmg: 1.4, lifesteal: 0, maxAttackSpeed: 10 }, [{ stat: 'Hp', value: 350 }, { stat: 'HpPercent', value: 0.1 }]);
eq('Hp + HpPercent of base', stats.maxHp, 1890);
eq('banker rounding 2.5', roundHalfEven(2.5), 2);
process.exit(fail ? 1 : 0);
