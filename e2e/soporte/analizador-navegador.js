/* eslint-disable */
/**
 * Analizador de UI que corre DENTRO de la página. Lo inyecta `fixtures.ts` con
 * `addInitScript` y queda en `window.__qaUI`.
 *
 * JavaScript plano a propósito: `page.evaluate` serializa la función que recibe, y una
 * función transpilada desde TypeScript puede arrastrar ayudantes del módulo que en la
 * página no existen. Acá todo vive en un solo lugar y se comparte entre llamadas.
 *
 * Cada hallazgo lleva una FIRMA del componente —etiqueta, rol, clases y la zona de la
 * página— y nunca su texto: el texto sale de los datos (nombres de cursos, de personas),
 * y la línea base tiene que reconocer el mismo problema aunque los datos cambien.
 */
(() => {
  if (window.__qaUI) return;

  /** Clases que cambian con el estado, no con el componente: fuera de la firma. */
  const CLASES_DE_ESTADO =
    /^(hover:|focus|active:|group-|peer-|data-\[|aria-|disabled:|animate-|transition|duration-|ease-|delay-|motion-)/;

  const INTERACTIVOS = [
    "a[href]",
    "button",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="slider"]',
    '[role="combobox"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  const ZONAS =
    "header, nav, aside, main, footer, [role='dialog'], [role='menu'], [role='listbox'], table, form";

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function zona(el) {
    const z = el.parentElement && el.parentElement.closest(ZONAS);
    if (!z) return "body";
    return z.getAttribute("role") || z.tagName.toLowerCase();
  }

  function firma(el) {
    if (!el || !el.tagName) return "pagina";
    const tag = el.tagName.toLowerCase();
    const rol = el.getAttribute("role") || "";
    const clases = Array.from(el.classList)
      .filter((c) => !CLASES_DE_ESTADO.test(c))
      .sort()
      .join(" ");
    const z = zona(el);
    return `${z}>${tag}${rol ? `[${rol}]` : ""}#${hash(`${tag}|${rol}|${clases}|${z}`)}`;
  }

  function describir(el) {
    if (!el || !el.tagName) return "la página";
    const tag = el.tagName.toLowerCase();
    const rol = el.getAttribute("role");
    const texto = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return `<${tag}${rol ? ` role="${rol}"` : ""}>${texto ? ` «${texto}»` : ""}`;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  /** Lo que no es parte de la pantalla bajo prueba: decorativo, avisos pasajeros, marcado. */
  function ignorado(el) {
    return !!el.closest("[aria-hidden='true'], [data-sonner-toaster], [data-qa-ignorar]");
  }

  function interactivos(raiz) {
    return Array.from(raiz.querySelectorAll(INTERACTIVOS)).filter(
      (el) => visible(el) && !ignorado(el) && getComputedStyle(el).pointerEvents !== "none",
    );
  }

  const recorta = (ov) => ov !== "visible";

  /** La caja del elemento recortada por los ancestros que recortan o desplazan. */
  function rectoVisible(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    let p = getComputedStyle(el).position === "fixed" ? null : el.parentElement;
    for (; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (recorta(cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
      if (recorta(cs.overflowY)) {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
      }
      if (cs.position === "fixed") break;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function ancestroFijo(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position === "fixed") return p;
    }
    return null;
  }

  function seDesplaza(p) {
    const cs = getComputedStyle(p);
    return (cs.overflowY === "auto" || cs.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 1;
  }

  function hayDesplazamientoEntre(el, hasta) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (seDesplaza(p)) return true;
      if (p === hasta) break;
    }
    return false;
  }

  /** El elemento que conviene nombrar cuando algo tapa a otro: el interactivo o el posicionado. */
  function significativo(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p.matches(INTERACTIVOS)) return p;
      const pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky" || pos === "absolute") return p;
      if (p.getAttribute("role") === "dialog") return p;
    }
    return el;
  }

  function contenedorDeBloque(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const d = getComputedStyle(p).display;
      if (d !== "inline" && d !== "contents") return p;
    }
    return null;
  }

  function nodosDeTexto(raiz, cada) {
    const caminante = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let n = caminante.nextNode(); n; n = caminante.nextNode()) {
      const padre = n.parentElement;
      if (!padre || padre.closest("script, style, noscript, template, svg, option")) continue;
      if (ignorado(padre) || !visible(padre)) continue;
      cada(n, padre);
    }
  }

  function anchoUtil() {
    return document.documentElement.clientWidth;
  }

  // ── Revisiones ────────────────────────────────────────────────────────────

  function revisarScroll() {
    const de = document.documentElement;
    const ancho = de.clientWidth;
    const contenido = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    if (contenido - ancho <= 1) return [];
    // Culpable: el primer elemento de cada rama que se sale mientras su padre no.
    const culpables = [];
    const vistos = new Set();
    for (const el of document.body.querySelectorAll("*")) {
      if (!el.getBoundingClientRect || ignorado(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (rectoVisible(el).right <= ancho + 1) continue;
      const p = el.parentElement;
      if (p && p !== document.body && rectoVisible(p).right > ancho + 1) continue;
      const f = firma(el);
      if (vistos.has(f)) continue;
      vistos.add(f);
      culpables.push(el);
      if (culpables.length >= 5) break;
    }
    if (!culpables.length) {
      return [
        {
          regla: "scroll-horizontal",
          severidad: "bloquea",
          elemento: "pagina",
          detalle: `La página se desplaza en horizontal: mide ${contenido} px en una pantalla de ${ancho} px.`,
        },
      ];
    }
    return culpables.map((el) => ({
      regla: "scroll-horizontal",
      severidad: "bloquea",
      elemento: firma(el),
      detalle: `La página se desplaza en horizontal (${contenido} px en ${ancho} px) por ${describir(el)}, que llega hasta ${Math.round(rectoVisible(el).right)} px.`,
    }));
  }

  function revisarFuera(raiz) {
    const W = anchoUtil();
    const H = window.innerHeight;
    const out = [];
    const vistos = new Set();
    for (const el of interactivos(raiz)) {
      const vr = rectoVisible(el);
      // Recortado por completo por un ancestro: oculto a propósito (pestañas, carruseles).
      if (vr.width <= 0 || vr.height <= 0) continue;
      const fueraH = vr.right > W + 1 || vr.left < -1;
      const fijo = ancestroFijo(el);
      // Dentro de algo fijo (un diálogo, un panel) lo que queda fuera en vertical no se
      // alcanza desplazando la página: es el «botón de cerrar fuera de la pantalla».
      const fueraV = !!fijo && (vr.top < -1 || vr.bottom > H + 1) && !hayDesplazamientoEntre(el, fijo);
      if (!fueraH && !fueraV) continue;
      const f = firma(el);
      if (vistos.has(f)) continue;
      vistos.add(f);
      const cuanto = fueraH
        ? Math.round(Math.max(vr.right - W, -vr.left))
        : Math.round(Math.max(vr.bottom - H, -vr.top));
      out.push({
        regla: "fuera-de-pantalla",
        severidad: "bloquea",
        elemento: f,
        detalle: `${describir(el)} queda ${cuanto} px fuera de la pantalla.`,
      });
    }
    return out;
  }

  function revisarDesborde(raiz) {
    const out = [];
    const vistos = new Set();
    const rango = document.createRange();
    nodosDeTexto(raiz === document ? document.body : raiz, (n, padre) => {
      const caja = contenedorDeBloque(padre);
      if (!caja) return;
      rango.selectNodeContents(n);
      const rt = rango.getBoundingClientRect();
      if (rt.width < 1 || rt.height < 1) return;
      const rc = caja.getBoundingClientRect();
      const cs = getComputedStyle(caja);
      const tam = parseFloat(getComputedStyle(padre).fontSize) || 16;
      // El rectángulo del texto incluye el alto de la fuente, que puede pasar un poco del
      // interlineado: un margen proporcional a la letra evita falsos positivos.
      const tolY = Math.max(2, tam * 0.35);
      const sobraX = Math.max(rt.right - rc.right, rc.left - rt.left);
      const sobraY = Math.max(rt.bottom - rc.bottom, rc.top - rt.top);
      const desbordaX = sobraX > 2 && !recorta(cs.overflowX);
      const desbordaY = sobraY > tolY && !recorta(cs.overflowY);
      if (!desbordaX && !desbordaY) return;
      const f = firma(caja);
      if (vistos.has(f)) return;
      vistos.add(f);
      out.push({
        regla: "desborde-texto",
        severidad: "bloquea",
        elemento: f,
        detalle: `El texto «${n.nodeValue.trim().slice(0, 40)}» se sale ${Math.round(desbordaX ? sobraX : sobraY)} px de ${describir(caja)}.`,
      });
    });
    return out;
  }

  /** Una barra que no se mueve con el contenido: fija o pegajosa. */
  function esBarra(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  }

  /**
   * `momento`: "inicio" con la página arriba, "final" con todo desplazado hasta abajo.
   *
   * Lo que pasa por debajo de una barra fija NO es un problema mientras se pueda
   * desplazar para sacarlo de ahí. Por eso, arriba solo cuentan las barras de la mitad
   * superior (la cabecera tapando lo primero, que ya no se puede bajar más) y, al final,
   * las de la mitad inferior (el botón flotante o la barra de pestañas tapando lo último).
   * Sin esa distinción, el buscador que a 320 px queda justo detrás de la barra de
   * pestañas salía como tapado, y según cuánto tardaran las tarjetas de arriba en cargar.
   */
  function revisarSuperposicion(raiz, momento) {
    const W = anchoUtil();
    const H = window.innerHeight;
    const out = [];
    const vistos = new Set();
    for (const el of interactivos(raiz)) {
      const vr = rectoVisible(el);
      const izq = Math.max(vr.left, 0);
      const der = Math.min(vr.right, W);
      const arr = Math.max(vr.top, 0);
      const aba = Math.min(vr.bottom, H);
      if (der - izq < 2 || aba - arr < 2) continue;
      const x = (izq + der) / 2;
      const y = (arr + aba) / 2;
      if (momento === "final" && y < H / 2) continue;
      const encima = document.elementFromPoint(x, y);
      if (!encima || el === encima || el.contains(encima) || encima.contains(el)) continue;
      if (ignorado(encima)) continue;
      // Un label que envuelve al control lo activa: no lo tapa.
      const label = encima.closest("label");
      if (label && label.contains(el)) continue;
      const tapa = significativo(encima);
      if (momento !== "final" && y > H / 2 && esBarra(tapa)) continue;
      const clave = `${firma(el)}|${firma(tapa)}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.push({
        regla: "superposicion",
        severidad: "bloquea",
        elemento: firma(el),
        otro: firma(tapa),
        detalle: `${describir(el)} queda tapado por ${describir(tapa)}.`,
      });
    }
    return out;
  }

  /** Un enlace dentro de un párrafo: WCAG lo exceptúa del tamaño mínimo. */
  function esEnlaceEnTexto(el) {
    if (el.tagName !== "A") return false;
    if (getComputedStyle(el).display !== "inline") return false;
    const p = el.parentElement;
    if (!p) return false;
    return (p.textContent || "").trim().length > (el.textContent || "").trim().length + 3;
  }

  /**
   * El área que responde al dedo, no la caja que se ve. La casilla del sistema de diseño
   * se ve de 16 px y amplía su área a 44 con un `::after` absoluto (`after:-inset-3.5`):
   * medir solo la caja la daba por chica en todas las listas con selección.
   */
  function areaEfectiva(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    // Un pseudo-elemento absoluto se ubica respecto del borde de RELLENO de su elemento,
    // no del borde de la caja: con el borde de la caja, una casilla de 16 px con 1 px de
    // borde y `-inset-3.5` medía 44 cuando el navegador le da 42.
    const propio = getComputedStyle(el);
    const borde = (v) => parseFloat(v) || 0;
    const relleno = {
      left: r.left + borde(propio.borderLeftWidth),
      top: r.top + borde(propio.borderTopWidth),
      right: r.right - borde(propio.borderRightWidth),
      bottom: r.bottom - borde(propio.borderBottomWidth),
    };
    for (const pseudo of ["::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (!cs.content || cs.content === "none" || cs.position !== "absolute") continue;
      if (cs.pointerEvents === "none" || cs.display === "none") continue;
      const lado = (v) => (v.endsWith("px") ? parseFloat(v) : NaN);
      const [t, d, b, i] = [lado(cs.top), lado(cs.right), lado(cs.bottom), lado(cs.left)];
      if ([t, d, b, i].some(Number.isNaN)) continue;
      left = Math.min(left, relleno.left + i);
      top = Math.min(top, relleno.top + t);
      right = Math.max(right, relleno.right - d);
      bottom = Math.max(bottom, relleno.bottom - b);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /** Distancia de un punto al rectángulo (0 si el punto cae adentro). */
  function distanciaARect(x, y, r) {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.hypot(dx, dy);
  }

  /**
   * La excepción por ESPACIADO de WCAG 2.5.8: un objetivo chico cumple si un círculo de
   * `minimo` px de diámetro centrado en él no toca ningún otro objetivo ni el círculo de
   * otro objetivo chico. Es lo que deja pasar un enlace aislado como «Política de
   * privacidad» —chico pero imposible de errar— y sigue frenando dos íconos pegados.
   */
  function cumpleEspaciado(m, medidas, minimo) {
    const radio = minimo / 2;
    const cx = (m.r.left + m.r.right) / 2;
    const cy = (m.r.top + m.r.bottom) / 2;
    for (const o of medidas) {
      if (o === m || o.el.contains(m.el) || m.el.contains(o.el)) continue;
      if (distanciaARect(cx, cy, o.r) < radio) return false;
      if (o.chico) {
        const ox = (o.r.left + o.r.right) / 2;
        const oy = (o.r.top + o.r.bottom) / 2;
        if (Math.hypot(cx - ox, cy - oy) < minimo) return false;
      }
    }
    return true;
  }

  /**
   * `umbral.espaciado` aplica la excepción de WCAG (solo en escritorio: con el dedo se
   * pidió 44×44 sin excepciones). Un objetivo que la cumple no frena, pero queda como
   * aviso: sigue siendo chico.
   */
  function revisarAreas(raiz, umbral) {
    const medidas = interactivos(raiz)
      .filter((el) => !el.matches(":disabled, [aria-disabled='true']") && !esEnlaceEnTexto(el))
      .map((el) => {
        const r = areaEfectiva(el);
        // Medio píxel de tolerancia: con densidad 3 un botón de 44 px mide 43,999996.
        const lado = Math.min(r.width, r.height) + 0.5;
        return { el, r, lado, chico: lado < umbral.bloquea };
      });
    // Un hallazgo por componente, y el más grave: si una de sus instancias cumple el
    // espaciado y otra no, el componente frena.
    const porFirma = new Map();
    for (const m of medidas) {
      let severidad = null;
      let minimo = 0;
      if (m.chico) {
        severidad = "bloquea";
        minimo = umbral.bloquea;
        if (umbral.espaciado && cumpleEspaciado(m, medidas, umbral.bloquea)) {
          severidad = "aviso";
        }
      } else if (umbral.avisa && m.lado < umbral.avisa) {
        severidad = "aviso";
        minimo = umbral.avisa;
      }
      if (!severidad) continue;
      const f = firma(m.el);
      const previo = porFirma.get(f);
      if (previo && (previo.severidad === "bloquea" || severidad === "aviso")) continue;
      const espaciado = m.chico && severidad === "aviso" ? ", con espacio libre alrededor" : "";
      porFirma.set(f, {
        regla: "area-tactil",
        severidad,
        elemento: f,
        detalle: `${describir(m.el)} mide ${Math.round(m.r.width)}×${Math.round(m.r.height)} px (mínimo ${minimo}×${minimo}${espaciado}).`,
      });
    }
    return [...porFirma.values()];
  }

  function revisarLetra(raiz, umbral) {
    const out = [];
    const vistos = new Set();
    let total = 0;
    let chicas = 0;
    nodosDeTexto(raiz === document ? document.body : raiz, (n, padre) => {
      const tam = parseFloat(getComputedStyle(padre).fontSize) || 16;
      const caracteres = n.nodeValue.trim().length;
      total += caracteres;
      if (tam < umbral.comoda) chicas += caracteres;
      if (tam >= umbral.minima - 0.01) return;
      const f = firma(padre);
      if (vistos.has(f)) return;
      vistos.add(f);
      out.push({
        regla: "letra-pequena",
        severidad: "bloquea",
        elemento: f,
        detalle: `«${n.nodeValue.trim().slice(0, 40)}» usa letra de ${tam} px (mínimo ${umbral.minima}).`,
      });
    });
    if (total > 0 && chicas / total > umbral.proporcion) {
      out.push({
        regla: "letra-mayoria-pequena",
        severidad: "aviso",
        elemento: "pagina",
        detalle: `El ${Math.round((100 * chicas) / total)} % del texto visible usa letra menor a ${umbral.comoda} px.`,
      });
    }
    return out;
  }

  /** Por qué no se ve el botón de menú: para que el hallazgo se explique solo. */
  function diagnosticoMenu(etiqueta) {
    const candidatos = Array.from(document.querySelectorAll("button[aria-label]")).filter(
      (b) => b.getAttribute("aria-label") === etiqueta,
    );
    const dialogos = Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']"))
      .filter(visible)
      .map((d) => describir(d));
    const partes = [];
    if (!candidatos.length) partes.push(`no existe en la página; ruta ${location.pathname}`);
    for (const b of candidatos.slice(0, 2)) {
      const r = b.getBoundingClientRect();
      const header = b.closest("header");
      partes.push(
        `${Math.round(r.width)}×${Math.round(r.height)} px, encabezado ${header ? getComputedStyle(header).display : "ausente"}, inerte ${!!b.closest("[inert]")}, oculto a lectores ${!!b.closest("[aria-hidden='true']")}`,
      );
    }
    if (dialogos.length) partes.push(`diálogo abierto: ${dialogos.join(" / ")}`);
    return partes.join("; ");
  }

  function revisarMenu(ancho, etiqueta) {
    const boton = Array.from(document.querySelectorAll("button[aria-label]")).find(
      (b) => b.getAttribute("aria-label") === etiqueta && visible(b),
    );
    const lateral = Array.from(document.querySelectorAll("aside")).find(visible);
    const out = [];
    if (ancho < 768) {
      if (!boton) {
        out.push({
          regla: "menu-movil",
          severidad: "bloquea",
          elemento: "menu",
          detalle: `Por debajo de 768 px no aparece el botón de menú (${diagnosticoMenu(etiqueta)}).`,
        });
      }
      if (lateral) {
        out.push({
          regla: "menu-movil",
          severidad: "bloquea",
          elemento: "lateral",
          detalle: "Por debajo de 768 px el menú lateral sigue a la vista.",
        });
      }
    } else {
      if (!lateral) {
        out.push({
          regla: "menu-movil",
          severidad: "bloquea",
          elemento: "lateral",
          detalle: "Desde 768 px el menú lateral debería verse.",
        });
      }
      if (boton) {
        out.push({
          regla: "menu-movil",
          severidad: "bloquea",
          elemento: "menu",
          detalle: "Desde 768 px el botón de menú del teléfono sigue a la vista.",
        });
      }
    }
    return out;
  }

  function analizar(opciones) {
    const raiz = opciones.dentroDe ? document.querySelector(opciones.dentroDe) : document;
    if (!raiz) return [];
    const r = [];
    for (const que of opciones.revisar) {
      if (que === "scroll") r.push(...revisarScroll());
      if (que === "fuera") r.push(...revisarFuera(raiz));
      if (que === "desborde") r.push(...revisarDesborde(raiz));
      if (que === "superposicion") r.push(...revisarSuperposicion(raiz, opciones.momento || "inicio"));
      if (que === "areas") r.push(...revisarAreas(raiz, opciones.areas));
      if (que === "letra") r.push(...revisarLetra(raiz, opciones.letra));
    }
    return r;
  }

  // ── Desplazamiento ────────────────────────────────────────────────────────

  /** Todo lo que se desplaza en vertical: la página y los contenedores con scroll propio. */
  function desplazables() {
    const lista = [document.scrollingElement || document.documentElement];
    for (const el of document.body.querySelectorAll("*")) {
      if (seDesplaza(el) && visible(el)) lista.push(el);
    }
    return lista;
  }

  function irAlFinal() {
    for (const el of desplazables()) el.scrollTop = el.scrollHeight;
  }

  function irAlInicio() {
    for (const el of desplazables()) el.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  // ── Teclado ───────────────────────────────────────────────────────────────

  /** El recorrido con Tab arranca en el contenido, no en los 20 enlaces del menú. */
  function enfocarInicio() {
    const main = document.querySelector("main");
    if (main) {
      // Queda con tabindex mientras dura la prueba: quitárselo con el foco adentro hace
      // que el navegador lo suelte y el recorrido vuelva a empezar por el menú.
      main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
    } else if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  }

  let siguienteId = 1;

  function estiloDeFoco(el) {
    const cs = getComputedStyle(el);
    return [
      cs.outlineStyle,
      cs.outlineWidth,
      cs.outlineColor,
      cs.boxShadow,
      cs.backgroundColor,
      cs.borderTopColor,
      cs.borderBottomColor,
      cs.textDecorationLine,
      cs.color,
    ].join("|");
  }

  function analizarFoco() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (!el.dataset.qaFoco) el.dataset.qaFoco = String(siguienteId++);
    const r = el.getBoundingClientRect();
    const enPantalla =
      visible(el) && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < anchoUtil();
    const cs = getComputedStyle(el);
    const contorno = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const conFoco = estiloDeFoco(el);
    // Sin transiciones (las apaga `fixtures.ts`), el estilo sin foco se lee al instante.
    el.blur();
    const sinFoco = estiloDeFoco(el);
    el.focus({ preventScroll: true, focusVisible: true });
    let tapadoPor = null;
    if (enPantalla) {
      const vr = rectoVisible(el);
      const x = (Math.max(vr.left, 0) + Math.min(vr.right, anchoUtil())) / 2;
      const y = (Math.max(vr.top, 0) + Math.min(vr.bottom, window.innerHeight)) / 2;
      const encima = document.elementFromPoint(x, y);
      if (encima && encima !== el && !el.contains(encima) && !encima.contains(el) && !ignorado(encima)) {
        tapadoPor = significativo(encima);
      }
    }
    return {
      id: el.dataset.qaFoco,
      firma: firma(el),
      describe: describir(el),
      enPantalla,
      indicador: contorno || conFoco !== sinFoco,
      tapadoPor: tapadoPor ? { firma: firma(tapadoPor), describe: describir(tapadoPor) } : null,
    };
  }

  /**
   * Cuántas paradas de Tab hay. Se pide solo para confirmar una trampa (con UNA sola
   * parada, Tab vuelve siempre a la misma y no es una trampa): contarlas en cada paso
   * recorría la página entera 25 veces, y en el libro de notas de Safari eso agotaba los
   * 120 s de la prueba.
   */
  function contarTabulables() {
    return interactivos(document).filter((x) => x.tabIndex >= 0).length;
  }

  // ── Mouse ─────────────────────────────────────────────────────────────────

  /** Marca un elemento por componente (no 20 filas iguales) para pasarles el mouse. */
  function marcarMuestras(max) {
    const raiz = document.querySelector("main") || document.body;
    const vistos = new Set();
    const muestras = [];
    for (const el of interactivos(raiz)) {
      if (muestras.length >= max) break;
      if (el.matches(":disabled, [aria-disabled='true'], input, textarea, select")) continue;
      const f = firma(el);
      if (vistos.has(f)) continue;
      vistos.add(f);
      el.setAttribute("data-qa-muestra", String(muestras.length));
      muestras.push({ i: muestras.length, firma: f, describe: describir(el) });
    }
    return muestras;
  }

  function estiloVisual(el) {
    const cs = getComputedStyle(el);
    return {
      estilo: [
        cs.backgroundColor,
        cs.color,
        cs.borderTopColor,
        cs.boxShadow,
        cs.textDecorationLine,
        cs.opacity,
        cs.outlineStyle,
        cs.transform,
        cs.filter,
      ].join("|"),
      cursor: cs.cursor,
    };
  }

  // ── Teclado virtual ───────────────────────────────────────────────────────

  function campoConTeclado(el) {
    el.scrollIntoView({ block: "center" });
    const vr = rectoVisible(el);
    const H = window.innerHeight;
    const W = anchoUtil();
    if (vr.bottom <= 0 || vr.top >= H || vr.width <= 0 || vr.height <= 0) {
      return { firma: firma(el), describe: describir(el), visible: false, tapadoPor: null };
    }
    const x = (Math.max(vr.left, 0) + Math.min(vr.right, W)) / 2;
    const y = (Math.max(vr.top, 0) + Math.min(vr.bottom, H)) / 2;
    const encima = document.elementFromPoint(x, y);
    const tapa =
      encima && encima !== el && !el.contains(encima) && !encima.contains(el) && !ignorado(encima)
        ? significativo(encima)
        : null;
    return {
      firma: firma(el),
      describe: describir(el),
      visible: true,
      tapadoPor: tapa ? { firma: firma(tapa), describe: describir(tapa) } : null,
    };
  }

  window.__qaUI = {
    analizar,
    revisarMenu,
    diagnosticoMenu,
    irAlFinal,
    irAlInicio,
    enfocarInicio,
    analizarFoco,
    contarTabulables,
    marcarMuestras,
    estiloVisual,
    campoConTeclado,
    firma,
    describir,
  };
})();
