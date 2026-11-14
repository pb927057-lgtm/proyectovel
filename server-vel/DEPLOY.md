# VEL 0.1 — Despliegue del Servidor Relay WebSocket E2EE (`server-vel/relay-server.ts`)

## Por qué el Relay NO corre dentro de Netlify Functions

Netlify Functions son funciones HTTP efímeras (*stateless* y con tiempo máximo de ejecución por petición). Un canal WebSocket persistente para conectar **VEL CORE** y **VEL MÓVIL** en tiempo real requiere un proceso **Node.js persistente** capaz de mantener sockets `wss://` abiertos, validar desafíos criptográficos y enrutar paquetes cifrados al instante.

El Relay de VEL es **ciego y sin custodia**:
- Nunca almacena fotos, videos, notas, mensajes ni claves privadas.
- Autentica cada dispositivo verificando **Firebase ID Token** + **firma ECDSA P-256** del desafío emitido + estado y autorizaciones reales en **Cloud Firestore**.
- Si el destinatario está desconectado, descarta el sobre cifrado sin cola persistente y notifica `RECIPIENT_OFFLINE`.

---

## Opciones de alojamiento gratuitas / de bajo costo (Node.js + WebSocket WSS)

| Proveedor | Nivel gratuito / costo | Ventajas para VEL | Limitaciones a tener en cuenta |
|---|---|---|---|
| **Render (Web Service - Free Tier)** *(Recomendada para comenzar a costo cero)* | **Gratuito ($0)** | Soporta Node.js, `npm run relay:start`, TLS `wss://` automático, `/health` check y variables de entorno. | Entra en suspensión (*spin down*) tras 15 minutos sin conexiones WebSocket activas; la primera reconexión tras reposo tarda ~30–50 s. |
| **Koyeb (Free Web Service)** | **Gratuito ($0)** | TLS `wss://` nativo y despliegue directo de Node.js. | Límites mensuales de horas/RAM; puede dormir si hay inactividad prolongada según región. |
| **Fly.io (Pay-as-you-go con margen gratuito pequeño)** | Muy bajo costo / margen gratis limitado | Excelente estabilidad de sockets persistentes en regiones cercanas. | Requiere tarjeta para verificar cuenta; facturación si se excede el margen de máquina compartida. |
| **Railway (Trial / Hobby)** | Prueba inicial limitada (~USD 5 crédito) / luego USD 5/mes | Configuración inmediata con `npm run relay:start` y TLS `wss://`. | El saldo gratuito vence al agotarse o tras el período de prueba. |

---

## Variables de entorno requeridas

### A. En el servicio donde alojes el Relay (`server-vel/relay-server.ts`)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `FIREBASE_PROJECT_ID` | Sí | ID del proyecto Firebase (ej. `proyecto-vel`). |
| `FIREBASE_SERVICE_ACCOUNT` | Sí | JSON completo (o en Base64) de la cuenta de servicio de Firebase Admin SDK. Permite verificar ID Tokens y consultar/actualizar `dispositivos`, `vinculaciones` y `autorizaciones` en Firestore. |
| `RELAY_ALLOWED_ORIGINS` | Recomendada | Orígenes HTTPS permitidos separados por coma (ej. `https://proyecto-vel.netlify.app`). |
| `PORT` / `RELAY_PORT` | Automática / Opcional | Render/Railway inyectan `PORT` automáticamente; si no existe, usa `RELAY_PORT` o `8080`. |

- **Comando de instalación (Build):** `npm install`
- **Comando de arranque (Start):** `npm run relay:start`
- **Health Check path:** `/health` (responde JSON HTTP `200` con `status: "UP"` y `firebaseAdminConfigured`).

### B. En Netlify (Sitio web y PWA VEL)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `VEL_RELAY_WSS_URL` | Sí | URL pública segura con esquema `wss://` del Relay desplegado (producción actual: `wss://server-vel.onrender.com`, sin barra final). |
| `FIREBASE_SERVICE_ACCOUNT` | Sí | Requerida por las Netlify Functions (`/api/register-device`, `/api/device-session`, `/api/pairing-confirm`, `/api/revoke-device`). |
| `FIREBASE_PROJECT_ID` | Sí | `proyecto-vel`. |

> Nota: La PWA consulta `GET /api/relay-config` al iniciar y utiliza `wss://server-vel.onrender.com` como URL de producción incorporada en el paquete web si el endpoint dinámico no está configurado.

---

## Prueba real con dos teléfonos (Paso a paso)

1. Despliega `server-vel/relay-server.ts` en un proveedor Node.js con TLS (`wss://...`) y confirma que `https://server-vel.onrender.com/health` devuelva `{"status":"UP","firebaseAdminConfigured":true,...}`.
2. En Netlify (`Site configuration > Environment variables`), configura `VEL_RELAY_WSS_URL=wss://server-vel.onrender.com` y `FIREBASE_SERVICE_ACCOUNT` si usas Netlify Functions, y redespliega el sitio.
3. Verifica en Firebase Console que **Authentication > Sign-in method > Anonymous** esté habilitado para los identificadores técnicos de dispositivos.
4. **Teléfono 1 (VEL CORE):** Abre la web en Chrome, elige **CONFIGURAR VEL CORE** (puedes instalarla como PWA). Espera confirmación **"Registrado en Firebase"** y estado **"Relay autenticado"**.
5. **Teléfono 2 (VEL MÓVIL):** Abre la web en Chrome del segundo teléfono, elige **CONFIGURAR VEL MÓVIL**. Espera confirmación **"Registrado en Firebase"** y **"Relay autenticado"**.
6. En **Teléfono 1 (CORE)** ve a **VINCULAR** y pulsa **Generar código de emparejamiento**. Aparecerá un código temporal de 8 caracteres válido por 5 minutos.
7. En **Teléfono 2 (MÓVIL)** ingresa ese código y pulsa **Conectar con VEL CORE**.
8. Ambos teléfonos mostrarán un **código SAS de 6 dígitos** (`XXX XXX`). Verifica cara a cara que sea idéntico en ambos y pulsa **Confirmar SAS** tanto en **VEL CORE** como en **VEL MÓVIL**.
9. Verifica que ambos muestren estado **Vinculado E2EE (Par en línea)** y envía un mensaje desde el cuadro **Canal Cifrado E2EE** en cualquiera de los dos teléfonos; comprueba la transición real `Enviando...` -> `Enrutado (esperando confirmación)` -> `Recibido y confirmado ✓`.
10. Para probar revocación real: desde **VEL CORE** abre **ADMINISTRAR** o **EMERGENCIA Y REVOCACIÓN** y pulsa **Revocar autorización**. El **Teléfono 2 (MÓVIL)** debe desconectarse de inmediato con estado **"Dispositivo revocado"** y quedar bloqueado en intentos posteriores de reconexión.
