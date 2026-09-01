/**
 * Tipos de hoja de una pizarra multi-hoja (`whiteboard_pages.page_type`).
 *
 * Vive en su propio módulo —y no dentro de `MultiPageWhiteboard`— para que el
 * test que fija la invariante contra la migración no tenga que importar el
 * componente, que arrastra Excalidraw, Monaco y la consola v86. Es la
 * convención del repo para helpers puros testeables.
 *
 * INVARIANTE CROSS-FILE: esta lista tiene que coincidir EXACTO con la del
 * `CHECK (page_type IN (…))` de la tabla — la fija `page-types.test.ts`, que lee
 * la última migración que toca el constraint. Sin ese test la divergencia no
 * produce ningún error visible:
 *   - un tipo que el cliente ofrece y el CHECK no acepta rebota el INSERT con
 *     un 23514 recién al crear la hoja;
 *   - un tipo que la base acepta y el cliente no conoce cae en SILENCIO a la
 *     rama de dibujo del despacho por tipo (los ternarios tienen `else` final,
 *     así que TypeScript no avisa).
 *
 * Los valores van en INGLÉS porque los cinco originales lo son. El tipo de
 * PREGUNTA equivalente sí es `diagrama`, pero es otra tabla y otro enum.
 */
export const PAGE_TYPES = ["drawing", "text", "code", "console", "sql", "diagram"] as const;

export type PageType = (typeof PAGE_TYPES)[number];
