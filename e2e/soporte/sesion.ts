/**
 * Una sola sesión por corrida: se inicia en la preparación global y la comparten todas
 * las pruebas. Iniciar una por prueba (o por proceso) multiplicaba los inicios de sesión
 * contra el límite de Supabase, y dos procesos refrescando el mismo token de refresco a
 * la vez hacen que Supabase revoque la sesión entera.
 *
 * El archivo va al directorio temporal y NO a `test-results/`: esa carpeta se sube como
 * artefacto del CI, y un repo público expone sus artefactos.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Entorno } from "./entorno";

export interface Sesion {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: { id: string; email?: string };
}

/**
 * Un archivo por corrida: la preparación global lo elige y lo deja en el entorno, que
 * heredan los procesos de las pruebas. Con un nombre fijo, dos corridas a la vez se
 * pisaban la sesión, y el cierre de una revocaba la de la otra.
 */
const VARIABLE = "E2E_ARCHIVO_SESION";

export function archivoSesion(): string {
  return process.env[VARIABLE] ?? join(tmpdir(), "examlab-e2e", "sesion.json");
}

export function elegirArchivoSesion(): void {
  process.env[VARIABLE] = join(tmpdir(), "examlab-e2e", `sesion-${process.pid}-${Date.now()}.json`);
}

export async function iniciarSesion(e: Entorno): Promise<Sesion> {
  const r = await fetch(`${e.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: e.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: e.email, password: e.password }),
  });
  const j = (await r.json().catch(() => ({}))) as Partial<Sesion> & {
    error_description?: string;
    msg?: string;
  };
  if (!r.ok || !j.access_token || !j.user?.id) {
    throw new Error(
      `[e2e] No se pudo iniciar sesión con E2E_EMAIL (HTTP ${r.status}: ${j.error_description ?? j.msg ?? "sin detalle"}).`,
    );
  }
  return {
    ...(j as Sesion),
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
  };
}

/** Revoca el token de refresco de ESTA sesión (no las demás de la cuenta). */
export async function cerrarSesion(e: Entorno, s: Sesion): Promise<void> {
  await fetch(`${e.supabaseUrl}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { apikey: e.anonKey, Authorization: `Bearer ${s.access_token}` },
  }).catch(() => undefined);
}

export function guardarSesion(s: Sesion): void {
  const archivo = archivoSesion();
  mkdirSync(dirname(archivo), { recursive: true });
  writeFileSync(archivo, JSON.stringify(s));
}

export function leerSesionGuardada(): Sesion {
  return JSON.parse(readFileSync(archivoSesion(), "utf8")) as Sesion;
}

export function borrarSesionGuardada(): void {
  rmSync(archivoSesion(), { force: true });
}
