/**
 * Tests del módulo trash/soft-delete.
 *
 * Solo testeamos las constantes / mappings exportados (cosas puras).
 * Las funciones `softDelete`, `restoreItem`, `hardDeleteItem` se
 * comunican con Supabase y se testean implícitamente vía las RPCs SQL
 * de la migración 20260816000000 — no las mockeamos acá porque el
 * valor sería bajo: ya están en producción y la lógica server-side
 * (RPC con SECURITY INVOKER + RLS) es la que importa.
 */
import { describe, expect, it } from "vitest";
import { TRASH_TABLE_LABEL, TRASH_NAME_COL, type TrashTable } from "./soft-delete";

/** Set canónico de tablas de papelera — alineado con las migraciones SQL
 *  20260816000000 (8 entidades base) y 20260818000000 (tenants). Si
 *  este set cambia, también deben cambiar:
 *    - La migración 20260816000000 (purge + RPCs trash_*_item).
 *    - La migración 20260818000000 (purge ampliado + RPCs soft/restore/hard_delete_tenant).
 *    - El seed 20260816000010 (module_visibility).
 *    - El handler de Papelera UI (src/routes/app.trash.tsx → TABLES). */
const EXPECTED_TABLES = [
  "courses",
  "exams",
  "workshops",
  "projects",
  "attendance_sessions",
  "whiteboards",
  "generated_contents",
  "polls",
  "tenants",
] as const satisfies readonly TrashTable[];

describe("TRASH_TABLE_LABEL", () => {
  it("cubre TODAS las tablas del set canónico", () => {
    EXPECTED_TABLES.forEach((tbl) => {
      expect(TRASH_TABLE_LABEL[tbl]).toBeDefined();
      expect(typeof TRASH_TABLE_LABEL[tbl]).toBe("string");
      expect(TRASH_TABLE_LABEL[tbl].length).toBeGreaterThan(0);
    });
  });

  it("tiene exactamente las mismas keys que el set canónico (no hay tablas extra ni faltantes)", () => {
    const labelKeys = Object.keys(TRASH_TABLE_LABEL).sort();
    const expectedKeys = [...EXPECTED_TABLES].sort();
    expect(labelKeys).toEqual(expectedKeys);
  });

  it("labels son visibles en español (smoke)", () => {
    // No queremos labels accidentalmente en inglés. Estos sí en español:
    expect(TRASH_TABLE_LABEL.courses).toBe("Cursos");
    expect(TRASH_TABLE_LABEL.exams).toBe("Exámenes");
    expect(TRASH_TABLE_LABEL.attendance_sessions).toBe("Sesiones");
    expect(TRASH_TABLE_LABEL.polls).toBe("Encuestas");
  });
});

describe("TRASH_NAME_COL", () => {
  it("cubre TODAS las tablas del set canónico", () => {
    EXPECTED_TABLES.forEach((tbl) => {
      expect(TRASH_NAME_COL[tbl]).toBeDefined();
      expect(typeof TRASH_NAME_COL[tbl]).toBe("string");
      expect(TRASH_NAME_COL[tbl].length).toBeGreaterThan(0);
    });
  });

  it("usa columnas SQL conocidas — name | title | topic (no inventa)", () => {
    // Defensa contra typos en el mapeo. La RPC trash_restore_item NO
    // depende de esto (solo identifica filas por id), pero la query de
    // SELECT en /app/trash sí — un nombre de columna mal-tipeado tira
    // "column X does not exist" en runtime.
    const validNameCols = new Set(["name", "title", "topic"]);
    EXPECTED_TABLES.forEach((tbl) => {
      expect(validNameCols.has(TRASH_NAME_COL[tbl])).toBe(true);
    });
  });

  it("mapeo específico por tabla matchea con el schema real", () => {
    expect(TRASH_NAME_COL.courses).toBe("name");
    expect(TRASH_NAME_COL.exams).toBe("title");
    expect(TRASH_NAME_COL.workshops).toBe("title");
    expect(TRASH_NAME_COL.projects).toBe("title");
    expect(TRASH_NAME_COL.attendance_sessions).toBe("title");
    expect(TRASH_NAME_COL.whiteboards).toBe("name");
    expect(TRASH_NAME_COL.generated_contents).toBe("topic");
    expect(TRASH_NAME_COL.polls).toBe("title");
    expect(TRASH_NAME_COL.tenants).toBe("name");
  });
});
