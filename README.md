# AnyWeb MCP

**Websites & web services to MCP.** Antes llamado Web2API.

AnyWeb MCP convierte operaciones concretas de una web en herramientas que un asistente puede ejecutar mediante MCP (Model Context Protocol). Por ejemplo: consultar un producto por nombre, extraer una lista o descargar un documento.

La idea es enseñar una operación en el navegador, obtener una receta reproducible, comprobarla y empaquetarla como servidor MCP. El asistente recibe una herramienta con entradas definidas; el servidor ejecuta la receta contra el sitio original.

## Qué es hoy

Un prototipo funcional para desarrolladores, operado desde una CLI. La rama actual reemplaza la antigua aplicación web / Workflow Studio por este flujo:

```text
Declarar → Navegar y demostrar → Proponer recetas → Revisar → Empaquetar → Usar desde un cliente MCP
  init           explore             propose        review     package
```

- **Exploración:** Chromium persistente, navegación, clics, formularios, capturas y registro de peticiones; demostraciones marcadas con sus entradas.
- **Recetas:** reproducción de operaciones HTTP compatibles, extracción HTML y descargas. La compatibilidad depende del flujo observado.
- **Flujos de navegador aprendidos:** registra acciones, infiere parámetros con dos demostraciones y comprueba un caso reservado. Permite reutilizar lecturas calculadas por JavaScript como herramientas MCP. Véase [el recorrido y sus límites](docs/browser-workflows.md).
- **Sesiones:** inicio de sesión manual en un navegador visible y reutilización del estado guardado.
- **Revisión:** ejecución de las herramientas propuestas y aprobación antes de empaquetarlas.
- **Entrega:** un servidor Node.js por sitio, un fragmento `.mcp.json`, evidencia y un README. Los bundles HTTP no incluyen Playwright; las herramientas de navegador usan el runtime local y Chromium instalado.

## Ejemplo del resultado

En una tienda compatible, enseñas búsquedas con distintos nombres de producto. Una receta puede consultar el catálogo, identificar el producto y obtener su detalle. Después de revisarla, el asistente puede llamar una herramienta como `product_detail` con `{"product_name":"Laptop Air"}`.

En el modo HTTP, el navegador se utiliza durante la preparación y el MCP ejecuta peticiones directamente. Con `execution: browser`, la herramienta reproduce el programa aprendido en un contexto de Chromium nuevo y devuelve los datos extraídos del DOM; la evidencia identifica el transporte utilizado.

## Qué no está resuelto

- En el explorador y los motores genéricos se bloquean `POST` y los métodos de escritura hasta contar con una autorización humana verificable. Esto también impide consultas legítimas por POST. La confirmación por nonce no es una aprobación humana.
- Un GET no garantiza ausencia de efectos: revisa la operación antes de ejecutarla. Las anotaciones MCP son orientativas, no un límite de seguridad.
- Una URL por sí sola no garantiza un MCP útil: hacen falta demostraciones y verificación.
- El motor genérico tiene un alcance limitado de lecturas y descargas; no convierte automáticamente cualquier acción o protocolo.
- Servicios con protocolos particulares (WebSocket, estado del dispositivo) quedan fuera del motor y necesitan un conector propio, fuera de este repositorio.
- Los cambios del sitio y la caducidad de una sesión pueden exigir revisar las recetas o volver a iniciar sesión.

## Uso local

Requiere Node.js 24 y npm. El paquete **no está publicado en npm**: instálalo desde un checkout o desde un tarball que generes tú.

### Instalación desde un checkout

```bash
git clone <url> anyweb
cd anyweb
npm ci
```

### Instalación desde un tarball local

Genera el paquete en el checkout e instálalo en un directorio de trabajo aparte:

```bash
cd anyweb
npm pack --pack-destination ..   # imprime el nombre, p. ej. akimibks-anyweb-1.0.0.tgz
mkdir ../anyweb-work && cd ../anyweb-work
npm install ../akimibks-anyweb-1.0.0.tgz
```

- Usa `npm install`, no `npm ci`: el tarball no incluye `package-lock.json`.
- Incluye `src/`, `examples/`, `skills/anyweb/` y la documentación de método y navegador de `docs/`; no incluye `test/` ni `docs/plan/`. La suite completa solo se ejecuta desde el checkout.
- Fuera del checkout el comando es `npx --no-install anyweb` (o `node_modules/.bin/anyweb`). Los ejemplos siguientes usan `node src/cli.mjs`; usa esa forma si instalaste el tarball.

Chromium se descarga aparte, una vez por usuario. Es necesario para `explore`, para herramientas `execution: browser` y para la suite:

```bash
npx playwright install chromium
```

Comprueba la instalación:

```bash
node src/cli.mjs --help
```

### Recorrido: `init → explore → propose → review → package`

`init` va primero: sin declaración, `propose` responde `SITE_NOT_FOUND`; y `execution`/`extract` deben estar declarados antes de marcar para que las demostraciones registren el navegador.

**1. Declarar.** Importa una declaración del sitio y sus herramientas. El comando valida el archivo y preserva cualquier integración existente:

```bash
node src/cli.mjs init --file examples/product-lookup.json
```

El ejemplo es una declaración ilustrativa, no una integración certificada. El formato está definido en `draftSiteSchema` de [src/artifact/site.mjs](src/artifact/site.mjs); [test/e2e.test.mjs](test/e2e.test.mjs) prueba el recorrido completo desde `init`.

**2. Explorar y demostrar.**

```bash
node src/cli.mjs explore start --site https://www.demoblaze.com --start-url https://www.demoblaze.com --headed
```

Usa los subcomandos `explore` para navegar y `explore mark` para delimitar exactamente dos demostraciones `train` y una `eval` por herramienta, con entradas diferentes. Ejecuta `propose` mientras el daemon sigue activo: las demostraciones están en memoria. El [método curado](docs/method.md) explica cómo elegir la vía adecuada por servicio, definir la operación y reunir evidencia sin confundir una demo con una integración terminada.

**3. Compilar y revisar.** `review` ejecuta tráfico real y pide aprobación humana por herramienta. Un GET también puede tener efectos: revisa rutas y efecto antes de aprobar.

```bash
node src/cli.mjs propose --site https://www.demoblaze.com
node src/cli.mjs review --site https://www.demoblaze.com
```

`--yes` solo vale para el laboratorio local: no es una aprobación humana. Si el sitio requiere login, la persona lo hace en un navegador visible con `session login` (requiere TTY); no pases contraseñas, cookies ni códigos por argumentos.

**4. Empaquetar.**

```bash
node src/cli.mjs package --site https://www.demoblaze.com
```

El resultado de `package` indica las rutas del bundle y del fragmento de configuración para registrarlo en tu cliente MCP. Son pasos separados: la declaración y el inicio de exploración no crean por sí mismos las demostraciones.

### Nota para PowerShell

`--input '{"k":"v"}'` llega sin comillas al proceso. Usa el token de parada, que pasa el resto de la línea literal:

```powershell
node src/cli.mjs explore mark --site https://www.demoblaze.com --tool product_detail --role train --input --% "{\"product_name\":\"Laptop Air\"}"
```

## Conectar el MCP de fábrica

El MCP de fábrica permite a un agente declarar un sitio, explorarlo, registrar demostraciones y proponer herramientas. No inicia sesión por ti, no aprueba herramientas ni habilita escrituras. El agente nunca debe introducir contraseñas ni códigos en sus argumentos; el inicio de sesión se realiza manualmente.

Para un cliente compatible con configuración `mcpServers`, añade esta entrada a su configuración MCP y reemplaza la ruta por la ruta absoluta de tu copia instalada del proyecto:

```json
{
  "mcpServers": {
    "anyweb-factory": {
      "command": "node",
      "args": ["/ruta/absoluta/anyweb/src/cli.mjs", "mcp"]
    }
  }
}
```

En Windows utiliza una ruta como `C:/ruta/anyweb/src/cli.mjs`; si instalaste el tarball, `C:/ruta/anyweb-work/node_modules/@akimibks/anyweb/src/cli.mjs`. El cliente debe poder encontrar `node`; si no, usa también la ruta absoluta al ejecutable de Node. Consulta la documentación de tu cliente para la ubicación de su configuración y reinicia o recarga su lista de MCP. El comando `node src/cli.mjs mcp` usa **stdio**: lo inicia el cliente MCP, no una terminal interactiva.

Para Hermes, la CLI admite `hermes mcp add anyweb-factory --command node --args /ruta/absoluta/anyweb/src/cli.mjs mcp` (`--args` debe ir al final), y `hermes mcp test anyweb-factory` comprueba la conexión. La disponibilidad en una sesión abierta depende del cliente y puede requerir recargarla.

El MCP generado para un sitio se registra por separado usando el fragmento `.mcp.json` que devuelve `package`. El MCP de fábrica no registra ni aprueba el resultado automáticamente.

## Pruebas

```bash
npm test
```

La suite cubre el recorrido completo contra un sitio local de prueba, recetas HTTP y de navegador, HTML, descargas, sesiones, controles de exploración, empaquetado, reintentos y detección de captchas.

La suite vive en `test/` y no viaja en el tarball: para ejecutarla usa el checkout. Desde un tarball, la verificación disponible es `--help`, la sonda de `skills/anyweb/scripts/mcp-probe.mjs` y un laboratorio propio en loopback.

La prueba opcional contra Demoblaze se ejecuta por separado:

```bash
WEB2API_LIVE=1 npm run test:live
```

## Hallazgos de la revisión

La suite local cubre, entre otros, estos problemas de la revisión:

- **Captura POST:** petición y respuesta se guardan por separado; la reproducción de POST está bloqueada hasta contar con una política de autorización segura.
- **Cookies:** cada petición, incluidos los saltos de una redirección HTML, selecciona cookies por dominio, ruta, caducidad y atributo Secure. Las cabeceras de sesión proporcionadas manualmente se rechazan en recetas con varios orígenes porque no tienen metadatos de destino.
- **Redirecciones HTML:** el motor permite hasta tres saltos dentro del mismo origen y a rutas revisadas, sin credenciales incrustadas en la URL. Los códigos 301/302/303 convierten POST en GET sin reenviar el cuerpo; 307/308 lo conservan. Toda la cadena comparte un límite de 15 segundos y las respuestas descartadas se cancelan para liberar conexiones. JSON y descargas siguen rechazando redirecciones.
- **Evaluación:** la compilación usa solo las dos demostraciones `train`; el caso `eval` se reproduce después contra la receta resultante.

La suite incluye regresiones para captura separada, redacción de credenciales, filtrado de cookies, redirecciones e inicialización sin sobrescritura. Esto no certifica compatibilidad universal ni sustituye pruebas contra cada servicio. Quedan límites: las cabeceras manuales en un único origen se consideran explícitas y se conservan en sus redirecciones salvo las de cuerpo al pasar a GET; el transporte no incorpora cookies nuevas de `Set-Cookie`. No se ha validado el bloqueo de destinos de red privada ni la autenticación de todos los protocolos.

Las reglas de redirección siguen el [estándar Fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch); la liberación de respuestas sigue la [recomendación de Undici](https://github.com/nodejs/undici#garbage-collection). Las regresiones de transporte pueden ejecutarse con `node --test test/upstream.test.mjs test/transport-regression.test.mjs`.

## Cambio de nombre y compatibilidad

El producto se llama **AnyWeb MCP**, el paquete npm `@akimibks/anyweb` y el ejecutable principal `anyweb`. Se conserva `web2api` como alias. Puedes usar siempre `node src/cli.mjs` sin instalar el ejecutable globalmente.

Para conservar sesiones y configuraciones, permanecen las rutas `~/.web2api`, `~/Downloads/web2api` y las variables `WEB2API_*`. No se migran ni borran datos. Los servidores nuevos se registran como `anyweb-<sitio>`; si sustituyes un registro antiguo, reemplaza su entrada en tu cliente para evitar herramientas duplicadas. Los bundles ya generados conservan su nombre hasta que los regeneres.

El nombre expresa el objetivo del proyecto, no una garantía de compatibilidad universal. Este cambio local no renombra el repositorio remoto ni publica un paquete en npm.
