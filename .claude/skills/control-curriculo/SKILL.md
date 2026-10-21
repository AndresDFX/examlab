---
name: control-curriculo
description: >
  Control currículo de la UNIAJC: arma los documentos que pide cada entrega del semestre (Acuerdo
  pedagógico, Plan de curso, Diagnóstico y seguimiento) con los FORMATOS ACTUALIZADOS que manda la
  dirección, los deja en `<Curso>/Entregas docente/<periodo>/` de la carpeta de Drive de cada curso,
  y acompaña la carga en el formulario de Microsoft Forms de la entrega. Úsalo cuando el usuario
  pida «control currículo», «la entrega 1 / 2 / 3 / 4 de currículo», «el plan de curso en el
  formato nuevo» o «subir los acuerdos al formulario».
---

# Control currículo (UNIAJC)

La dirección manda cada semestre un correo «CONTROL CURRICULO <periodo>» con un Genially (las
fechas y el enlace de cada entrega) y un zip con los formatos actualizados. Hay **4 entregas**,
una por etapa del semestre, y cada una se sube en un Microsoft Forms con la cuenta institucional.

| Entrega | Qué lleva | Cuándo |
|---|---|---|
| 1 | Acuerdo pedagógico + Plan de curso de cada grupo | Corte 1 (lo indica el Genially, calendario A o B) |
| 2–4 | Diagnóstico y seguimiento y lo que diga el Genially | Cortes siguientes |

## Dónde está cada cosa

- Formatos oficiales: `G:\Mi unidad\Trabajos\Empleo\UNIAJ\Formatos\` (comparar con el zip del
  correo por md5: si cambiaron, **mandan los del zip**).
- Cursos: `G:\Mi unidad\Trabajos\Empleo\UNIAJ\Cursos\<Curso>\` — mapa en
  `LEEME - Mapa de cursos y agentes.md`. Calendario de cada sesión en
  `config/calendario/semestre_<periodo>.json` y `introduccion_ingenieria_<periodo>.json`, y en
  `Plan curso/<periodo>/PLAN_DE_CURSO_<periodo>.md` / `CALENDARIO_<periodo> - <grupo>.md`.
- Salida: `<Curso>\Entregas docente\<periodo>\` — un `.docx` y un `.pdf` por documento y grupo.

## Cómo se arma (scripts en `scripts/`, Word por COM — corren sin `python -I`)

1. `tables.py <salida.json> <docs…>` vuelca las tablas de cualquier `.doc`/`.docx`.
2. `plan.py` arma las filas del plan de curso: **Trabajo dirigido** = el tema de la sesión del
   calendario del periodo; **Trabajo independiente dirigido / independiente** = las filas del plan
   del semestre anterior cuyo tema coincide (por palabras, no por número de sesión: el material
   «Clase N» no es la fila N del plan viejo). Los parciales llevan su texto fijo. **Revisar la
   salida a ojo**: una coincidencia por palabras se equivoca con «presentación» o «evaluación»
   (ver `FIX` en `fill.py`).
3. `fill.py` llena `PLAN DE CURSO ACTUALIZADO.doc` (16 filas; borra las sobrantes) y exporta PDF.
4. `acuerdo.py` arma el acuerdo de un curso nuevo partiendo de uno ya armado del mismo periodo.

Rutas con `os.path.normpath`: `ExportAsFixedFormat` rechaza las barras `/`.

## Reglas

- **Datos de estudiantes**: el listado, el vocero y las firmas se recogen en la socialización y
  NO se transcriben a lo que se genera (quedan como `[PENDIENTE]`); nunca se inventan nombres ni
  códigos. Nada de esto va al repo, que es público: los documentos viven en Drive.
- **Primero validar el semestre anterior**: qué se subió (en `Entregas docente/<periodo anterior>`)
  y con qué formato, para no subir este semestre un formato viejo.
- **El formulario lo llena el docente con SU sesión.** Si hace falta automatizar, abrir un
  navegador VISIBLE (Playwright con ventana) y que el docente inicie sesión él mismo. **Nunca usar
  una contraseña de cuenta personal** aunque la ofrezcan (ver CLAUDE.md: «Qué credencial pedir»);
  si la ofrecieron, recomendar rotarla.
- Antes de enviar el formulario, mostrar al docente qué archivo va en cada pregunta: un envío de
  Forms no se edita después.
