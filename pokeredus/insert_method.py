# Read original file
with open('pokeredus/graph/damage_calc.py', 'r') as f:
    content = f.read()

# The new method to insert
new_method = '''
    # ── State-Aware Calculation ─────────────────────────────────────────

    def calculate_with_state(
        self,
        attacker_set,
        defender_set,
        move,
        kg,
        attacker_state=None,
        defender_state=None,
        field_state=None,
        level=None,
    ):
        """Full damage calc with state modifiers.

        Applies:
        - Attacker's stat stage multiplier via attacker_state
        - Burn halving to Atk if attacker_state has burn (physical moves)
        - Defender's stat stage multiplier via defender_state
        - Screens (reflect/light screen) from field_state
        - Weather boosts from field_state
        - Critical hit chance (1/24 for most moves)
        - Min damage based on attacker's effective stat
        """
        level = level or self.level
        attacker_pokemon = kg.get_pokemon(attacker_set.pokemon_id)
        defender_pokemon = kg.get_pokemon(defender_set.pokemon_id)

        if not attacker_pokemon or not defender_pokemon:
            return self._empty_result(move, defender_set, attacker_pokemon, kg, level)

        # Build modifier context
        ctx = DamageModifierContext(
            attacker_set, defender_set,
            attacker_pokemon, defender_pokemon,
            move, kg, level,
        )

        # Check if any modifier says to skip
        for mod in self._get_modifiers():
            if mod.should_skip(ctx):
                return DamageResult(
                    move_id=move.id, move_name=move.name,
                    move_type=move.type, move_category=move.category,
                    base_power=0, offensive_stat=0, defensive_stat=0,
                    base_damage=0, stab_mult=1.0, type_effectiveness=0.0,
                    modifier_product=1.0, final_damage=0,
                    effective_hp=0, turns_to_kill=0,
                    is_immune=True, is_contact=move.is_contact,
                )

        # Status moves don't deal damage
        if move.is_status:
            return DamageResult(
                move_id=move.id, move_name=move.name,
                move_type=move.type, move_category=move.category,
                base_power=0, offensive_stat=0, defensive_stat=0,
                base_damage=0, stab_mult=1.0, type_effectiveness=1.0,
                modifier_product=1.0, final_damage=0,
                effective_hp=self._compute_hp(defender_pokemon, defender_set, level),
                turns_to_kill=0, is_contact=move.is_contact,
            )

        # ── Offensive stat ───────────────────────────────────────────
        if move.is_physical:
            off_stat = attacker_set.effective_stat("atk", attacker_pokemon.base_stats, level)
            # Apply attacker's stat stage multiplier
            if attacker_state is not None:
                off_stat = int(off_stat * attacker_state.get_stat_multiplier("atk"))
            # Apply burn halving for physical moves
            if attacker_state is not None and attacker_state.has_condition("burn"):
                off_stat = int(off_stat * 0.5)
        else:
            off_stat = attacker_set.effective_stat("spa", attacker_pokemon.base_stats, level)
            # Apply attacker's stat stage multiplier
            if attacker_state is not None:
                off_stat = int(off_stat * attacker_state.get_stat_multiplier("spa"))

        # Apply offensive modifiers
        for mod in self._get_modifiers():
            off_stat = mod.modify_offense(float(off_stat), ctx)
        off_stat = max(1, int(off_stat))

        # ── Defensive stat ───────────────────────────────────────────
        if move.is_physical:
            def_stat = defender_set.effective_stat("def", defender_pokemon.base_stats, level)
            # Apply defender's stat stage multiplier
            if defender_state is not None:
                def_stat = int(def_stat * defender_state.get_stat_multiplier("def"))
        else:
            def_stat = defender_set.effective_stat("spd", defender_pokemon.base_stats, level)
            # Apply defender's stat stage multiplier
            if defender_state is not None:
                def_stat = int(def_stat * defender_state.get_stat_multiplier("spd"))

        # Apply defensive modifiers
        for mod in self._get_modifiers():
            def_stat = mod.modify_defense(float(def_stat), ctx)
        def_stat = max(1, int(def_stat))

        # ── Screen halving ───────────────────────────────────────────
        screen_mult = 1.0
        if field_state is not None and defender_state is not None:
            # For simplicity, check both sides
            for side in ("a", "b"):
                if move.is_physical and field_state.has_screen("reflect", side):
                    screen_mult *= 0.5
                    break
                elif move.is_special and field_state.has_screen("light_screen", side):
                    screen_mult *= 0.5
                    break

        # ── Base damage (Gen 9 formula) ──────────────────────────────
        power = max(1, move.base_power)
        base_damage = math.floor(
            ((2 * level / 5 + 2) * power * off_stat / def_stat) / 50 + 2
        )

        # Apply screen halving
        base_damage = math.floor(base_damage * screen_mult)

        # ── STAB ─────────────────────────────────────────────────────
        stab = 1.0
        if move.type in attacker_pokemon.types:
            stab = 1.5
        for mod in self._get_modifiers():
            stab = mod.modify_stab(stab, ctx)

        # ── Type effectiveness ───────────────────────────────────────
        type_eff = get_effectiveness(move.type, defender_pokemon.types)
        for mod in self._get_modifiers():
            type_eff = mod.modify_type_effectiveness(type_eff, ctx)

        # ── Weather boost ────────────────────────────────────────────
        weather_mult = 1.0
        if field_state is not None:
            weather = field_state.get_weather()
            if weather:
                # Sun boosts Fire, weakens Water
                if weather == "sun" and move.type == "fire":
                    weather_mult *= 1.5
                elif weather == "sun" and move.type == "water":
                    weather_mult *= 0.5
                # Rain boosts Water, weakens Fire
                elif weather == "rain" and move.type == "water":
                    weather_mult *= 1.5
                elif weather == "rain" and move.type == "fire":
                    weather_mult *= 0.5

        # ── Modifier product (items, abilities, etc.) ────────────────
        mod_product = 1.0
        damage_after_mults = float(base_damage)
        for mod in self._get_modifiers():
            damage_after_mults = mod.modify_damage(damage_after_mults, ctx)
        if base_damage > 0:
            mod_product = damage_after_mults / base_damage

        # Apply weather boost
        mod_product *= weather_mult

        # ── Critical hit ─────────────────────────────────────────────
        # Gen 9: 1/24 chance for most moves, 1/16 for Splash/Struggle
        is_crit = False
        if move.id not in ("splash", "struggle"):
            import random
            is_crit = random.random() < (1/24)
        crit_mult = 1.5 if is_crit else 1.0

        # ── Final damage ─────────────────────────────────────────────
        final_damage = math.floor(base_damage * stab * type_eff * mod_product * crit_mult)

        # ── Damage range (random factor 0.85 – 1.00) ────────────────
        roll_base = base_damage * stab * type_eff * mod_product
        min_dmg = math.floor(roll_base * 0.85)
        max_dmg = math.floor(roll_base * 1.00)

        # ── Defender HP ──────────────────────────────────────────────
        eff_hp = self._compute_hp(defender_pokemon, defender_set, level)

        # ── Turns to kill ────────────────────────────────────────────
        if final_damage <= 0:
            ttk = 0
        else:
            ttk = math.ceil(eff_hp / final_damage)

        # ── TTK range ────────────────────────────────────────────────
        if max_dmg > 0:
            min_ttk = math.ceil(eff_hp / max_dmg)
            max_ttk = math.ceil(eff_hp / min_dmg) if min_dmg > 0 else min_ttk
        else:
            min_ttk = max_ttk = 0

        return DamageResult(
            move_id=move.id,
            move_name=move.name,
            move_type=move.type,
            move_category=move.category,
            base_power=power,
            offensive_stat=off_stat,
            defensive_stat=def_stat,
            base_damage=base_damage,
            stab_mult=stab,
            type_effectiveness=type_eff,
            modifier_product=round(mod_product, 4),
            final_damage=max(0, final_damage),
            effective_hp=eff_hp,
            turns_to_kill=ttk,
            is_ohko=(ttk == 1),
            is_immune=(type_eff == 0),
            is_contact=move.is_contact,
            min_damage=max(0, min_dmg),
            max_damage=max(0, max_dmg),
            min_turns_to_kill=min_ttk,
            max_turns_to_kill=max_ttk,
        )
'''

# Find the insertion point - before "# ── Best Move / Turns to Kill"
insert_marker = '    # ── Best Move / Turns to Kill ────────────────────────────────────'
if insert_marker in content:
    parts = content.split(insert_marker)
    new_content = parts[0] + new_method + '\n' + insert_marker + parts[1]
    with open('pokeredus/graph/damage_calc.py', 'w') as f:
        f.write(new_content)
    print('Successfully inserted calculate_with_state method')
else:
    print('ERROR: Could not find insertion marker')