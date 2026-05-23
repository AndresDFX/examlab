/**
 * Tile compacto para grids de "quick-stats" arriba de los listados.
 * Fondo tintado, número grande, label pequeño debajo. Lo usan los
 * listados del estudiante (exámenes/talleres/proyectos) y del docente
 * para mostrar conteos por estado.
 */
export function StatTile({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-md p-2.5 ${bg}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
