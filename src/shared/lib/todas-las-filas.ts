/**
 * Trae TODAS las filas de una consulta de PostgREST, de a páginas.
 *
 * PostgREST corta cada respuesta en `max_rows` (1000 en este proyecto, ver
 * `supabase/config.toml`) sin avisar: la respuesta llega con 200 y las filas de
 * más simplemente no están. Para una lista en pantalla da igual; para calcular
 * una nota no: si las marcas de asistencia de un curso de 90 estudiantes quedan
 * del otro lado del corte, las sesiones más recientes dejan de «haberse dado», y
 * una asignación que no llegó hace que un 0 no cuente.
 *
 * `consulta(desde, hasta)` arma la MISMA consulta con `.range(desde, hasta)` —el
 * builder de supabase-js no se puede reusar entre páginas— y debe llevar un
 * orden estable (la clave primaria) para que las páginas no se solapen ni se
 * salteen filas.
 */
export async function todasLasFilas<T>(
  consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  tamanoDePagina = 1000,
): Promise<{ data: T[]; error: unknown }> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += tamanoDePagina) {
    const { data, error } = await consulta(desde, desde + tamanoDePagina - 1);
    if (error) return { data: filas, error };
    const pagina = data ?? [];
    filas.push(...pagina);
    if (pagina.length < tamanoDePagina) return { data: filas, error: null };
  }
}
