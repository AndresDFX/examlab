import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SqlAnswerReview } from "./SqlAnswerReview";
import { serializeSqlAnswer } from "./sql-answer";

// La respuesta real que motivó el componente (Parcial 1, pregunta 10): el docente
// veía este JSON literal en el monitor.
const CARMONA = JSON.stringify({
  bdSql: 1,
  sql: "--select * from pedido;\r\n\r\nupdate pedido set estado = 'ENIVADO' where id = 1\r\n\r\nselect * from pedido where total < '50000';\r\n\r\ndelete from pedido where total < '50000';",
  results: [
    {
      sql: "select * from pedido where total < '50000'",
      columns: ["id", "cliente", "total", "estado"],
      rows: [["2", "Luis Paz", "45000.00", "NUEVO"]],
      affectedRows: 0,
    },
  ],
});

describe("SqlAnswerReview", () => {
  it("muestra el SQL y el resultado como tabla, nunca el JSON guardado", () => {
    const { container } = render(<SqlAnswerReview value={CARMONA} />);
    expect(container.textContent).not.toContain("bdSql");
    expect(container.textContent).toContain("update pedido set estado = 'ENIVADO'");
    expect(screen.getByRole("columnheader", { name: "cliente" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Luis Paz" })).toBeTruthy();
  });

  it("avisa cuando la última ejecución fue solo una parte del guion", () => {
    render(<SqlAnswerReview value={CARMONA} />);
    // 2 sentencias en el guion (el UPDATE sin «;» va pegado al SELECT) y 1 resultado.
    expect(screen.getByText(/1 de 2 sentencias/)).toBeTruthy();
  });

  it("marca los errores de Postgres y las filas afectadas", () => {
    const valor = serializeSqlAnswer({
      sql: "grabt select on nomina to contadora; delete from pedido where id = 2;",
      results: [
        {
          sql: "grabt select on nomina to contadora",
          columns: [],
          rows: [],
          error: 'syntax error at or near "grabt"',
        },
        { sql: "delete from pedido where id = 2", columns: [], rows: [], affectedRows: 1 },
      ],
    });
    render(<SqlAnswerReview value={valor} />);
    expect(screen.getByText(/syntax error at or near "grabt"/)).toBeTruthy();
    expect(screen.getByText("OK — 1 fila afectada")).toBeTruthy();
    expect(screen.queryByText(/sentencias\)/)).toBeNull();
  });

  it("sin ejecutar: dice que se revisa leyendo el SQL", () => {
    render(<SqlAnswerReview value={serializeSqlAnswer({ sql: "select 1;", results: [] })} />);
    expect(screen.getByText(/No lo ejecutó/)).toBeTruthy();
  });

  it("sin respuesta, o con un formato que no es el de bd_sql", () => {
    const { rerender } = render(<SqlAnswerReview value={null} />);
    expect(screen.getByText("Sin respuesta")).toBeTruthy();
    rerender(<SqlAnswerReview value="SELECT * FROM viejo" />);
    expect(screen.getByText("SELECT * FROM viejo")).toBeTruthy();
  });

  it("muestra lo que imprimió RAISE NOTICE, y avisa si se recortó", () => {
    // En un ejercicio de PL/pgSQL esa salida suele ser lo que se pide: quien
    // califica tiene que verla, y saber si es completa.
    const valor = serializeSqlAnswer({
      sql: "CALL sp_baja(3);",
      results: [
        {
          sql: "CALL sp_baja(3)",
          columns: [],
          rows: [],
          affectedRows: 0,
          notices: ["NOTICE:  Insumo 3 dado de baja"],
          noticesTruncated: true,
        },
      ],
    });
    render(<SqlAnswerReview value={valor} />);
    expect(screen.getByText(/Insumo 3 dado de baja/)).toBeTruthy();
    expect(screen.getByText(/primeros 50 avisos/)).toBeTruthy();
  });
});
