# Módulo 11 — Cuenta, Notificaciones y Cierre de Sesión

- **Duración objetivo:** 80–95 s
- **Ruta:** footer del sidebar (no hay ruta dedicada)
- **Precondiciones:** sesión Admin de *Demo Global Corp*; si la cuenta es
  multi-rol, mejor para ilustrar el selector de rol.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 0 — Contexto · 0:00–0:06
- **VISUAL:** `ZOOM-IN(footer del sidebar, 140%)`. `LOWER-THIRD`:
  **“Módulo 11 · Cuenta y Sesión”**.
- **VOZ:** «Para cerrar la serie, recorremos la zona de cuenta del Administrador,
  al pie del menú lateral.»

### Escena 1 — Tu cuenta, notificaciones y mensajes · 0:06–0:38
- **VISUAL:**
  1. `CURSOR→([data-tour-id="user-info"])`, `HIGHLIGHT` — nombre e identidad del
     Administrador.
  2. `CURSOR→([data-tour-id="notifications-bell"])`, `CLICK`. `ZOOM-IN` al popover
     de notificaciones (badge de no leídas).
  3. `CURSOR→([data-tour-id="messages-bell"])`, `CLICK`. `ZOOM-IN` a la
     mensajería interna.
- **VOZ:** «Aquí está la identidad del usuario dentro de la plataforma. La campana
  de notificaciones reúne los avisos del sistema y de los usuarios de la
  institución. Mensajes ofrece comunicación interna uno a uno y difusiones a un
  curso. Todo el contacto ocurre dentro de *Demo Global Corp*.»

### Escena 2 — Más opciones y selector de rol (RBAC) · 0:38–1:08
- **VISUAL:**
  1. `CURSOR→([data-tour-id="more-options"])`, `CLICK`. `ZOOM-IN` al menú:
     editar perfil, cambiar contraseña, preferencias, tema claro/oscuro, idioma,
     **ver tour guiado**.
  2. `CURSOR→([data-tour-id="role-switcher"])`, `HIGHLIGHT`. Si la cuenta es
     multi-rol, abrir el selector y mostrar el cambio de rol (sin completarlo o
     completándolo y regresando a Admin).
- **VOZ:** «Desde *Más opciones* se edita el perfil, se cambia la contraseña y las
  preferencias de tema e idioma. Y el selector de rol materializa el control de
  acceso: si el usuario tiene varios roles, al cambiarlo, el menú lateral y los
  permisos se reconfiguran para reflejar exactamente lo que ese rol puede hacer.»
- **BEAT RBAC (voz):** énfasis en «el menú lateral y los permisos se reconfiguran
  según el rol activo».

### Escena 3 — Cierre de sesión · 1:08–1:28
- **VISUAL:**
  1. `CURSOR→([data-tour-id="logout"])`, `HIGHLIGHT`, `CLICK`. Transición a la
     pantalla de login.
  2. `ZOOM-IN` al selector de institución vacío de nuevo (estado inicial).
- **VOZ:** «Al cerrar sesión, el contexto de la institución se limpia por completo
  y volvemos a la pantalla de acceso, donde de nuevo hay que elegir institución
  para entrar. Así se cierra el ciclo: acceso segmentado por institución y
  permisos definidos por rol, de principio a fin.»

### Escena 4 — Cierre de la serie · 1:28–1:35
- **VISUAL:** Carátula final con el logo de ExamLab. `LOWER-THIRD`:
  **“Fin de la serie · Rol Administrador”**. Fade out.
- **VOZ:** «Con esto concluye la demostración del rol Administrador en ExamLab.»
