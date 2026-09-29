import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * El alumno tiene que poder CERRAR su propio intento, y no poder REABRIRLO.
 *
 * Son dos operaciones distintas sobre las mismas columnas, y confundirlas costó
 * caro en los dos sentidos:
 *
 *  · La 20261960000000 dejaba al alumno limpiar las marcas por REST y reabrir
 *    su examen terminado. La 20262410000000 lo cerró sumando las cuatro
 *    columnas al candado — bien.
 *  · Pero lo hizo con `IS DISTINCT FROM`, que es simétrico, así que también
 *    bloqueó PONERLAS. Y ponerlas es exactamente lo que hace la suspensión por
 *    advertencias desde el navegador del alumno. Resultado medido: CERO
 *    suspensiones en los cinco días siguientes, intentos con 7 advertencias
 *    sobre un tope de 3, y un docente limpiando a mano 17 veces en 50 minutos.
 *
 * Este test lee la migración del disco porque el fallo no da ningún error
 * visible: la escritura se rechaza, el cliente reintenta, restaura su bandera
 * para no dejar un spinner colgado, y el examen sigue como si nada.
 */
const SQL = fs.readFileSync(
  "supabase/migrations/20262580000000_alumno_puede_cerrar_su_propio_intento.sql",
  "utf8",
);

describe("candado de cierre del intento", () => {
  it("separa las columnas de NOTA de las de CIERRE en dos banderas", () => {
    // Mezclarlas en una sola condición ES el bug: la nota no se puede tocar
    // nunca, el cierre se puede poner una vez. Un «simplificado» que las
    // vuelva a unir reproduce la caída del proctoring.
    expect(SQL).toContain("v_toca_notas");
    expect(SQL).toContain("v_toca_cierre");
    expect(SQL).toMatch(/IF NOT v_toca_notas AND \(NOT v_toca_cierre OR v_cierre_propio\)/);
  });

  it("la nota sigue intocable: el permiso de cierre NO la perdona", () => {
    // Si el alumno mete un `ai_grade` en el mismo UPDATE que su cierre, tiene
    // que rebotar igual.
    expect(SQL).toMatch(/IF NOT v_toca_notas AND/);
    // Las columnas de nota tienen que seguir viviendo en `v_toca_notas`, que es
    // la bandera que NO tiene perdón. El bloque se aísla para que el test falle
    // si alguna se muda a la de cierre.
    const bloqueNotas = /v_toca_notas :=([\s\S]*?);/.exec(SQL);
    expect(bloqueNotas, "no se encontró la asignación de v_toca_notas").toBeTruthy();
    for (const col of [
      "final_override_grade",
      "ai_grade",
      "ai_detected",
      "teacher_feedback",
      "extra_seconds",
    ]) {
      expect(bloqueNotas![1]).toContain(col);
    }
    // Y ninguna marca de cierre puede haberse colado en esa lista.
    expect(bloqueNotas![1]).not.toContain("closed_at");
  });

  it("solo se perdona el cierre PROPIO, una sola vez y firmado por uno mismo", () => {
    // Las cuatro condiciones son el control: sin «OLD … IS NULL» vuelve a poder
    // reabrir; sin `closed_by = v_uid` puede firmar el cierre como si lo
    // hubiera hecho el docente; sin `user_id = v_uid` lo hace sobre otro; y sin
    // el cambio de estado puede marcar el cierre y seguir rindiendo.
    expect(SQL).toMatch(/OLD\.closed_at\s+IS NULL/);
    expect(SQL).toMatch(/OLD\.closed_by\s+IS NULL/);
    expect(SQL).toMatch(/OLD\.close_reason IS NULL/);
    expect(SQL).toMatch(/NEW\.closed_by\s+= v_uid/);
    expect(SQL).toMatch(/NEW\.user_id\s+= v_uid/);
    expect(SQL).toMatch(/NEW\.status\s+<> 'en_progreso'/);
  });

  it("close_deadline queda fuera del perdon: lo escribe el servidor", () => {
    expect(SQL).toMatch(/NEW\.close_deadline IS NOT DISTINCT FROM OLD\.close_deadline/);
  });

  it("el trigger se re-crea, no se confia en que ya exista", () => {
    expect(SQL).toContain("DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade");
    expect(SQL).toContain("CREATE TRIGGER trg_guard_exam_submission_grade");
  });

  it("es defensiva: no revienta donde la tabla no existe", () => {
    expect(SQL).toContain("to_regclass('public.submissions')");
  });
});

describe("lo que el cliente escribe al suspenderse", () => {
  const CLIENTE = fs.readFileSync("src/modules/exams/TakeExamScreen.tsx", "utf8");

  it("el cierre del alumno firma con su propio id", () => {
    // Si el cliente dejara `closed_by` en null, el UPDATE volvería a rebotar:
    // el perdón exige la firma propia.
    expect(CLIENTE).toMatch(/close_reason: "advertencias"/);
    expect(CLIENTE).toMatch(/closed_by: user\?\.id/);
  });

  it("y pasa a un estado que ya no es en_progreso", () => {
    expect(CLIENTE).toMatch(/status: "completado"/);
  });
});
