#!/usr/bin/env python3
"""
Offline-Aufbereitung arabischer Frequenzlisten (Leipzig TSV oder OpenSubtitles TXT)
ohne API-Keys, ohne KI, ohne Rate-Limits und ohne eingebautes Wörterbuch.

Quellen (werden einmalig automatisch in ./cache/ heruntergeladen):
  1. kaikki.org  - Deutsches Wiktionary Komplett-Dump (de-extract.jsonl.gz)
                   (direkte AR->DE Eintraege + invertierte DE->AR Uebersetzungen + EN->DE Bruecke)
  2. Tatoeba     - Offizielle Satz-Dumps (ara_sentences, deu_sentences, links) fuer ~-Beispiele
  3. Optional    - --with-en-kaikki (177k arabische Woerter inkl. Harakat) und/oder --dictcc DATEI.txt

Ausgabeformat (direkt kompatibel mit index.html / app.js):
  rank  word  vocalized  translit  meaning  freq
"""

from __future__ import annotations

import argparse
import bz2
import csv
import gzip
import json
import re
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ARABIC_WORD_RE = re.compile(r"^[\u0621-\u064A\u064B-\u0652\u0670]+$")
ARABIC_TOKEN_RE = re.compile(r"[\u0621-\u064A\u064B-\u0652\u0670]+")
HARAKAT_RE = re.compile(r"[\u064B-\u065F\u0670\u0640]")
HAS_HARAKAT_RE = re.compile(r"[\u064B-\u0652\u0670]")
USER_AGENT = "ArabicPhase6OfflineBuilder/5.0"

KAIKKI_RAWDATA_PAGE = "https://kaikki.org/dictionary/rawdata.html"
KAIKKI_AR_PAGE = "https://kaikki.org/dictionary/Arabic/index.html"
TATOEBA_ARA_URL = "https://downloads.tatoeba.org/exports/per_language/ara/ara_sentences.tsv.bz2"
TATOEBA_DEU_URL = "https://downloads.tatoeba.org/exports/per_language/deu/deu_sentences.tsv.bz2"
TATOEBA_LINKS_URL = "https://downloads.tatoeba.org/exports/links.tar.bz2"

POS_MAP = {
    "noun": "Subst.",
    "substantiv": "Subst.",
    "name": "Eigenname",
    "proper noun": "Eigenname",
    "verb": "Verb",
    "adj": "Adj.",
    "adjective": "Adj.",
    "adv": "Adv.",
    "adverb": "Adv.",
    "prep": "Präp.",
    "preposition": "Präp.",
    "conj": "Konj.",
    "conjunction": "Konj.",
    "pron": "Pron.",
    "pronoun": "Pron.",
    "particle": "Part.",
    "num": "Num.",
    "numeral": "Num.",
    "intj": "Interj.",
    "interjection": "Interj.",
    "det": "Det.",
    "article": "Art.",
    "phrase": "Wendung",
}

# Reine grammatikalische Praefix-Regeln des Arabischen (kein Woerterbuch)
GRAMMAR_PREFIX_RULES = [
    ("وال", "وَالْ", "wa-l-", "Konj.+Art. (و+ال)", "und "),
    ("فال", "فَالْ", "fa-l-", "Konj.+Art. (ف+ال)", "so/dann "),
    ("بال", "بِالْ", "bi-l-", "Präp.+Art. (ب+ال)", "mit/in "),
    ("كال", "كَالْ", "ka-l-", "Präp.+Art. (ك+ال)", "wie "),
    ("لل", "لِلْ", "li-l-", "Präp.+Art. (ل+ال)", "für "),
    ("ال", "الْ", "al-", "Art. (ال+)", ""),
    ("و", "وَ", "wa-", "Konj. (و+)", "und "),
    ("ف", "فَ", "fa-", "Konj. (ف+)", "so/denn "),
    ("ب", "بِ", "bi-", "Präp. (ب+)", "mit/in "),
    ("ل", "لِ", "li-", "Präp. (ل+)", "für/zu "),
]


def clean_field(value: str) -> str:
    return re.sub(r"[\t\r\n]+", " ", str(value or "")).strip()


def strip_harakat(text: str) -> str:
    return HARAKAT_RE.sub("", text or "")


def normalize_arabic(text: str) -> str:
    s = strip_harakat(text)
    s = re.sub(r"[أإآٱ]", "ا", s)
    return s.replace("ى", "ي").replace("ة", "ه").strip()


def map_pos(raw_pos: str) -> str:
    key = clean_field(raw_pos).lower()
    return POS_MAP.get(key, clean_field(raw_pos))


def format_pons_meaning(pos: str, translations: str, ex_ar: str = "", ex_de: str = "") -> str:
    parts: list[str] = []
    pos_c = clean_field(pos)
    tr_c = clean_field(translations)
    if pos_c and tr_c:
        parts.append(f"{pos_c} · {tr_c}")
    elif tr_c:
        parts.append(tr_c)

    ex_ar_c = clean_field(ex_ar)
    ex_de_c = clean_field(ex_de)
    if ex_ar_c and ex_de_c:
        parts.append(f"Bsp.: {ex_ar_c} (= {ex_de_c})")
    elif ex_ar_c:
        parts.append(f"Bsp.: {ex_ar_c}")
    return " | ".join(parts)


# ==================== REGELBASIERTE AUSSPRACHE & UMSCHRIFT ====================


SPECIAL_SOUND_HINTS = [
    ("ع", "ع = tiefer Kehllaut"),
    ("ح", "ح = scharfes Hauch-h"),
    ("خ", "خ = ch wie in Bach"),
    ("غ", "غ = gerolltes Zäpfchen-r"),
    ("ق", "ق = tiefes Kehl-k"),
    ("ث", "ث = stimmloses engl. th"),
    ("ذ", "ذ = stimmh. engl. th"),
    ("ص", "ص = dunkles s"),
    ("ض", "ض = dunkles d"),
    ("ط", "ط = dunkles t"),
    ("ظ", "ظ = dunkles engl. th"),
]


def transliterate_vocalized(vocalized: str) -> str:
    """Deterministische Umschrift aus vokalisiertem Arabisch (Harakat)."""
    if not vocalized or not HAS_HARAKAT_RE.search(vocalized):
        return ""

    s = re.sub(r"([\u064B-\u0650\u0652])(\u0651)", r"\2\1", vocalized.strip())
    s = s.replace("\u0640", "")

    cons_map = {
        "ب": "b", "ت": "t", "ث": "ṯ", "ج": "ǧ", "ح": "ḥ", "خ": "ḫ",
        "د": "d", "ذ": "ḏ", "ر": "r", "ز": "z", "س": "s", "ش": "š",
        "ص": "ṣ", "ض": "ḍ", "ط": "ṭ", "ظ": "ẓ", "ع": "ʿ", "غ": "ġ",
        "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
        "ه": "h", "و": "w", "ي": "y", "ء": "ʾ", "أ": "ʾ", "إ": "ʾ",
        "ؤ": "ʾ", "ئ": "ʾ",
    }
    short_v = {"\u064E": "a", "\u0650": "i", "\u064F": "u"}
    tanwin = {"\u064B": "an", "\u064D": "in", "\u064C": "un"}

    def _one_word(w: str) -> str:
        prefix = ""
        if w.startswith("الْ"):
            prefix, w = "al-", w[3:]
        elif w.startswith("ال") and len(w) > 2:
            prefix, w = "al-", w[2:]

        out: list[str] = []
        i, n = 0, len(w)
        while i < n:
            ch = w[i]
            nxt = w[i + 1] if i + 1 < n else ""

            if ch == "آ":
                out.append("ā" if i == 0 else "ʾā")
            elif ch in ("ا", "ى", "\u0670"):
                if out and out[-1] == "a":
                    out[-1] = "ā"
                elif ch != "ا" or i > 0:
                    out.append("ā")
            elif ch == "ة":
                if i == n - 1:
                    if not (out and out[-1] == "a"):
                        out.append("a")
                elif nxt in short_v or nxt in tanwin:
                    out.append("t")
                elif not (out and out[-1] == "a"):
                    out.append("a")
            elif ch == "ي" and out and out[-1] == "i" and nxt not in short_v and nxt not in tanwin and nxt != "\u0651":
                out[-1] = "ī"
            elif ch == "و" and out and out[-1] == "u" and nxt not in short_v and nxt not in tanwin and nxt != "\u0651":
                out[-1] = "ū"
            elif ch in cons_map:
                mapped = "" if (i == 0 and ch in ("أ", "إ")) else cons_map[ch]
                if nxt == "\u0651":
                    out.append(mapped + mapped)
                    i += 2
                    continue
                if mapped:
                    out.append(mapped)
            elif ch in short_v:
                out.append(short_v[ch])
            elif ch in tanwin:
                out.append(tanwin[ch])
            i += 1
        return prefix + "".join(out)

    return " ".join(_one_word(tok) for tok in s.split() if tok)


def german_syllable_pronunciation(translit: str) -> str:
    """
    Wandelt eine arabische Umschrift in eine intuitive deutsche Lautschrift
    mit GROSS geschriebener betonter Silbe (Standardarabische Betonungsregeln).
    """
    if not translit:
        return ""

    base = translit.strip().lower()
    base = base.replace("ʾ", "").replace("'", "")

    # Präfix wie al- / wa- separat lassen
    prefix = ""
    m_pref = re.match(r"^((?:wa-|fa-|bi-|li-|ka-)?(?:al-|ar-|as-|aš-|at-|aṯ-|ad-|aḏ-|an-|az-|aṣ-|aḍ-|aṭ-|aẓ-|l-))(.*)$", base)
    if m_pref and m_pref.group(2):
        prefix = m_pref.group(1)
        base = m_pref.group(2)

    # In einzelne Phoneme zerlegen
    vowels = {"a", "i", "u", "ā", "ī", "ū", "e", "o"}
    tokens: list[tuple[str, str]] = []  # (type: 'V'|'C', text)
    i = 0
    while i < len(base):
        ch = base[i]
        nxt = base[i + 1] if i + 1 < len(base) else ""
        if ch in ("-", " "):
            i += 1
            continue
        # Diphthonge ay -> ai, aw -> au
        if ch == "a" and nxt == "y" and (i + 2 >= len(base) or base[i + 2] not in vowels):
            tokens.append(("V", "ai"))
            i += 2
            continue
        if ch == "a" and nxt == "w" and (i + 2 >= len(base) or base[i + 2] not in vowels):
            tokens.append(("V", "au"))
            i += 2
            continue
        if ch in vowels:
            v_de = {"ā": "aa", "ī": "ii", "ū": "uu"}.get(ch, ch)
            tokens.append(("V", v_de))
        elif ch == "ʿ":
            # Kehllaut als stillen Trenner markieren (Hinweis kommt in Klammern)
            tokens.append(("C", ""))
        else:
            c_de = {
                "š": "sch", "ǧ": "dsch", "ḫ": "ch", "ḥ": "h",
                "ġ": "r", "q": "k", "ṣ": "ss", "ḍ": "d", "ṭ": "t",
                "ẓ": "s", "ṯ": "th", "ḏ": "dh", "y": "j", "z": "s",
                "s": "ss", "j": "dsch",
            }.get(ch, ch)
            tokens.append(("C", c_de))
        i += 1

    # Silben bilden
    syllables: list[list[tuple[str, str]]] = []
    cur: list[tuple[str, str]] = []
    idx = 0
    while idx < len(tokens):
        t_type, t_val = tokens[idx]
        cur.append((t_type, t_val))
        if t_type == "V":
            # Wie viele Konsonanten folgen bis zum nächsten Vokal?
            c_count = 0
            k = idx + 1
            while k < len(tokens) and tokens[k][0] == "C":
                c_count += 1
                k += 1
            if k >= len(tokens):
                # Restliche Schlusskonsonanten gehören zu dieser Silbe
                cur.extend(tokens[idx + 1 :])
                syllables.append(cur)
                cur = []
                break
            elif c_count >= 2:
                # Erster Konsonant schließt die aktuelle Silbe
                cur.append(tokens[idx + 1])
                syllables.append(cur)
                cur = []
                idx += 2
                continue
            else:
                syllables.append(cur)
                cur = []
        idx += 1

    if cur:
        if syllables:
            syllables[-1].extend(cur)
        else:
            syllables.append(cur)

    if not syllables:
        return ""

    def _is_long_v(syl: list[tuple[str, str]]) -> bool:
        return any(t == "V" and v in ("aa", "ii", "uu", "ai", "au") for t, v in syl)

    def _coda_count(syl: list[tuple[str, str]]) -> int:
        v_pos = next((p for p, (t, _) in enumerate(syl) if t == "V"), -1)
        if v_pos == -1:
            return 0
        return sum(1 for t, val in syl[v_pos + 1 :] if t == "C" and val != "")

    # Betonungsregel Hocharabisch
    n_syl = len(syllables)
    last_heavy_super = (_is_long_v(syllables[-1]) and _coda_count(syllables[-1]) >= 1) or _coda_count(syllables[-1]) >= 2
    if n_syl == 1:
        stress_idx = 0
    elif last_heavy_super:
        stress_idx = n_syl - 1
    elif _is_long_v(syllables[-2]) or _coda_count(syllables[-2]) >= 1:
        stress_idx = n_syl - 2
    elif n_syl >= 3:
        stress_idx = n_syl - 3
    else:
        stress_idx = 0

    rendered: list[str] = []
    for s_i, syl in enumerate(syllables):
        txt = "".join(val for _, val in syl)
        if not txt:
            continue
        rendered.append(txt.upper() if s_i == stress_idx else txt)

    return prefix + "-".join(rendered)


def build_pronunciation_field(raw_word: str, vocalized: str, translit: str, ipa: str = "") -> str:
    """Kombiniert Umschrift, deutsche Lautschrift mit Betonung und gezielte Laut-Hinweise."""
    tr = clean_field(translit) or transliterate_vocalized(vocalized)
    source_ar = vocalized or raw_word

    hints: list[str] = []
    for ar_char, desc in SPECIAL_SOUND_HINTS:
        if ar_char in source_ar:
            hints.append(desc)
        if len(hints) >= 2:
            break
    if "\u0651" in source_ar and len(hints) < 3:
        hints.append("ّ = Konsonant doppelt sprechen")

    phonetic_de = german_syllable_pronunciation(tr)
    parts: list[str] = []
    if tr:
        parts.append(tr)
    if phonetic_de:
        parts.append(f"Aussprache: {phonetic_de}")
    elif ipa:
        parts.append(f"IPA: {clean_field(ipa)}")

    if hints:
        parts.append(f"({'; '.join(hints)})")

    return " · ".join(parts)


# ==================== DOWNLOAD-CACHE (OHNE API-KEY) ====================


def download_file(url: str, dest: Path, label: str) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1024:
        print(f"Nutze lokalen Cache: {dest.name} ({dest.stat().st_size / (1024 * 1024):.1f} MB)")
        return dest

    print(f"Lade {label} herunter:\n  {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            downloaded = 0
            last_pct = -1
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = int((downloaded * 100) / total)
                    if pct != last_pct and (pct % 5 == 0 or pct == 100):
                        print(f"  ... {pct}% ({downloaded / (1024 * 1024):.1f} / {total / (1024 * 1024):.1f} MB)", end="\r", flush=True)
                        last_pct = pct
                else:
                    print(f"  ... {downloaded / (1024 * 1024):.1f} MB geladen", end="\r", flush=True)
        print()
        tmp.replace(dest)
        return dest
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise


def discover_link(page_url: str, pattern: str) -> str:
    req = urllib.request.Request(page_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    m = re.search(pattern, html, flags=re.IGNORECASE)
    if not m:
        raise RuntimeError(f"Konnte Download-Link ({pattern}) auf {page_url} nicht finden.")
    return urllib.parse.urljoin(page_url, m.group(1))


# ==================== FREQUENZLISTE EINLESEN ====================


def read_frequency_file(input_path: Path) -> list[tuple[str, int]]:
    """Unterstuetzt Leipzig TSV (ID<TAB>Wort<TAB>Freq) und OpenSubtitles TXT (Wort Freq)."""
    counts: dict[str, int] = {}
    with input_path.open("r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split("\t") if "\t" in stripped else stripped.split()
            word = ""
            freq = 0
            if len(parts) >= 3 and parts[0].isdigit():
                word = parts[1].strip()
                try:
                    freq = int(parts[2])
                except ValueError:
                    freq = 0
            elif len(parts) >= 2:
                word = parts[0].strip()
                try:
                    freq = int(parts[1])
                except ValueError:
                    freq = 0
            else:
                continue

            word = word.replace("\u0640", "")
            if not word or not ARABIC_WORD_RE.match(word):
                continue
            counts[word] = counts.get(word, 0) + freq

    return sorted(counts.items(), key=lambda x: x[1], reverse=True)


def generate_stem_variants(word: str) -> list[tuple[str, str, str, str, str]]:
    """Liefert (voc_prefix, tr_prefix, pos_note, de_prefix, stem) nach arabischen Praefix-Regeln."""
    out: list[tuple[str, str, str, str, str]] = []
    for pref, voc_p, tr_p, pos_note, de_pref in GRAMMAR_PREFIX_RULES:
        min_stem = 3 if len(pref) == 1 else 2
        if word.startswith(pref) and len(word) - len(pref) >= min_stem:
            stem = word[len(pref) :]
            out.append((voc_p, tr_p, pos_note, de_pref, stem))
    return out


# ==================== 1. KAIKKI DE-WIKTIONARY INDEX ====================


def extract_clean_arabic_candidates(raw_ar: str) -> list[str]:
    text = re.sub(r"\([^)]*\)", "", raw_ar or "")
    text = re.sub(r"\[[^\]]*\]", "", text)
    parts = re.split(r"[,،;/|]", text)
    out = []
    for p in parts:
        c = clean_field(p).strip(" .-")
        if c and ARABIC_TOKEN_RE.search(c):
            out.append(c)
    return out


def load_kaikki_de_dump(
    dump_path: Path,
    needed_norm_words: set[str],
    build_en_de: bool = False,
) -> tuple[dict[str, dict], dict[str, dict], dict[str, list[str]]]:
    """
    Streamt de-extract.jsonl.gz und sammelt nur Eintraege fuer unsere Zielwoerter:
      - direct_ar:    Direkte arabische Eintraege aus de.wiktionary.org
      - inverted_ar:  Invertierte DE->AR Uebersetzungen aus de.wiktionary.org
      - en_to_de:     Optionales EN->DE Woerterbuch (fuer --with-en-kaikki)
    """
    direct_ar: dict[str, dict] = {}
    inverted_ar: dict[str, dict] = {}
    en_to_de: dict[str, list[str]] = {}

    print(f"Durchsuche deutsches Wiktionary ({dump_path.name})...")
    opener = gzip.open if dump_path.suffix == ".gz" else open

    line_count = 0
    with opener(dump_path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            line_count += 1
            if line_count % 200000 == 0:
                print(f"  ... {line_count:,} Einträge geprüft (Direkt: {len(direct_ar)}, Übersetzungen: {len(inverted_ar)})", end="\r", flush=True)

            # Schneller Vorfilter bevor JSON geparst wird
            if '"ar"' not in line and '"Arabisch"' not in line and not (build_en_de and ('"en"' in line or '"Englisch"' in line)):
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            lang_code = obj.get("lang_code", "")

            # A) Direkter arabischer Eintrag im deutschen Wiktionary
            if lang_code == "ar":
                word_raw = clean_field(obj.get("word", ""))
                norm = normalize_arabic(word_raw)
                if norm not in needed_norm_words:
                    continue

                glosses: list[str] = []
                for sense in obj.get("senses") or []:
                    for g in sense.get("glosses") or []:
                        gc = clean_field(g)
                        if gc and gc not in glosses:
                            glosses.append(gc)
                        if len(glosses) >= 3:
                            break
                    if len(glosses) >= 3:
                        break
                if not glosses:
                    continue

                vocalized = word_raw if HAS_HARAKAT_RE.search(word_raw) else ""
                translit = ""
                for form in obj.get("forms") or []:
                    ft = clean_field(form.get("form", ""))
                    tags = form.get("tags") or []
                    if not vocalized and ft and HAS_HARAKAT_RE.search(ft):
                        vocalized = ft
                    if not translit and form.get("roman"):
                        translit = clean_field(form["roman"])
                    if not translit and ft and any(t in ("transcription", "romanization") for t in tags):
                        translit = ft

                ipa = ""
                for snd in obj.get("sounds") or []:
                    if snd.get("ipa"):
                        ipa = clean_field(snd["ipa"])
                        break

                pos = map_pos(obj.get("pos", ""))
                existing = direct_ar.get(norm)
                if not existing or (vocalized and not existing["vocalized"]):
                    direct_ar[norm] = {
                        "vocalized": vocalized,
                        "translit": translit,
                        "ipa": ipa,
                        "pos": pos,
                        "meanings": glosses[:3],
                    }

            # B) Deutscher Eintrag -> Arabische (und ggf. Englische) Uebersetzungen invertieren
            elif lang_code == "de":
                de_word = clean_field(obj.get("word", ""))
                if not de_word or len(de_word) > 45:
                    continue
                pos = map_pos(obj.get("pos", ""))

                all_translations = list(obj.get("translations") or [])
                for sense in obj.get("senses") or []:
                    all_translations.extend(sense.get("translations") or [])

                for tr_item in all_translations:
                    t_lang = tr_item.get("lang_code", "")
                    if t_lang == "ar":
                        raw_ar = tr_item.get("word", "")
                        roman = clean_field(tr_item.get("roman", ""))
                        for ar_cand in extract_clean_arabic_candidates(raw_ar):
                            norm = normalize_arabic(ar_cand)
                            if norm not in needed_norm_words:
                                continue
                            entry = inverted_ar.setdefault(
                                norm,
                                {"vocalized": "", "translit": "", "ipa": "", "pos": pos, "meanings": []},
                            )
                            if HAS_HARAKAT_RE.search(ar_cand) and not entry["vocalized"]:
                                entry["vocalized"] = ar_cand
                            if roman and not entry["translit"]:
                                entry["translit"] = roman
                            if pos and not entry["pos"]:
                                entry["pos"] = pos
                            if de_word not in entry["meanings"] and len(entry["meanings"]) < 4:
                                entry["meanings"].append(de_word)
                    elif build_en_de and t_lang == "en":
                        en_w = clean_field(tr_item.get("word", "")).lower()
                        if en_w and len(en_w) <= 35:
                            lst = en_to_de.setdefault(en_w, [])
                            if de_word not in lst and len(lst) < 3:
                                lst.append(de_word)

            # C) Englischer Eintrag auf de.wiktionary -> EN->DE Bruecke
            elif build_en_de and lang_code == "en":
                en_word = clean_field(obj.get("word", "")).lower()
                if not en_word or len(en_word) > 35:
                    continue
                for sense in obj.get("senses") or []:
                    for g in sense.get("glosses") or []:
                        gc = clean_field(g).split(",")[0].split(";")[0].strip()
                        if 1 < len(gc) <= 35:
                            lst = en_to_de.setdefault(en_word, [])
                            if gc not in lst and len(lst) < 3:
                                lst.append(gc)
                            break

    print(f"\n  Fertig: {len(direct_ar)} direkte AR-Einträge + {len(inverted_ar)} invertierte DE->AR Treffer.")
    return direct_ar, inverted_ar, en_to_de


# ==================== 2. OPTIONAL: KAIKKI AR-DUMP (EN-WIKTIONARY) ====================


def load_kaikki_ar_dump(
    dump_path: Path,
    needed_norm_words: set[str],
    en_to_de: dict[str, list[str]],
) -> dict[str, dict]:
    """Extrahiert Harakat, IPA, Umschrift, Wortart & (ins DE uebersetzte) Bedeutungen aus dem 177k AR-Dump."""
    found: dict[str, dict] = {}
    print(f"Durchsuche arabischen Wiktionary-Dump ({dump_path.name})...")
    opener = gzip.open if dump_path.suffix == ".gz" else open

    def _translate_en_gloss(gloss: str) -> str:
        # Kurze englische Glossen ueber das lokale DE-Wiktionary EN->DE Woerterbuch uebersetzen
        candidates = [p.strip() for p in re.split(r"[,;]", gloss) if p.strip()]
        de_hits: list[str] = []
        for cand in candidates[:3]:
            key = re.sub(r"^(?:to|a|an|the)\s+", "", cand.lower()).strip()
            key = re.sub(r"\([^)]*\)", "", key).strip()
            if key in en_to_de:
                for de_w in en_to_de[key][:2]:
                    if de_w not in de_hits:
                        de_hits.append(de_w)
        if de_hits:
            return ", ".join(de_hits[:3])
        return ""

    with opener(dump_path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            raw_word = clean_field(obj.get("word", ""))
            norm = normalize_arabic(raw_word)
            if norm not in needed_norm_words:
                continue

            vocalized = raw_word if HAS_HARAKAT_RE.search(raw_word) else ""
            translit = ""
            for form in obj.get("forms") or []:
                ft = clean_field(form.get("form", ""))
                tags = form.get("tags") or []
                if not vocalized and "canonical" in tags and HAS_HARAKAT_RE.search(ft):
                    vocalized = ft
                if not translit and form.get("roman"):
                    translit = clean_field(form["roman"])
                if not translit and "romanization" in tags and ft:
                    translit = ft

            ipa = ""
            for snd in obj.get("sounds") or []:
                if snd.get("ipa"):
                    ipa = clean_field(snd["ipa"])
                    break

            de_meanings: list[str] = []
            en_fallback: list[str] = []
            for sense in obj.get("senses") or []:
                tags = sense.get("tags") or []
                if "form-of" in tags:
                    continue
                for g in sense.get("glosses") or []:
                    gc = clean_field(g)
                    if not gc:
                        continue
                    de_tr = _translate_en_gloss(gc)
                    if de_tr and de_tr not in de_meanings:
                        de_meanings.append(de_tr)
                    elif gc not in en_fallback and len(en_fallback) < 2:
                        en_fallback.append(gc)
                    if len(de_meanings) >= 3:
                        break
                if len(de_meanings) >= 3:
                    break

            meanings = de_meanings if de_meanings else ([f"[EN] {'; '.join(en_fallback)}"] if en_fallback else [])
            if not meanings and not vocalized:
                continue

            existing = found.get(norm)
            if not existing or (de_meanings and existing["meanings"] and existing["meanings"][0].startswith("[EN]")):
                found[norm] = {
                    "vocalized": vocalized,
                    "translit": translit,
                    "ipa": ipa,
                    "pos": map_pos(obj.get("pos", "")),
                    "meanings": meanings,
                }

    print(f"  Fertig: {len(found)} Treffer aus dem arabischen Wiktionary-Dump.")
    return found


# ==================== 3. OPTIONAL: LOKALER DICT.CC EXPORT ====================


def load_dictcc_file(dictcc_path: Path, needed_norm_words: set[str]) -> dict[str, dict]:
    """Liest eine lokal heruntergeladene dict.cc Arabisch-Deutsch .txt-Datei ein."""
    found: dict[str, dict] = {}
    print(f"Lese lokale dict.cc-Datei ({dictcc_path.name})...")
    with dictcc_path.open("r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            cols = line.rstrip("\r\n").split("\t")
            if len(cols) < 2:
                continue
            c0, c1 = clean_field(cols[0]), clean_field(cols[1])
            pos = map_pos(cols[2]) if len(cols) >= 3 else ""

            if ARABIC_TOKEN_RE.search(c0) and not ARABIC_TOKEN_RE.search(c1):
                ar_col, de_col = c0, c1
            elif ARABIC_TOKEN_RE.search(c1) and not ARABIC_TOKEN_RE.search(c0):
                ar_col, de_col = c1, c0
            else:
                continue

            de_clean = re.sub(r"\s*\{[^}]*\}", "", de_col).strip()
            for ar_cand in extract_clean_arabic_candidates(ar_col):
                norm = normalize_arabic(ar_cand)
                if norm not in needed_norm_words:
                    continue
                entry = found.setdefault(
                    norm,
                    {"vocalized": "", "translit": "", "ipa": "", "pos": pos, "meanings": []},
                )
                if HAS_HARAKAT_RE.search(ar_cand) and not entry["vocalized"]:
                    entry["vocalized"] = ar_cand
                if de_clean and de_clean not in entry["meanings"] and len(entry["meanings"]) < 3:
                    entry["meanings"].append(de_clean)

    print(f"  Fertig: {len(found)} Treffer aus dict.cc.")
    return found


# ==================== 4. TATOEBA OFFLINE-BEISPIELSAETZE ====================


def replace_word_with_tilde(sentence_ar: str, target_norm: str) -> str:
    tokens = sentence_ar.split()
    out = []
    replaced = False
    for tok in tokens:
        if not replaced:
            m = ARABIC_TOKEN_RE.search(tok)
            if m and normalize_arabic(m.group(0)) == target_norm:
                out.append(tok[: m.start()] + "~" + tok[m.end() :])
                replaced = True
                continue
        out.append(tok)
    return " ".join(out)


def load_tatoeba_examples(
    ara_bz2: Path,
    deu_bz2: Path,
    links_tar_bz2: Path,
    needed_norm_words: set[str],
) -> dict[str, tuple[str, str]]:
    """Extrahiert fuer jedes Zielwort den kuerzesten passenden AR-DE Beispielsatz mit ~."""
    print("Lade Tatoeba-Beispielsätze offline...")

    # 1. Passende arabische Saetze filtern
    ara_sentences: dict[str, tuple[str, list[str]]] = {}
    with bz2.open(ara_bz2, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\r\n").split("\t")
            if len(parts) < 3:
                continue
            sid, text = parts[0], clean_field(parts[2])
            word_cnt = len(text.split())
            if word_cnt < 2 or word_cnt > 10 or len(text) > 75:
                continue
            matched = []
            for tok in ARABIC_TOKEN_RE.findall(text):
                nt = normalize_arabic(tok)
                if nt in needed_norm_words and nt not in matched:
                    matched.append(nt)
            if matched:
                ara_sentences[sid] = (text, matched)

    # 2. Uebersetzungs-Links (ara -> deu) aus links.tar.bz2 streamen
    ara_to_deu: dict[str, list[str]] = {}
    needed_deu_ids: set[str] = set()
    with tarfile.open(links_tar_bz2, "r:bz2") as tar:
        member = next((m for m in tar.getmembers() if m.name.endswith("links.csv")), None)
        if member:
            f_obj = tar.extractfile(member)
            if f_obj:
                for raw_line in f_obj:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    parts = line.split("\t")
                    if len(parts) >= 2 and parts[0] in ara_sentences:
                        ara_to_deu.setdefault(parts[0], []).append(parts[1])
                        needed_deu_ids.add(parts[1])

    # 3. Nur benoetigte deutsche Saetze laden
    deu_sentences: dict[str, str] = {}
    with bz2.open(deu_bz2, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\r\n").split("\t")
            if len(parts) >= 3 and parts[0] in needed_deu_ids:
                txt = clean_field(parts[2])
                if len(txt) <= 95:
                    deu_sentences[parts[0]] = txt

    # 4. Besten Beispielsatz pro Zielwort waehlen
    best_per_word: dict[str, tuple[int, str, str]] = {}
    for ara_id, deu_ids in ara_to_deu.items():
        de_text = next((deu_sentences[d_id] for d_id in deu_ids if d_id in deu_sentences), "")
        if not de_text:
            continue
        ar_text, matched_norms = ara_sentences[ara_id]
        w_cnt = len(ar_text.split())
        has_harakat_bonus = -15 if HAS_HARAKAT_RE.search(ar_text) else 0
        for norm in matched_norms:
            ar_tilde = replace_word_with_tilde(ar_text, norm)
            if "~" not in ar_tilde:
                continue
            score = abs(w_cnt - 4) * 6 + len(ar_text) + has_harakat_bonus
            prev = best_per_word.get(norm)
            if prev is None or score < prev[0]:
                best_per_word[norm] = (score, ar_tilde, de_text)

    print(f"  Fertig: {len(best_per_word)} Wörter haben einen passenden AR-DE Beispielsatz mit ~.")
    return {k: (v[1], v[2]) for k, v in best_per_word.items()}


# ==================== ZUSAMMENFUEHREN & SPEICHERN ====================


def lookup_entry(
    norm_key: str,
    dictcc_idx: dict[str, dict],
    de_direct: dict[str, dict],
    de_inverted: dict[str, dict],
    en_kaikki: dict[str, dict],
) -> dict | None:
    """Kombiniert Treffer aus allen lokalen Quellen nach Qualitaets-Prioritaet."""
    sources = [dictcc_idx.get(norm_key), de_direct.get(norm_key), de_inverted.get(norm_key), en_kaikki.get(norm_key)]
    valid = [s for s in sources if s]
    if not valid:
        return None

    vocalized = next((s["vocalized"] for s in valid if s.get("vocalized")), "")
    translit = next((s["translit"] for s in valid if s.get("translit")), "")
    ipa = next((s["ipa"] for s in valid if s.get("ipa")), "")
    pos = next((s["pos"] for s in valid if s.get("pos")), "")

    # Deutsche Bedeutungen bevorzugen
    meanings: list[str] = []
    for s in [dictcc_idx.get(norm_key), de_direct.get(norm_key), de_inverted.get(norm_key)]:
        if not s:
            continue
        for m in s.get("meanings") or []:
            if m and m not in meanings:
                meanings.append(m)
            if len(meanings) >= 3:
                break
        if len(meanings) >= 3:
            break

    if not meanings and en_kaikki.get(norm_key):
        meanings = list(en_kaikki[norm_key].get("meanings") or [])[:3]

    if not meanings and not vocalized:
        return None

    return {
        "vocalized": vocalized,
        "translit": translit,
        "ipa": ipa,
        "pos": pos,
        "meanings": meanings,
    }


def write_output(output_path: Path, rows: list[tuple[int, str, str, str, str, int]]) -> None:
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n")
        writer.writerow(["rank", "word", "vocalized", "translit", "meaning", "freq"])
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Bereitet arabische Frequenzlisten 100% offline ohne API-Keys & ohne KI auf."
    )
    parser.add_argument("input_file", type=Path, help="Frequenzliste (Leipzig TSV oder OpenSubtitles ar_50k.txt)")
    parser.add_argument("-o", "--output", type=Path, default=Path("vocab_prepared.tsv"), help="Ausgabedatei")
    parser.add_argument("--cache-dir", type=Path, default=Path("cache"), help="Ordner für heruntergeladene Dumps")
    parser.add_argument("--limit", type=int, default=5000, help="Anzahl Wörter in der Ausgabedatei (Standard: 5000)")
    parser.add_argument("--no-examples", action="store_true", help="Tatoeba-Beispielsätze überspringen")
    parser.add_argument("--with-en-kaikki", action="store_true", help="Zusätzlich großen arabischen Kaikki-Dump (~828 MB) laden für noch mehr Harakat/Treffer")
    parser.add_argument("--kaikki-de", type=Path, default=None, help="Optional: Pfad zu bereits heruntergeladener de-extract.jsonl.gz")
    parser.add_argument("--kaikki-ar", type=Path, default=None, help="Optional: Pfad zu bereits heruntergeladener kaikki.org-dictionary-Arabic.jsonl(.gz)")
    parser.add_argument("--dictcc", type=Path, default=None, help="Optional: Pfad zu einer lokalen dict.cc AR-DE .txt-Datei")
    args = parser.parse_args()

    if not args.input_file.exists():
        sys.exit(f"Eingabedatei nicht gefunden: {args.input_file}")

    sorted_words = read_frequency_file(args.input_file)[: args.limit]
    if not sorted_words:
        sys.exit("Keine gültigen arabischen Wörter gefunden.")
    print(f"Frequenzliste geladen: {len(sorted_words):,} arabische Wörter.")

    # Alle Zielwoerter + deren grammatikalische Staemme fuer den Streaming-Filter sammeln
    needed_norm_words: set[str] = set()
    stem_cache: dict[str, list[tuple[str, str, str, str, str]]] = {}
    for word, _ in sorted_words:
        needed_norm_words.add(normalize_arabic(word))
        stems = generate_stem_variants(word)
        stem_cache[word] = stems
        for _, _, _, _, stem in stems:
            needed_norm_words.add(normalize_arabic(stem))

    # 1. Deutsches Wiktionary-Dump (einmaliger Download)
    kaikki_de_path = args.kaikki_de or (args.cache_dir / "de-extract.jsonl.gz")
    if not kaikki_de_path.exists():
        de_url = discover_link(KAIKKI_RAWDATA_PAGE, r'href="([^"]*de-extract\.jsonl\.gz)"')
        download_file(de_url, kaikki_de_path, "Deutsches Wiktionary (kaikki.org)")

    use_en_kaikki = args.with_en_kaikki or (args.kaikki_ar is not None)
    de_direct, de_inverted, en_to_de = load_kaikki_de_dump(
        kaikki_de_path,
        needed_norm_words,
        build_en_de=use_en_kaikki,
    )

    # 2. Optional: Arabischer Kaikki-Dump (177k Woerter)
    en_kaikki: dict[str, dict] = {}
    if use_en_kaikki:
        kaikki_ar_path = args.kaikki_ar or (args.cache_dir / "kaikki.org-dictionary-Arabic.jsonl")
        if not kaikki_ar_path.exists():
            ar_url = discover_link(KAIKKI_AR_PAGE, r'href="([^"]*kaikki\.org-dictionary-Arabic\.jsonl(?:\.gz)?)"')
            download_file(ar_url, kaikki_ar_path, "Arabisches Wiktionary (kaikki.org)")
        en_kaikki = load_kaikki_ar_dump(kaikki_ar_path, needed_norm_words, en_to_de)

    # 3. Optional: Lokale dict.cc Datei
    dictcc_idx: dict[str, dict] = {}
    if args.dictcc:
        if not args.dictcc.exists():
            sys.exit(f"dict.cc-Datei nicht gefunden: {args.dictcc}")
        dictcc_idx = load_dictcc_file(args.dictcc, needed_norm_words)

    # 4. Tatoeba-Beispielsaetze (einmaliger Download)
    examples_map: dict[str, tuple[str, str]] = {}
    if not args.no_examples:
        ara_bz2 = download_file(TATOEBA_ARA_URL, args.cache_dir / "ara_sentences.tsv.bz2", "Tatoeba Arabisch")
        deu_bz2 = download_file(TATOEBA_DEU_URL, args.cache_dir / "deu_sentences.tsv.bz2", "Tatoeba Deutsch")
        links_bz2 = download_file(TATOEBA_LINKS_URL, args.cache_dir / "links.tar.bz2", "Tatoeba Satz-Links")
        examples_map = load_tatoeba_examples(ara_bz2, deu_bz2, links_bz2, needed_norm_words)

    # 5. Alles zusammenfuehren
    rows: list[tuple[int, str, str, str, str, int]] = []
    hits = 0

    for rank, (word, freq) in enumerate(sorted_words, start=1):
        norm = normalize_arabic(word)
        entry = lookup_entry(norm, dictcc_idx, de_direct, de_inverted, en_kaikki)
        used_prefix = None
        ex_key = norm

        if not entry:
            for voc_p, tr_p, pos_note, de_pref, stem in stem_cache[word]:
                stem_norm = normalize_arabic(stem)
                stem_entry = lookup_entry(stem_norm, dictcc_idx, de_direct, de_inverted, en_kaikki)
                if stem_entry:
                    entry = stem_entry
                    used_prefix = (voc_p, tr_p, pos_note, de_pref)
                    if norm not in examples_map and stem_norm in examples_map:
                        ex_key = stem_norm
                    break

        ex_ar, ex_de = examples_map.get(ex_key, ("", ""))

        if entry:
            hits += 1
            voc = entry["vocalized"]
            tr = entry["translit"]
            pos = entry["pos"]
            meanings_str = ", ".join(entry["meanings"])

            if used_prefix:
                voc_p, tr_p, pos_note, de_pref = used_prefix
                if voc:
                    voc = voc_p + voc
                if tr:
                    tr = tr_p + tr
                pos = f"{pos_note} + {pos}" if pos else pos_note
                if de_pref and meanings_str and not meanings_str.lower().startswith(de_pref.strip().lower()):
                    meanings_str = f"{de_pref}{meanings_str}"

            pron_field = build_pronunciation_field(word, voc, tr, entry.get("ipa", ""))
            meaning_field = format_pons_meaning(pos, meanings_str, ex_ar, ex_de)
        else:
            voc = ""
            pron_field = build_pronunciation_field(word, "", "", "")
            meaning_field = format_pons_meaning("", "", ex_ar, ex_de)

        rows.append((rank, word, voc, pron_field, meaning_field, freq))

    write_output(args.output, rows)
    print(f"\nFertig! {len(rows):,} Wörter in {args.output} gespeichert ({hits:,} mit Wörterbuch-Treffer).")
    print("\nVorschau der ersten 15 Einträge:")
    for r in rows[:15]:
        print(f"  #{r[0]:<3} {r[1]} ({r[2] or '-'}) -> {r[3] or '-'} | {r[4] or '-'}")


if __name__ == "__main__":
    main()