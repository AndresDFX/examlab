/**
 * Configuración de las pruebas: de qué base y con qué cuenta. En el CI llega por las
 * variables de entorno (secretos del repo); en local, de `.env` (Supabase) y `.env.e2e`
 * (la cuenta de prueba). Los dos están ignorados por git.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Entorno {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  /** Donde supabase-js guarda la sesión en localStorage: `sb-<ref>-auth-token`. */
  claveSesion: string;
}

function leerArchivoEnv(ruta: string): Record<string, string> {
  const valores: Record<string, string> = {};
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m) continue;
    valores[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return valores;
}

export function cargarEntorno(): Entorno {
  const archivos = [".env", ".env.e2e"]
    .map((f) => resolve(process.cwd(), f))
    .filter((f) => existsSync(f))
    .map(leerArchivoEnv);
  const valor = (clave: string): string => {
    const v = process.env[clave] || archivos.reduce((acc, a) => a[clave] || acc, "");
    if (!v) {
      throw new Error(
        `[e2e] Falta ${clave}. En local va en .env.e2e (ignorado por git); en el CI, en los secretos del repo.`,
      );
    }
    return v;
  };
  const supabaseUrl = valor("VITE_SUPABASE_URL").replace(/\/$/, "");
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  return {
    supabaseUrl,
    anonKey: valor("VITE_SUPABASE_PUBLISHABLE_KEY"),
    email: valor("E2E_EMAIL"),
    password: valor("E2E_PASSWORD"),
    claveSesion: `sb-${ref}-auth-token`,
  };
}
