# -*- coding: utf-8 -*-
# Generador de voz GENÉRICO: lee un spec de módulo (JSON) y sintetiza la
# narración de cada escena con edge-tts. Reutilizable para cualquier módulo.
# Además del mp3, guarda scene-N-words.json con los WordBoundary (offset ms
# por palabra) — el recorder los usa para sincronizar cada beat/spotlight con
# el instante en que la palabra se PRONUNCIA (beat.syncWord).
#
# Uso:  python gen-voice.py [ruta_modulo.json]
import asyncio, json, os, sys, edge_tts

MODULE = sys.argv[1] if len(sys.argv) > 1 else "C:/Temp/examlab-rec/modules/module-01.json"
OUT = "C:/Temp/examlab-rec/audio2"

with open(MODULE, "r", encoding="utf-8") as f:
    spec = json.load(f)

voice = spec.get("voice", {})
VOICE = voice.get("name", "es-CO-GonzaloNeural")
RATE = voice.get("rate", "-4%")
PITCH = voice.get("pitch", "+0Hz")  # opcional por módulo: levanta el tono (ej. "+8Hz") para una voz menos plana
scenes = spec["scenes"]

async def _synth(text, path, words_path, rate, pitch):
    c = edge_tts.Communicate(text, VOICE, rate=rate, pitch=pitch, boundary="WordBoundary")
    words = []
    with open(path, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                # offset viene en ticks de 100ns → ms
                words.append({"w": ch["text"], "t": round(ch["offset"] / 10000)})
    if os.path.getsize(path) > 1000:
        with open(words_path, "w", encoding="utf-8") as wf:
            json.dump(words, wf, ensure_ascii=False)
        return
    raise RuntimeError("archivo vacío")

# TIMEOUT por intento: el stream() de edge-tts puede COLGARSE indefinidamente si
# la red se estanca (no lanza excepción → el retry de abajo nunca dispararía).
# asyncio.wait_for convierte el cuelgue en TimeoutError → reintenta; si agota los
# intentos, propaga y make.mjs marca el módulo como fallido y sigue con el
# siguiente (antes: un cuelgue detenía TODO el batch ~2h, caso real t05).
async def save_with_retry(text, path, words_path, rate=None, pitch=None, attempts=4, timeout=45):
    rate = rate if rate is not None else RATE
    pitch = pitch if pitch is not None else PITCH
    for a in range(1, attempts + 1):
        try:
            await asyncio.wait_for(_synth(text, path, words_path, rate, pitch), timeout=timeout)
            return
        except Exception as e:
            print(f"    intento {a}/{attempts} falló: {e}")
            await asyncio.sleep(2 * a)
    raise RuntimeError(f"no se pudo generar {path}")

async def main():
    for i, sc in enumerate(scenes, 1):
        text = sc.get("narration", "").strip()
        # Voz por ESCENA: sc.voice.{rate,pitch} sobreescribe el módulo → voz dinámica
        # (ej. tono cansado/deadpan en el dolor, enérgico en el giro y la oferta).
        sv = sc.get("voice", {})
        await save_with_retry(text, f"{OUT}/scene-{i}.mp3", f"{OUT}/scene-{i}-words.json",
                              sv.get("rate"), sv.get("pitch"))
        print(f"  ok scene-{i}.mp3  ({sc.get('id','')})")

asyncio.run(main())
print(f"DONE ({len(scenes)} escenas, voz {VOICE})")
