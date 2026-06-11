# -*- coding: utf-8 -*-
# Generador de voz GENÉRICO: lee un spec de módulo (JSON) y sintetiza la
# narración de cada escena con edge-tts. Reutilizable para cualquier módulo.
#
# Uso:  python gen-voice.py [ruta_modulo.json]
import asyncio, json, sys, edge_tts

MODULE = sys.argv[1] if len(sys.argv) > 1 else "C:/Temp/examlab-rec/modules/module-01.json"
OUT = "C:/Temp/examlab-rec/audio2"

with open(MODULE, "r", encoding="utf-8") as f:
    spec = json.load(f)

voice = spec.get("voice", {})
VOICE = voice.get("name", "es-CO-GonzaloNeural")
RATE = voice.get("rate", "-4%")
scenes = spec["scenes"]

async def save_with_retry(text, path, attempts=4):
    for a in range(1, attempts + 1):
        try:
            c = edge_tts.Communicate(text, VOICE, rate=RATE)
            await c.save(path)
            # validar que NO quedó vacío (fallo transitorio deja 0 bytes)
            import os
            if os.path.getsize(path) > 1000:
                return
            raise RuntimeError("archivo vacío")
        except Exception as e:
            print(f"    intento {a}/{attempts} falló: {e}")
            await asyncio.sleep(2 * a)
    raise RuntimeError(f"no se pudo generar {path}")

async def main():
    for i, sc in enumerate(scenes, 1):
        text = sc.get("narration", "").strip()
        await save_with_retry(text, f"{OUT}/scene-{i}.mp3")
        print(f"  ok scene-{i}.mp3  ({sc.get('id','')})")

asyncio.run(main())
print(f"DONE ({len(scenes)} escenas, voz {VOICE})")
