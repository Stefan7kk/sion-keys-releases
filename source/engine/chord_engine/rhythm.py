"""Bar-grouping evidence on a fine onset grid, independent of the chord decoder."""

from __future__ import annotations

import numpy as np

# Values are (main pulses per bar, subdivisions per pulse).
GROUPINGS = {"2/4": (2, 2), "3/4": (3, 2), "4/4": (4, 2), "6/8": (2, 3), "12/8": (4, 3)}


def _attack_bands(y, sr, hop, cancelled):
    """Positive spectral change, in low, middle and upper frequency bands."""
    from scipy.fft import rfft

    size = 1024
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(y, size // 2), size)[::hop]
    window = np.hanning(size).astype(np.float32)
    frequencies = np.fft.rfftfreq(size, 1 / sr)
    bands = [np.flatnonzero((frequencies >= lo) & (frequencies < hi))
             for lo, hi in ((38, 200), (200, 2300), (2300, 9500))]
    energy = np.empty((len(windows), len(bands)), np.float32)
    for start in range(0, len(windows), 512):
        if cancelled():
            return None
        power = np.abs(rfft(windows[start:start + 512] * window))
        energy[start:start + len(power)] = np.stack([np.mean(power[:, band], axis=1) for band in bands], axis=1)
    delta = np.maximum(0, np.diff(np.log1p(6 * energy), axis=0, prepend=0))
    scale = np.quantile(delta, .97, axis=0)
    return np.minimum(delta / np.maximum(scale, .018), 2.5)


def _sample_attacks(attacks, positions, radius):
    indices = np.clip(np.rint(positions).astype(int)[:, None] + np.arange(-radius, radius + 1),
                      0, len(attacks) - 1)
    return np.max(attacks[indices], axis=1)


def _change_at(features, positions):
    """Cosine change between sustained pitch profiles on either side of a beat."""
    edges = np.arange(len(features))
    before = np.stack([np.interp(positions - 1.0, edges, channel) for channel in features.T], axis=1)
    after = np.stack([np.interp(positions + 1.1, edges, channel) for channel in features.T], axis=1)
    norm = np.linalg.norm(before, axis=1) * np.linalg.norm(after, axis=1)
    return np.clip(1 - (before * after).sum(axis=1) / np.maximum(norm, 1e-8), 0, 1) * (norm > 1e-8)


def _bar_candidates(evidence):
    """Compare recurring accent profiles and veto simple multiples of a smaller bar."""
    base = np.median(evidence, axis=0)
    scale = np.std(evidence, axis=0)
    weight = np.array([.34, .19, .12, .22, .13]) * (scale > np.array([.035, .035, .035, .035, .035]))
    if weight.sum() == 0:
        return []
    normalized = np.clip((evidence - base) / np.maximum(scale, .035), -2, 3)
    candidates = []
    for period in (2, 3, 4, 5, 6, 7):
        if len(evidence) < period * 5:
            continue
        # Include all phases; no assumption that the beat tracker starts on 1.
        bars = normalized[:len(evidence) // period * period].reshape(-1, period, len(weight))
        profiles = bars.mean(axis=0)
        accent = profiles @ weight
        phase = int(np.argmax(accent))
        contrast = accent[phase] - (accent.sum() - accent[phase]) / (period - 1)
        if contrast < .27:
            continue
        if any(period % div == 0 and np.max(np.abs(accent - np.roll(accent, div))) < .27
               for div in (2, 3) if div < period):
            continue
        scores = bars @ weight
        margin = scores[:, phase] - (scores.sum(axis=1) - scores[:, phase]) / (period - 1)
        consistency = float(np.mean(margin > .08))
        left, right = np.array_split(scores, 2)
        if consistency < .63 or any(int(np.argmax(chunk.mean(axis=0))) != phase for chunk in (left, right)):
            continue
        # Separate phase agreement from raw loudness. Harmonic-only evidence can
        # help a drumless track, but recurring chord changes alone are tentative.
        channel_contrast = profiles[phase] - (profiles.sum(axis=0) - profiles[phase]) / (period - 1)
        independent = ((channel_contrast[:3] > .28).any() and (channel_contrast[3:] > .28).any())
        score = float(contrast * (.45 + .55 * consistency) + (.12 if independent else 0))
        if period >= 5:
            score *= .9
        candidates.append((score, period, phase, independent))
    return sorted(candidates, reverse=True)


def _compound_ratio(attacks, grid, radius):
    delta = np.diff(grid)
    if len(delta) < 10:
        return False
    samples = [_sample_attacks(attacks, grid[:-1] + fraction * delta, radius)
               for fraction in (1 / 3, .5, 2 / 3)]
    thirds = [envelope.max(axis=1) for envelope in (samples[0], samples[2])]
    straight = samples[1].max(axis=1)
    return all(float(np.median(third)) > max(.13, float(np.median(straight)) * 1.35)
               and np.mean(third > straight + .06) >= .58 for third in thirds)


def _infer_sections(attacks, beat_grid, harmony, bass, seconds_per_hop, feature_hop, cancelled, size=32):
    radius = max(1, round(.026 / seconds_per_hop))
    result = []
    # Non-overlapping sections keep a loud intro or a single change from voting twice.
    for lo in range(0, len(beat_grid) - 13, size):
        if cancelled():
            return []
        hi = min(lo + size, len(beat_grid))
        section = beat_grid[lo:hi]
        dt = np.diff(section) * seconds_per_hop
        typical = np.median(dt)
        if not .19 <= typical <= 1.4 or np.mean(abs(dt - typical) < typical * .22) < .78:
            continue
        choices = []
        # Some tracks expose each eighth note as a beat. Try all three phases
        # on that fast grid, but require actual attacks on both inner thirds.
        grids = [(section, lo, 1)]
        if typical <= .36 and len(section) >= 26:
            for offset in range(3):
                grids.append((section[offset::3], lo + offset, 3))
        for grid, first, spacing in grids:
            if len(grid) < 10:
                continue
            attacks_at_beat = _sample_attacks(attacks, grid, radius)
            if np.mean(np.max(attacks_at_beat, axis=1) > .06) < .70:
                continue
            compound = _compound_ratio(attacks, grid, radius)
            if spacing == 3 and not compound:
                continue
            harmonic_frames = grid * seconds_per_hop / feature_hop
            signals = np.column_stack((attacks_at_beat.mean(axis=1), attacks_at_beat[:, 0],
                                       attacks_at_beat[:, 1:].mean(axis=1),
                                       _change_at(harmony, harmonic_frames), _change_at(bass, harmonic_frames)))
            ranks = _bar_candidates(signals)
            if not ranks:
                continue
            score, period, phase, independent = ranks[0]
            separation = score - (ranks[1][0] if len(ranks) > 1 else 0)
            if score < .40 or separation < .10:
                continue
            name = next((name for name, group in GROUPINGS.items()
                         if group == (period, 3 if compound else 2)), None)
            if name is None:
                continue
            strong = score >= .62 and separation >= .20 and (independent or score >= 1.0)
            choices.append((score, name, first + phase * spacing, spacing, strong))
        if choices:
            # A verified compound grouping supersedes a fast triple pulse. It
            # requires a repeated bar at the slower level as well as the thirds.
            choices.sort(key=lambda item: (item[3] == 3 and item[4], item[0]), reverse=True)
            score, name, phase, spacing, strong = choices[0]
            result.append((lo, hi, name, phase, spacing, strong, score))
    return result


def _meter_result(picks, grid, seconds_per_hop):
    if not picks:
        return {}
    weights = {}
    for lo, hi, name, _, _, strong, _ in picks:
        weights[name] = weights.get(name, 0) + (hi - lo) * (1 if strong else .65)
    ordered = sorted(weights, key=weights.get, reverse=True)
    # A subordinate duple pulse can coexist with a four-beat bar. Consistent
    # phase and repeated four-pulse evidence favor the larger supported bar.
    for small, large in (("2/4", "4/4"), ("6/8", "12/8")):
        if set(ordered) != {small, large} or weights[large] < .35 * sum(weights.values()):
            continue
        large_picks = [row for row in picks if row[2] == large and row[5]]
        if len(large_picks) < 2:
            continue
        spacing = large_picks[0][4]
        phase = large_picks[0][3] % (2 * spacing)
        if all(row[4] == spacing and row[3] % (2 * spacing) == phase for row in picks):
            ordered = [large]
            picks = [row for row in picks if row[2] == large]
            break
    top = ordered[0]
    if len(ordered) > 1:
        changes = []
        for i, row in enumerate(picks):
            lo, hi, name, phase, _, strong, _ = row
            # Require two neighboring windows and an independent run for each meter.
            if i + 1 < len(picks) and strong and picks[i + 1][5] and picks[i + 1][2] == name \
                    and picks[i + 1][0] == hi and (not changes or changes[-1]["timeSignature"] != name):
                changes.append({"startSec": round(float(grid[phase] * seconds_per_hop), 3),
                                "timeSignature": name})
        if len(changes) > 1:
            return {"meterChanges": changes}
        if weights[top] < .76 * sum(weights.values()):
            return {}
    matching = [row for row in picks if row[2] == top]
    lo, hi, _, phase, spacing, strong, score = max(matching, key=lambda row: (row[5], row[6]))
    group, _ = GROUPINGS[top]
    bar = group * spacing
    agreeing = [row for row in matching if row[4] == spacing and row[3] % bar == phase % bar]
    coverage = sum(row[1] - row[0] for row in agreeing) / len(grid)
    reliable = coverage >= .55 and (
        (len(agreeing) >= 2 and len(agreeing) * 4 >= len(matching) * 3 and
         sum(row[5] for row in agreeing) >= 2) or (len(picks) == 1 and strong and score > 1.20))
    meta = {"timeSignature": top, "meterConfidence": "strong" if reliable else "moderate"}
    if reliable:
        # Do not extrapolate a phase through sections where it was not observed.
        windows = []
        for start, end, _, _, _, _, _ in agreeing:
            first = start + (phase - start) % spacing
            for i in range(first, end, spacing):
                windows.append([round(float(grid[i] * seconds_per_hop), 3), (i - phase) % bar == 0])
        if len(windows) >= group * 4:
            meta["meterBeats"] = windows
            main = grid[lo:hi:spacing]
            meta["meterPulseBpm"] = round(60 / (float(np.median(np.diff(main))) * seconds_per_hop), 1)
    return meta


def _coarse_signature(audio, sr, beats, hop, attacks, fine_hop):
    """Conservative recovery when the two pulse trackers agree on tempo."""
    if len(beats) < 32:
        return {}
    width = int(.06 * sr)
    accents = []
    for beat in beats:
        clip = audio[max(0, beat * hop - width // 2):beat * hop + width]
        accents.append(float(np.sqrt(np.mean(clip * clip))) if len(clip) else 0.)
    values = np.asarray(accents)
    if np.std(values) < 1e-6:
        return {}
    values = (values - np.mean(values)) / np.std(values)
    attack = _sample_attacks(attacks, beats * hop / fine_hop, max(2, round(.065 * sr / fine_hop))).mean(axis=1)
    if np.mean(attack > .09) < .76:
        return {}
    matches = []
    for period in (3, 4):
        count = len(values) // period
        bars = values[:count * period].reshape(count, period)
        profile = bars.mean(axis=0)
        phase = int(np.argmax(profile))
        if period == 4 and np.linalg.norm(profile[:2] - profile[2:]) < .30:
            continue
        contrast = profile[phase] - (profile.sum() - profile[phase]) / (period - 1)
        halves = np.array_split(bars, 2)
        stable = all(int(np.argmax(part.mean(axis=0))) == phase for part in halves)
        contrast_per_bar = bars[:, phase] - (bars.sum(axis=1) - bars[:, phase]) / (period - 1)
        if stable and np.mean(contrast_per_bar > 0) >= .72 and contrast >= .60:
            matches.append((contrast, period))
    matches.sort(reverse=True)
    if matches and (len(matches) == 1 or matches[0][0] - matches[1][0] >= .26):
        return {"timeSignature": f"{matches[0][1]}/4", "meterConfidence": "moderate"}
    return {}


def estimate_audio_meter(audio, sr, chroma, bass, feature_hop, cancelled=lambda: False, coarse_beats=()):
    """Estimate supported meters from decoded audio without changing chord or BPM features."""
    if len(audio) < 8 * sr or cancelled():
        return {}
    import librosa

    onset_hop = max(1, round(sr / 100))
    seconds_per_hop = onset_hop / sr
    attacks = _attack_bands(audio, sr, onset_hop, cancelled)
    if attacks is None or float(np.max(attacks)) < .16:
        return {}
    _, grid = librosa.beat.beat_track(onset_envelope=attacks.mean(axis=1), sr=sr, hop_length=onset_hop)
    if len(grid) < 14 or cancelled():
        return {}
    picks = _infer_sections(attacks, grid, chroma, bass, seconds_per_hop, feature_hop / sr, cancelled)
    pulse_ratio = np.median(np.diff(coarse_beats)) * feature_hop / (np.median(np.diff(grid)) * onset_hop) \
        if len(coarse_beats) > 8 else 1.
    if len(grid) < 84:
        pooled = _infer_sections(attacks, grid, chroma, bass, seconds_per_hop, feature_hop / sr,
                                 cancelled, size=len(grid))
        # On short recordings, a single local pattern can be a syncopation.
        # Ask the wider context to agree before displaying a tentative result.
        agrees = pooled and any(row[2] == pooled[0][2] for row in picks)
        picks = [row for row in picks if row[2] == pooled[0][2]] if agrees else []
    result = _meter_result(picks, grid, seconds_per_hop)
    if 1.83 <= pulse_ratio <= 2.17 and "meterChanges" not in result:
        alternatives = []
        for offset in (0, 1):
            half = grid[offset::2]
            sections = _infer_sections(attacks, half, chroma, bass, seconds_per_hop, feature_hop / sr, cancelled)
            alternatives.append(_meter_result(sections, half, seconds_per_hop))
        verified = next((option for option in alternatives if option.get("meterConfidence") == "strong"
                         and (not result or option["timeSignature"] == result["timeSignature"])), None)
        if verified:
            result = verified
        elif result.get("meterConfidence") == "strong":
            result = {"timeSignature": result["timeSignature"], "meterConfidence": "moderate"}
    if cancelled():
        return {}
    if not result and .93 <= pulse_ratio <= 1.07 and len(grid) < 84:
        result = _coarse_signature(audio, sr, coarse_beats, feature_hop, attacks, onset_hop)
    return result
