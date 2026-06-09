import { describe, expect, it } from "vitest";
import {
  availableClassNumbers,
  classNumberFromFilename,
  extractClassTitle,
  extractClassTitleFromBucket,
  extractContentText,
  groupFilesByClass,
  isIntroFilename,
  isTeacherOnlyFile,
  type ContentFile,
} from "./contents-extract";

const F = (
  name: string,
  body?: string,
  kind: ContentFile["kind"] = "md",
): ContentFile => ({ name, path: `bucket/${name}`, kind, body });

describe("classNumberFromFilename — contrato CLASE_N", () => {
  it("matchea CLASE_3", () => {
    expect(classNumberFromFilename("PRESENTACION_CLASE_3.PPTX")).toBe(3);
  });

  it("acepta CLASS / SESION / SESSION", () => {
    expect(classNumberFromFilename("PRESENTACION_CLASS_2.PPTX")).toBe(2);
    expect(classNumberFromFilename("GUIA_SESION_5.MD")).toBe(5);
    expect(classNumberFromFilename("EXAM_SESSION_7.MD")).toBe(7);
  });

  it("case-insensitive", () => {
    expect(classNumberFromFilename("presentacion_clase_4.pptx")).toBe(4);
  });

  it("acepta separadores espacios / guiones", () => {
    expect(classNumberFromFilename("Clase 6 introduccion.md")).toBe(6);
    expect(classNumberFromFilename("CLASE-9.MD")).toBe(9);
  });
});

describe("classNumberFromFilename — fallbacks", () => {
  it("trailing _N.ext (modelo abrevió)", () => {
    expect(classNumberFromFilename("PRESENTACION_3.PPTX")).toBe(3);
  });

  it("leading N_ (zero-relleno)", () => {
    expect(classNumberFromFilename("03_PRESENTACION.PPTX")).toBe(3);
  });

  it("trailing _N sin extensión", () => {
    expect(classNumberFromFilename("MATERIAL_7")).toBe(7);
  });
});

describe("classNumberFromFilename — null cases", () => {
  it("nombres sin número devuelven null", () => {
    expect(classNumberFromFilename("INTRO_CURSO.PPTX")).toBeNull();
    expect(classNumberFromFilename("README.MD")).toBeNull();
  });

  it("ignora versiones como v2.0", () => {
    expect(classNumberFromFilename("manual_v2.0.pdf")).toBeNull();
  });

  it("rechaza N > 100 (probable año o id)", () => {
    expect(classNumberFromFilename("DOC_2024.PDF")).toBeNull();
    expect(classNumberFromFilename("CLASE_500.MD")).toBeNull();
  });

  it("rechaza N=0 (clases empiezan en 1)", () => {
    expect(classNumberFromFilename("CLASE_0.MD")).toBeNull();
  });
});

describe("availableClassNumbers", () => {
  it("dedupa y ordena ascendente", () => {
    const files = [F("CLASE_3_A.MD"), F("CLASE_1_B.MD"), F("CLASE_3_C.MD")];
    expect(availableClassNumbers(files)).toEqual([1, 3]);
  });

  it("ignora archivos sin número de clase", () => {
    const files = [F("INTRO.PPTX"), F("CLASE_2_X.MD")];
    expect(availableClassNumbers(files)).toEqual([2]);
  });

  it("array vacío → []", () => {
    expect(availableClassNumbers([])).toEqual([]);
  });
});

describe("isIntroFilename", () => {
  it("matchea palabras clave de intro", () => {
    expect(isIntroFilename("INTRO_CURSO.PPTX")).toBe(true);
    expect(isIntroFilename("INTRODUCCION.MD")).toBe(true);
    expect(isIntroFilename("PORTADA.PPTX")).toBe(true);
    expect(isIntroFilename("Cover.pdf")).toBe(true);
  });

  it("rechaza archivos sin esas palabras", () => {
    expect(isIntroFilename("PRESENTACION_CLASE_1.PPTX")).toBe(false);
    expect(isIntroFilename("CLASE_3_TALLER.MD")).toBe(false);
  });
});

describe("isTeacherOnlyFile", () => {
  it("solución de ejercicio → true", () => {
    expect(isTeacherOnlyFile("EJERCICIO_SOLUCION_CLASE_3.MD")).toBe(true);
    expect(isTeacherOnlyFile("solution_class_2.md")).toBe(true);
  });

  it("guía docente → true", () => {
    expect(isTeacherOnlyFile("GUIA_DOCENTE_CLASE_1.MD")).toBe(true);
    expect(isTeacherOnlyFile("guia docente clase 1.md")).toBe(true);
    expect(isTeacherOnlyFile("teacher_guide.md")).toBe(true);
  });

  it("examen por sesión → true", () => {
    expect(isTeacherOnlyFile("EXAMEN_CLASE_5.MD")).toBe(true);
    expect(isTeacherOnlyFile("EXAM_CLASE_2.MD")).toBe(true);
  });

  it("material del estudiante → false", () => {
    expect(isTeacherOnlyFile("PRESENTACION_CLASE_1.PPTX")).toBe(false);
    expect(isTeacherOnlyFile("TALLER_PRACTICO_CLASE_2.MD")).toBe(false);
    expect(isTeacherOnlyFile("EJERCICIO_ESTUDIANTE_CLASE_3.MD")).toBe(false);
    expect(isTeacherOnlyFile("INTRO_CURSO.PPTX")).toBe(false);
  });

  it("'guia' sola sin 'docente' NO es teacher-only", () => {
    // El comentario del helper documenta que NO matchea solo "GUIA".
    expect(isTeacherOnlyFile("guia_estudiante.md")).toBe(false);
  });
});

describe("groupFilesByClass — detección directa", () => {
  it("agrupa por clase y mete intro lo que no matchee", () => {
    const files = [
      F("INTRO_CURSO.PPTX"),
      F("PRESENTACION_CLASE_1.PPTX"),
      F("GUIA_CLASE_1.MD"),
      F("PRESENTACION_CLASE_2.PPTX"),
    ];
    const { intro, byClass } = groupFilesByClass(files, 2);
    expect(intro).toHaveLength(1);
    expect(intro[0].name).toBe("INTRO_CURSO.PPTX");
    expect(byClass.get(1)).toHaveLength(2);
    expect(byClass.get(2)).toHaveLength(1);
  });
});

describe("groupFilesByClass — fallback por orden cuando no hay sufijo", () => {
  it("reparte equitativamente cuando ningún archivo tiene número", () => {
    const files = [
      F("INTRO_CURSO.PPTX"),
      F("PRESENTACION.PPTX"),
      F("GUIA.MD"),
      F("TALLER.MD"),
      F("EJERCICIO.MD"),
    ];
    const { intro, byClass } = groupFilesByClass(files, 2);
    // INTRO va a intro
    expect(intro.map((f) => f.name)).toContain("INTRO_CURSO.PPTX");
    // 4 restantes / 2 clases = 2 por clase
    expect(byClass.size).toBeGreaterThan(0);
    const total = [...byClass.values()].reduce((acc, arr) => acc + arr.length, 0);
    expect(total + intro.length).toBe(files.length);
  });

  it("nClasses null/0 + sin números → todo va a intro", () => {
    const files = [F("PRESENTACION.PPTX"), F("GUIA.MD")];
    const { intro, byClass } = groupFilesByClass(files, null);
    expect(intro).toHaveLength(2);
    expect(byClass.size).toBe(0);
  });

  it("files vacío → estructura vacía", () => {
    const { intro, byClass } = groupFilesByClass([], 5);
    expect(intro).toHaveLength(0);
    expect(byClass.size).toBe(0);
  });
});

describe("extractContentText", () => {
  const files: ContentFile[] = [
    F("PRESENTACION_CLASE_1.PPTX", "Slides clase 1"),
    F("GUIA_CLASE_1.MD", "Guía detallada clase 1"),
    F("PRESENTACION_CLASE_2.PPTX", "Slides clase 2"),
    F("MATERIAL_SIN_BODY.MD"), // sin body — se ignora
  ];

  it("concatena con headers '### name'", () => {
    const out = extractContentText(files.slice(0, 1));
    expect(out).toContain("### PRESENTACION_CLASE_1.PPTX");
    expect(out).toContain("Slides clase 1");
  });

  it("filtra por classNumber singular", () => {
    const out = extractContentText(files, { classNumber: 1 });
    expect(out).toContain("Slides clase 1");
    expect(out).toContain("Guía detallada clase 1");
    expect(out).not.toContain("Slides clase 2");
  });

  it("filtra por classNumbers (plural)", () => {
    const out = extractContentText(files, { classNumbers: [2] });
    expect(out).toContain("Slides clase 2");
    expect(out).not.toContain("Slides clase 1");
  });

  it("cae a 'todos los archivos' si el filtro no matchea ninguno", () => {
    const out = extractContentText(files, { classNumber: 99 });
    // No matchea → usa todos los archivos con body
    expect(out).toContain("Slides clase 1");
    expect(out).toContain("Slides clase 2");
  });

  it("trunca a maxChars con marcador", () => {
    const longBody = "A".repeat(1000);
    const big: ContentFile[] = [F("X.MD", longBody)];
    const out = extractContentText(big, { maxChars: 200 });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/truncado/);
  });

  it("ignora archivos sin body", () => {
    const out = extractContentText(files);
    expect(out).not.toContain("MATERIAL_SIN_BODY");
  });
});

describe("extractClassTitle", () => {
  it("extrae heading markdown limpio", () => {
    const files: ContentFile[] = [
      F("GUIA_CLASE_1.MD", "# Estructura de control en Python\n\nPárrafo..."),
    ];
    expect(extractClassTitle(files, 1)).toBe("Estructura de control en Python");
  });

  it("quita prefijo redundante 'Clase N:'", () => {
    const files: ContentFile[] = [
      F("GUIA_CLASE_2.MD", "# Clase 2: Bucles y funciones\n\nContenido..."),
    ];
    expect(extractClassTitle(files, 2)).toBe("Bucles y funciones");
  });

  it("cae a primera línea con sustancia si no hay heading", () => {
    const files: ContentFile[] = [F("M_CLASE_3.MD", "Introducción al tema\n\nResto")];
    expect(extractClassTitle(files, 3)).toBe("Introducción al tema");
  });

  it("recorta prefijo 'TITULO:'", () => {
    const files: ContentFile[] = [F("M_CLASE_4.MD", "Titulo: Mi tema bonito\n\nResto")];
    expect(extractClassTitle(files, 4)).toBe("Mi tema bonito");
  });

  it("trunca a 120 chars", () => {
    const longHeading = "# " + "X".repeat(200);
    const files: ContentFile[] = [F("M_CLASE_5.MD", longHeading)];
    const title = extractClassTitle(files, 5);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(120);
  });

  it("null si no hay archivos de esa clase con body", () => {
    const files: ContentFile[] = [F("M_CLASE_1.MD")];
    expect(extractClassTitle(files, 1)).toBeNull();
    expect(extractClassTitle([], 1)).toBeNull();
  });

  it("solo lee archivos de la clase pedida", () => {
    const files: ContentFile[] = [
      F("M_CLASE_1.MD", "# Tema clase 1"),
      F("M_CLASE_2.MD", "# Tema clase 2"),
    ];
    expect(extractClassTitle(files, 2)).toBe("Tema clase 2");
  });

  it("NO usa el JSON de un .ipynb como título (cae a null)", () => {
    const files: ContentFile[] = [
      F("notebook_CLASE_6.ipynb", '{"nbformat":4,"nbformat_minor":0,"cells":[]}'),
    ];
    expect(extractClassTitle(files, 6)).toBeNull();
  });

  it("ignora bodies que arrancan con { (JSON) aunque la extensión no sea .ipynb", () => {
    const files: ContentFile[] = [F("data_CLASE_7.MD", '{"foo":"bar"}')];
    expect(extractClassTitle(files, 7)).toBeNull();
  });

  it("usa el .md de la clase cuando hay notebook + guía juntos", () => {
    const files: ContentFile[] = [
      F("nb_CLASE_8.ipynb", '{"nbformat":4}'),
      F("GUIA_CLASE_8.MD", "# Herencia y polimorfismo\n\n..."),
    ];
    expect(extractClassTitle(files, 8)).toBe("Herencia y polimorfismo");
  });
});

describe("extractClassTitleFromBucket", () => {
  it("usa los archivos pasados sin filtrar por nombre", () => {
    const files: ContentFile[] = [F("CUALQUIER.MD", "# Tema X")];
    expect(extractClassTitleFromBucket(files)).toBe("Tema X");
  });

  it("null si ninguno trae body", () => {
    const files: ContentFile[] = [F("CUALQUIER.MD")];
    expect(extractClassTitleFromBucket(files)).toBeNull();
  });
});
