"""Export the calculator dataset from the BAPBAP research workspace (read-only) into public/data.json.

Usage: python tools/export_data.py [research_dir]
Only extracted configuration values, traced-formula text and live observations are exported; no game binaries.
"""
import json, re, sys, pathlib, collections, datetime

RES = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\emrah\Documents\bapbap-game-research")
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "data.json"
D = lambda n: json.load(open(RES / "data" / n, encoding="utf8"))

chars, abilities, augs = D("characters.json"), D("abilities.json"), D("augments.json")
rec = {r["source"]: r["category"][:2].strip() for r in D("augment_reconciliation.json")}
AF = D("augment_formulas.json")
paths = D("passive_activation_paths.json")
STAT_IDS = set(AF["stat_augments"]["ids"])
NOBASE = set(paths["overrides_not_calling_base"])

# Live observations: damage values passed into ApplyHit per character (training session, tracker mod).
live = collections.defaultdict(set)
for f in sorted((RES / "live").glob("mechanics-*.jsonl")):
    for line in open(f, encoding="utf8"):
        e = json.loads(line)
        hb = e.get("hitbox") or ""
        if e.get("event") == "hit" and hb.startswith("Hitbox_") and e.get("damageArg", 0) > 0:
            live[hb.split("_")[1]].add(e["damageArg"])


def stat(s):
    return {"stat": s["stat"].split("(")[0], "value": s["value"]}


SCALE_CANDIDATES = lambda k: [k + "Scaling", k.replace("Damage", "DamageScaling"), k.replace("Damage", "DmgScaling"),
                              k.replace("damage", "damageScaling"), k.replace("Damage", "JumpDamageScaling")]


def damage_parts(f):
    parts = []
    for k, v in f.items():
        if isinstance(v, bool) or not isinstance(v, int): continue
        if not re.fullmatch(r"(?i)(\w*damage\d*|damage)", k): continue
        if re.search(r"(?i)percent|reduction|amp|bonusdamage|crushing|npc|lootbox|basedinvisible|invisible", k): continue
        sc = None
        for c in SCALE_CANDIDATES(k):
            if c != k and isinstance(f.get(c), (int, float)) and not isinstance(f.get(c), bool): sc = f[c]; break
        if sc is None and k == "damage" and isinstance(f.get("dmgScaling"), (int, float)): sc = f["dmgScaling"]
        if sc is None: sc = 0.0
        parts.append({"key": k, "base": v, "scaling": sc})
    return parts


out_chars = []
for c in sorted(chars, key=lambda c: c["name"]):
    name = c["name"]
    abil = []
    for a in sorted([a for a in abilities if a["character"] == name and a["cmdId"] < 4], key=lambda a: a["cmdId"]):
        f = a["fields"]
        parts = damage_parts(f)
        for p in parts:
            p["liveBase"] = p["base"] in live.get(name, set())
        abil.append({
            "slot": a["slot_inferred"], "cmdId": a["cmdId"], "cls": a["class"],
            "title": a.get("tooltip_title") or a["class"], "tooltip": a.get("tooltip") or "",
            "short": a.get("tooltip_short") or "",
            "parts": parts,
            "tickRate": f.get("damageRate") if isinstance(f.get("damageRate"), (int, float)) else None,
            "ttl": f.get("ttl") if isinstance(f.get("ttl"), (int, float)) else None,
            "crit": bool(f.get("enableCritDmg")),
            "cooldown": f.get("baseCooldownTime") if isinstance(f.get("baseCooldownTime"), (int, float)) else None,
            "useCDR": bool(f.get("applyCooldownMultiplier")), "useAS": bool(f.get("applyAtkSpeedMultiplier")),
        })
    out_chars.append({
        "id": c["charId"], "name": name, "title": c.get("title") or "",
        "baseHp": c["baseHp"], "critChance": c["baseCritChance"], "critDmg": c["baseCritDmg"],
        "lifesteal": c["baseLifeSteal"], "maxAttackSpeed": c["maxAttackSpeed"],
        "regen": c["baseHpRegen"], "regenOOC": c["baseHpRegenOutOfCombat"], "regenDelay": c["hpRegenStartAfterHit"],
        "runSpeed": c["baseRunSpeed"], "npcDmgTakenMult": c.get("damageTakenFromNpcsMultiplier", 1.0),
        "startPassives": [p["so"] for p in c.get("startPassives", [])],
        "abilities": abil, "liveObserved": sorted(live.get(name, [])),
    })

out_augs = []
for a in augs:
    cat = rec.get(a["source"], "")
    if cat not in ("A1", "A2", "F"): continue
    cfg = a["config"]
    levels = []
    for L in cfg.get("levelStats", {}).get("levels", []):
        t0 = L["tiers"][0]
        levels.append({"stats": [stat(s) for s in t0.get("stats") or []],
                       "values": {k: v for k, v in t0.items() if k != "stats" and isinstance(v, (int, float)) and not isinstance(v, bool)}})
    cls = a["class"][:-3] if a["class"].endswith("_SO") else a["class"]
    fe = AF.get(str(a["id"]))
    if a["id"] in STAT_IDS:
        status, formula, trigger = "supported", AF["stat_augments"]["formula"], "pickup / level-up"
    elif fe:
        status, formula, trigger = fe["status"], fe["formula"], fe["trigger"]
    else:
        status, formula, trigger = "unsupported", "", ""
    target = cfg.get("targetAbility") or cfg.get("abiltiyId")
    values = {k: v for k, v in cfg.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
    out_augs.append({
        "id": a["id"], "name": a["name"] or a["so"], "desc": a.get("description") or "", "category": cat,
        "kind": "generic" if cat == "A1" else "character",
        "chars": a["characterGroups"], "leagueDisabled": a["league_disabled"],
        "stats": [stat(s) for s in cfg.get("stats") or []],
        "statsUncertain": cls in NOBASE and a["id"] != 407,
        "levels": levels, "values": values,
        "targetSlot": int(re.search(r"\((\d+)\)", target).group(1)) if isinstance(target, str) and "(" in target else None,
        "incompatible": a["incompatible"], "requires": a["requires"], "requiresAny": a["requiresAny"],
        "status": status, "formula": formula, "trigger": trigger,
        "offeredNormally": cat != "F",
    })
# Double Random's -0.1 CDR arrives via negative passive id 418 [CODE]
for x in out_augs:
    if x["id"] == 407:
        x["stats"] = x["stats"] or [{"stat": "CooldownReduction", "value": -0.1}]

data = {
    "generated": datetime.date.today().isoformat(),
    "build": {"metadata": "a159a9f1", "gameAssembly": "75278848"},
    "league": {"disabledAugments": [303, 415, 405, 293], "bannedCharacters": [2],
               "note": "Owner-confirmed league policy, not game behaviour. Chuck (charId 2) provisionally banned."},
    "characters": out_chars, "augments": sorted(out_augs, key=lambda x: (x["kind"], x["name"])),
}
OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump(data, open(OUT, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print("wrote", OUT, OUT.stat().st_size, "bytes;", len(out_chars), "characters,", len(out_augs), "augments")
print("live-verified base parts:", sum(p["liveBase"] for c in out_chars for a in c["abilities"] for p in a["parts"]),
      "of", sum(len(a["parts"]) for c in out_chars for a in c["abilities"]))
