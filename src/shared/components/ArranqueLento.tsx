/**
 * Lo que se ve cuando el arranque de la app NO termina.
 *
 * ── El caso, reproducido en un navegador real ─────────────────────────
 * Con la base degradada, PostgREST no rechaza: se QUEDA COLGADO y responde un
 * 504 decenas de segundos después (o nunca). El arranque espera la sesión y
 * luego el perfil y los roles, y como una promesa colgada nunca rechaza, el
 * `.catch` que ya existe —puesto para el caso de un token corrupto— no se
 * dispara. Medido: un usuario CON sesión se queda en «Cargando…» a los 5, a
 * los 11 y a los 21 segundos, sin un mensaje ni una salida. Eso es lo que la
 * gente reporta como «la página no está disponible»: Cloudflare sirve el sitio
 * en 200 y el service worker lo tiene en caché, pero la app nunca arranca.
 *
 * ── Por qué NO se deja entrar «sin datos» al vencer el plazo ──────────
 * La tentación es apagar `loading` y renderizar igual. Sería peor: sin roles
 * cargados el control de acceso manda al usuario a «no autorizado», que es un
 * mensaje FALSO y encima lo saca de donde estaba. Así que la app sigue sin
 * montarse; lo que cambia es lo que se ve, que pasa de un puntito suspensivo a
 * decir qué está pasando y ofrecer reintentar.
 */
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

/** Cuánto se espera antes de admitir que algo va mal.
 *
 *  8 s: por encima de cualquier arranque normal —el sondeo de esta misma app
 *  mide ~600 ms por consulta— y por debajo de lo que alguien aguanta mirando
 *  una pantalla quieta sin recargar a mano. */
export const MS_PARA_ADMITIR_QUE_NO_CARGA = 8000;

export function ArranqueLento() {
  const { t } = useTranslation();
  const [tardando, setTardando] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setTardando(true), MS_PARA_ADMITIR_QUE_NO_CARGA);
    return () => clearTimeout(id);
  }, []);

  if (!tardando) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center p-4 sm:p-8">
      <div className="max-w-sm text-center space-y-3">
        {/* `text-warning-on-subtle` y no `text-warning` a secas: ese último se lee
            en tema oscuro pero queda flojo en claro — el repo ya lo documenta en
            el aviso de reconciliación de «Identificar desde texto». */}
        <AlertTriangle className="h-8 w-8 mx-auto text-warning-on-subtle" />
        <p className="font-medium">{t("arranque.noCargaTitulo")}</p>
        <p className="text-sm text-muted-foreground">{t("arranque.noCargaCuerpo")}</p>
        {/* Recargar y no un reintento en caliente: el arranque ya quedó a mitad
            de camino (puede haber sesión sin perfil), y volver a empezar desde
            cero es lo único que deja un estado consistente. */}
        <Button onClick={() => window.location.reload()}>{t("arranque.reintentar")}</Button>
      </div>
    </div>
  );
}
