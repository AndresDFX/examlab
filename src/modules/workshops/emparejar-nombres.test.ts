import { describe, expect, it } from "vitest";

import {
  emparejarLectura,
  emparejarNombre,
  formaDelToken,
  normalizarNombreLeido,
  type EstudianteMatriculado,
} from "./emparejar-nombres";

/**
 * Los nombres de las pruebas son los de PRODUCCIÓN, con su forma real: apellidos
 * primero y Title Case ("Reyes Mompotes Jean Paul"). Con nombres inventados de dos
 * palabras el emparejador parece infalible; con los reales aparecen los casos que
 * importan — apellidos compartidos, ñ, y nombres de cuatro palabras de los que Meet
 * muestra dos.
 */
const ROSTER: EstudianteMatriculado[] = [
  {
    user_id: "u1",
    full_name: "Reyes Mompotes Jean Paul",
    institutional_email: "jpaulreyes@estudiante.uniajc.edu.co",
  },
  {
    user_id: "u2",
    full_name: "Velandia Muñoz Ana Maria",
    institutional_email: "avelandia@estudiante.uniajc.edu.co",
  },
  {
    user_id: "u3",
    full_name: "Velasco Velasco David",
    institutional_email: "davidvelasco@estudiante.uniajc.edu.co",
  },
  {
    user_id: "u4",
    full_name: "Ramirez de la Portilla Andres Estiven",
    institutional_email: "aeramirez@estudiante.uniajc.edu.co",
  },
  {
    user_id: "u5",
    full_name: "Murillo Espinosa Angie Paulette",
    institutional_email: "apmurillo@estudiante.uniajc.edu.co",
  },
];

describe("normalizarNombreLeido", () => {
  it("quita los sufijos que agrega la videollamada", () => {
    expect(normalizarNombreLeido("Jean Paul Reyes (tú)")).toBe("jean paul reyes");
    expect(normalizarNombreLeido("Ana Maria (anfitrión)")).toBe("ana maria");
    expect(normalizarNombreLeido("David (presentando)")).toBe("david");
  });

  it("quita viñetas, numeración y la puntuación de las abreviaturas", () => {
    expect(normalizarNombreLeido("• Jean Paul R.")).toBe("jean paul r");
    expect(normalizarNombreLeido("1) Ana Maria")).toBe("ana maria");
    expect(normalizarNombreLeido("- David")).toBe("david");
  });

  it("iguala acentos y mayúsculas", () => {
    // La ñ es el caso concreto: el estudiante escribe "Munoz" en su cuenta de Google
    // y la matrícula dice "Muñoz".
    expect(normalizarNombreLeido("MUÑOZ")).toBe(normalizarNombreLeido("munoz"));
    expect(normalizarNombreLeido("ANDRÉS")).toBe("andres");
  });

  it("vacío para basura", () => {
    expect(normalizarNombreLeido("")).toBe("");
    expect(normalizarNombreLeido(null)).toBe("");
    expect(normalizarNombreLeido("   ...  ")).toBe("");
  });
});

describe("formaDelToken", () => {
  it("distingue correo, usuario y nombre", () => {
    expect(formaDelToken("jpaulreyes@estudiante.uniajc.edu.co")).toBe("correo");
    expect(formaDelToken("jpaulreyes")).toBe("usuario");
    expect(formaDelToken("cn.moralesp")).toBe("usuario");
    expect(formaDelToken("Jean Paul Reyes")).toBe("nombre");
  });
});

describe("emparejarNombre", () => {
  it("empareja el correo completo", () => {
    const m = emparejarNombre("jpaulreyes@estudiante.uniajc.edu.co", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u1");
    expect(m.candidatos[0].via).toBe("correo");
  });

  it("empareja la parte local del correo sin la arroba", () => {
    const m = emparejarNombre("apmurillo", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u5");
  });

  it("empareja el nombre completo en ORDEN INVERTIDO", () => {
    // Lo que muestra Meet: nombres primero. La matrícula: apellidos primero.
    const m = emparejarNombre("Jean Paul Reyes", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u1");
  });

  it("empareja aunque falte un apellido", () => {
    const m = emparejarNombre("Ana Maria Velandia", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u2");
  });

  it("empareja con el apellido abreviado", () => {
    const m = emparejarNombre("Angie Paulette M.", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u5");
  });

  it("un prefijo compartido es AMBIGUO, no «el primero»", () => {
    // "Vela" es prefijo de Velandia y de Velasco. Elegir uno pondría a alguien en el
    // grupo de otro, y la nota del taller es del grupo: el error lo pagan dos.
    const m = emparejarNombre("Vela", ROSTER);
    expect(m.estado).toBe("ambiguo");
    expect(m.candidatos.map((c) => c.user_id).sort()).toEqual(["u2", "u3"]);
  });

  it("un nombre de pila solo, compartido, es ambiguo", () => {
    const roster = [
      ...ROSTER,
      { user_id: "u6", full_name: "Otro Apellido Ana", institutional_email: null },
    ];
    const m = emparejarNombre("Ana", roster);
    expect(m.estado).toBe("ambiguo");
    expect(m.candidatos.length).toBeGreaterThan(1);
  });

  it("la misma palabra leída dos veces no matchea a cualquiera", () => {
    // Sin el control de palabras ya usadas, "Ana Ana" matchearía a "…Ana Maria"
    // apoyando las dos lecturas en la misma palabra real.
    const m = emparejarNombre("Ana Ana Ana", ROSTER);
    expect(m.estado).toBe("sin_coincidencia");
  });

  it("respeta la partícula del apellido compuesto", () => {
    const m = emparejarNombre("Andres Estiven Ramirez de la Portilla", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u4");
  });

  it("sin coincidencia cuando el nombre no es de nadie del curso", () => {
    expect(emparejarNombre("Pedro Navaja", ROSTER).estado).toBe("sin_coincidencia");
    expect(emparejarNombre("", ROSTER).estado).toBe("sin_coincidencia");
    expect(emparejarNombre("Jean Paul Reyes", []).estado).toBe("sin_coincidencia");
  });

  it("un usuario que no es correo de nadie se reintenta como nombre", () => {
    // "david" no es la parte local de ningún correo del roster salvo prefijo; tiene
    // que caer al camino de nombre y encontrar a David.
    const m = emparejarNombre("David", ROSTER);
    expect(m.estado).toBe("unico");
    expect(m.candidatos[0].user_id).toBe("u3");
  });
});

describe("emparejarLectura", () => {
  const LECTURA = [
    {
      etiqueta: "Sala 1",
      participantes: [{ nombre: "Jean Paul Reyes" }, { nombre: "Vela", confianza: "baja" as const }],
    },
    {
      etiqueta: "Sala 2",
      participantes: [{ nombre: "David" }, { nombre: "Pedro Navaja" }],
    },
  ];

  it("una fila por participante, en el orden de la imagen", () => {
    const filas = emparejarLectura(LECTURA, ROSTER);
    expect(filas.map((f) => f.leido)).toEqual([
      "Jean Paul Reyes",
      "Vela",
      "David",
      "Pedro Navaja",
    ]);
    expect(filas.map((f) => f.etiqueta)).toEqual(["Sala 1", "Sala 1", "Sala 2", "Sala 2"]);
  });

  it("preselecciona SOLO los únicos", () => {
    const filas = emparejarLectura(LECTURA, ROSTER);
    expect(filas[0].user_id).toBe("u1"); // único
    expect(filas[1].user_id).toBeNull(); // ambiguo: lo elige el docente
    expect(filas[3].user_id).toBeNull(); // sin coincidencia
  });

  it("conserva la confianza que reportó el modelo", () => {
    const filas = emparejarLectura(LECTURA, ROSTER);
    expect(filas[1].confianza).toBe("baja");
    expect(filas[0].confianza).toBe("media"); // el default cuando no viene
  });

  it("marca el nombre que aparece en DOS grupos de la imagen", () => {
    // Puede ser una sala compartida o un error de la captura: desde acá se ven igual,
    // así que se señala y decide el docente.
    const filas = emparejarLectura(
      [
        { etiqueta: "A", participantes: [{ nombre: "Jean Paul Reyes" }] },
        { etiqueta: "B", participantes: [{ nombre: "JEAN PAUL REYES (tú)" }] },
      ],
      ROSTER,
    );
    expect(filas.every((f) => f.duplicado_en_imagen)).toBe(true);
  });

  it("no marca duplicado cuando cada nombre aparece una vez", () => {
    const filas = emparejarLectura(LECTURA, ROSTER);
    expect(filas.some((f) => f.duplicado_en_imagen)).toBe(false);
  });

  it("ids únicos por fila", () => {
    const filas = emparejarLectura(LECTURA, ROSTER);
    expect(new Set(filas.map((f) => f.id)).size).toBe(filas.length);
  });

  it("lectura vacía → sin filas", () => {
    expect(emparejarLectura([], ROSTER)).toEqual([]);
    expect(emparejarLectura([{ etiqueta: "A", participantes: [] }], ROSTER)).toEqual([]);
  });
});
