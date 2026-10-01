/**
 * «a, b y c» en el idioma de la interfaz, con `Intl.ListFormat`. Si el
 * navegador no lo trae (o el idioma no es válido), une a mano con «y»/«and».
 */
export function unirLista(partes: readonly string[], idioma: string): string {
  if (partes.length <= 1) return partes[0] ?? "";
  try {
    return new Intl.ListFormat(idioma, { style: "long", type: "conjunction" }).format(partes);
  } catch {
    const y = idioma.startsWith("en") ? " and " : " y ";
    return `${partes.slice(0, -1).join(", ")}${y}${partes[partes.length - 1]}`;
  }
}
