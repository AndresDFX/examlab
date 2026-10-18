/**
 * Las pruebas corren contra el backend REAL de la institución de demostración, así que
 * todo lo que ESCRIBE se intercepta antes de salir: ninguna prueba crea, cambia ni borra
 * datos, y lo que se bloqueó queda registrado en el reporte de cada prueba.
 */
import type { Page } from "@playwright/test";

export interface RegistroDeRed {
  bloqueadas: string[];
  rpcPermitidas: Set<string>;
  /** Bloqueadas sin ser escrituras conocidas: quizá son lecturas que faltan en la lista. */
  rpcSinClasificar: Set<string>;
}

export function nuevoRegistro(): RegistroDeRed {
  return { bloqueadas: [], rpcPermitidas: new Set(), rpcSinClasificar: new Set() };
}

/**
 * RPC: lista BLANCA de lecturas. Solo salen las que se sabe que solo leen; todas las demás
 * se bloquean. Las RPC van por POST, así que el método no dice si leen o escriben, y el
 * nombre tampoco: una lista negra por verbo dejaba pasar 20 que escriben con nombres que no
 * la tocaban (`resign_report`, `vote_poll_option`, `request_dispatch_scheduled_messages`…)
 * y bloqueaba lecturas que sí la tocaban (`poll_public_info`, `kahoot_my_live_games`).
 *
 * Cada una se verificó contra su última definición SQL (sin INSERT, UPDATE ni DELETE). Son
 * las que llaman las pantallas del recorrido al cargar. Una pantalla que empiece a llamar
 * otra la ve bloqueada y la prueba lo anota («rpc sin clasificar»): si solo lee, se agrega
 * acá; mientras tanto esa pantalla se mide sin ese dato, pero nunca se escribe.
 */
const RPC_QUE_LEEN = new Set([
  "count_ai_errors_per_project",
  "count_ai_errors_per_workshop",
  "count_unanswered_conversations",
  "get_report_to_sign",
  "grupos_estudiante_resumen",
  "kahoot_course_leaderboard",
  "kahoot_my_live_games",
  "list_active_tenants_public",
  "my_tenant_billing",
  "poll_public_info",
  "senales_nota_relativa",
  "tenant_user_counts",
  "verify_certificate",
]);

/**
 * Escrituras conocidas, por el verbo del nombre: se bloquean igual, pero sin aviso. Solo
 * decide si un bloqueo merece revisión, no qué sale.
 */
const RPC_QUE_ESCRIBEN =
  /^(log_|mark_|set_|update_|insert_|delete_|clear_|upsert_|save_|submit_|record_|register_|create_|crear_|grupo_estudiante_(crear|agregar|salir)|student_|teacher_|kahoot_|poll_|open_|close_|issue_|revoke_|trash_|clone_|complete_|requeue_|cancel_|reset_|sign_|resign_|firmar_|enroll|notify_|enqueue_|encolar_|admin_|hard_delete|soft_delete|restore_|marcar_|guardar_|registrar_|cerrar_|abrir_|publicar_|calificar_|request_|vote_|change_|toggle_|activate_|claim_|acknowledge_|reject_|add_|generate_|purge_|exam_repartir|report_(set|add)_)/;

/** Leer un archivo privado pide una URL firmada por POST, y listar una carpeta también. */
const STORAGE_QUE_LEE = /\/storage\/v1\/object\/(sign|list)\//;

const LECTURA = new Set(["GET", "HEAD", "OPTIONS"]);

export async function protegerEscrituras(page: Page, registro: RegistroDeRed): Promise<void> {
  await page.route(/\/rest\/v1\//, async (route) => {
    const req = route.request();
    if (LECTURA.has(req.method())) return route.continue();
    const ruta = new URL(req.url()).pathname;
    const rpc = /\/rest\/v1\/rpc\/([^/?]+)/.exec(ruta)?.[1];
    if (rpc && RPC_QUE_LEEN.has(rpc)) {
      registro.rpcPermitidas.add(rpc);
      return route.continue();
    }
    if (rpc && !RPC_QUE_ESCRIBEN.test(rpc)) registro.rpcSinClasificar.add(rpc);
    registro.bloqueadas.push(`${req.method()} ${ruta}`);
    return route.fulfill({ status: 204, body: "" });
  });

  // Funciones del servidor (IA, correo, importaciones): ninguna pantalla las necesita para
  // dibujarse, y casi todas cambian algo.
  await page.route(/\/functions\/v1\//, async (route) => {
    const req = route.request();
    registro.bloqueadas.push(`${req.method()} ${new URL(req.url()).pathname}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.route(/\/storage\/v1\/object\//, async (route) => {
    const req = route.request();
    if (LECTURA.has(req.method()) || STORAGE_QUE_LEE.test(req.url())) return route.continue();
    registro.bloqueadas.push(`${req.method()} ${new URL(req.url()).pathname}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // La sesión la comparte toda la corrida: ninguna pantalla puede cerrarla.
  await page.route(/\/auth\/v1\/logout/, (route) => route.fulfill({ status: 204, body: "" }));
}
