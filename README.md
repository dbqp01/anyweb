# AnyWeb MCP

**Websites & web services to MCP.** Antes llamado Web2API.

AnyWeb MCP convierte operaciones concretas de una web en herramientas que un asistente puede ejecutar mediante MCP (Model Context Protocol). Por ejemplo: consultar un producto por nombre, extraer una lista o descargar un documento.

La idea es enseñar una operación en el navegador, obtener una receta reproducible, comprobarla y empaquetarla como servidor MCP. El asistente recibe una herramienta con entradas definidas; el servidor ejecuta la receta contra el sitio original.

## Qué es hoy

Un prototipo funcional para desarrolladores, operado desde una CLI. La rama actual reemplaza la antigua aplicación web / Workflow Studio por este flujo:

```text
Navegar y demostrar → Proponer recetas → Revisar → Empaquetar → Usar desde un cliente MCP
      explore             propose        review     package
```

- **Exploración:** Chromium persistente, navegación, clics, formularios, capturas y registro de peticiones; demostraciones marcadas con sus entradas.
- **Recetas:** reproducción de operaciones HTTP compatibles, extracción HTML y descargas. La compatibilidad depende del flujo observado.
- **Flujos de navegador aprendidos:** registra acciones, infiere parámetros con dos demostraciones y comprueba un caso reservado. Permite reutilizar lecturas calculadas por JavaScript como herramientas MCP. Véase [el recorrido y sus límites](docs/browser-workflows.md).
- **Sesiones:** inicio de sesión manual en un navegador visible y reutilización del estado guardado.
- **Revisión:** ejecución de las herramientas propuestas y aprobación antes de empaquetarlas.
- **Entrega:** un servidor Node.js por sitio, un fragmento `.mcp.json`, evidencia y un README. Los bundles HTTP no incluyen Playwright; las herramientas de navegador usan el runtime local y Chromium instalado.
- **WhatsApp:** conector específico de solo lectura para consultar conversaciones y mensajes de una cuenta vinculada. Véase [su documentación](docs/whatsapp.md).
- **Temu:** conector local de solo lectura para buscar productos y leer precios personalizados con una sesión iniciada. Véase [su documentación](docs/temu.md).

## Ejemplo del resultado

En una tienda compatible, enseñas búsquedas con distintos nombres de producto. Una receta puede consultar el catálogo, identificar el producto y obtener su detalle. Después de revisarla, el asistente puede llamar una herramienta como `product_detail` con `{"product_name":"Laptop Air"}`.

En el modo HTTP, el navegador se utiliza durante la preparación y el MCP ejecuta peticiones directamente. Con `execution: browser`, la herramienta reproduce el programa aprendido en un contexto de Chromium nuevo y devuelve los datos extraídos del DOM; la evidencia identifica el transporte utilizado.

## Qué no está resuelto

- Una URL por sí sola no garantiza un MCP útil: hacen falta demostraciones y verificación.
- El motor genérico tiene un alcance limitado de lecturas y descargas; no convierte automáticamente cualquier acción o protocolo.
- Servicios con protocolos particulares pueden requerir un conector dedicado, como WhatsApp.
- La interfaz web anterior ya no forma parte del código fuente actual. Los directorios antiguos `dist/` y `artifacts/` no acreditan el estado de esta versión.
- Los cambios del sitio y la caducidad de una sesión pueden exigir revisar las recetas o volver a iniciar sesión.

## Uso local

Requiere Node.js 24 y dependencias instaladas:

```bash
npm ci
```

Para explorar sitios, instala Chromium:

```bash
npx playwright install chromium
```

Consulta los comandos y opciones:

```bash
node src/cli.mjs --help
```

Ejemplo de inicio de exploración:

```bash
node src/cli.mjs explore start --site https://www.demoblaze.com --start-url https://www.demoblaze.com --headed
```

Antes de explorar, importa una declaración del sitio y sus herramientas. El comando valida el archivo y preserva cualquier integración existente:

```bash
node src/cli.mjs init --file examples/product-lookup.json
```

El ejemplo es una declaración ilustrativa, no una integración certificada. El formato está definido en `draftSiteSchema` de [src/artifact/site.mjs](src/artifact/site.mjs); [test/e2e.test.mjs](test/e2e.test.mjs) prueba el recorrido completo desde `init`.

El [método curado](docs/method.md) explica cómo elegir la vía adecuada por servicio, definir la operación y reunir evidencia sin confundir una demo con una integración terminada.

Usa los subcomandos `explore` para navegar y `explore mark` para delimitar exactamente dos demostraciones `train` y una `eval` por herramienta, con entradas diferentes. Ejecuta `propose` mientras el daemon sigue activo: las demostraciones están en memoria. Después de reunirlas, ejecuta:

```bash
node src/cli.mjs propose --site https://www.demoblaze.com
```

```bash
node src/cli.mjs review --site https://www.demoblaze.com
```

```bash
node src/cli.mjs package --site https://www.demoblaze.com
```

El resultado de `package` indica las rutas del bundle y del fragmento de configuración para registrarlo en tu cliente MCP. Son pasos separados: el ejemplo de inicio no crea por sí mismo las demostraciones.

## Pruebas

```bash
npm test
```

La suite cubre el recorrido completo contra un sitio local de prueba, recetas HTTP y de navegador, HTML, descargas, sesiones, controles de exploración, empaquetado y el conector WhatsApp sin vincular una cuenta real.

La prueba opcional contra Demoblaze se ejecuta por separado:

```bash
WEB2API_LIVE=1 npm run test:live
```

## Hallazgos de la revisión

La suite local cubre, entre otros, estos problemas de la revisión:

- **Captura POST:** petición y respuesta se guardan por separado. La compilación acepta cuerpos JSON de parámetros escalares y rechaza codificaciones no soportadas.
- **Cookies:** cada petición, incluidos los saltos de una redirección HTML, selecciona cookies por dominio, ruta, caducidad y atributo Secure. Las cabeceras de sesión proporcionadas manualmente se rechazan en recetas con varios orígenes porque no tienen metadatos de destino.
- **Redirecciones HTML:** se permiten hasta tres saltos dentro del mismo origen, sin credenciales incrustadas en la URL. Los códigos 301/302/303 convierten POST en GET sin reenviar el cuerpo; 307/308 lo conservan. Toda la cadena comparte un límite de 15 segundos y las respuestas descartadas se cancelan para liberar conexiones. JSON y descargas siguen rechazando redirecciones.
- **Evaluación:** la compilación usa solo las dos demostraciones `train`; el caso `eval` se reproduce después contra la receta resultante.

La suite incluye regresiones para captura separada, redacción de credenciales, filtrado de cookies, redirecciones e inicialización sin sobrescritura. Esto no certifica compatibilidad universal ni sustituye pruebas contra cada servicio. Quedan límites: las cabeceras manuales en un único origen se consideran explícitas y se conservan en sus redirecciones salvo las de cuerpo al pasar a GET; el transporte no incorpora cookies nuevas de `Set-Cookie`. No se ha validado el bloqueo de destinos de red privada ni la autenticación de todos los protocolos.

Las reglas de redirección siguen el [estándar Fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch); la liberación de respuestas sigue la [recomendación de Undici](https://github.com/nodejs/undici#garbage-collection). Las regresiones de transporte pueden ejecutarse con `node --test test/upstream.test.mjs test/transport-regression.test.mjs`.

## Cambio de nombre y compatibilidad

El producto se llama **AnyWeb MCP**, el paquete local `anyweb-mcp` y el ejecutable principal `anyweb`. Se conserva `web2api` como alias. Puedes usar siempre `node src/cli.mjs` sin instalar el ejecutable globalmente.

Para conservar sesiones y configuraciones, permanecen las rutas `~/.web2api`, `~/Downloads/web2api` y las variables `WEB2API_*`. No se migran ni borran datos. Los servidores nuevos se registran como `anyweb-<sitio>` y `anyweb-whatsapp`; si sustituyes un registro antiguo, reemplaza su entrada en tu cliente para evitar herramientas duplicadas. Los bundles ya generados conservan su nombre hasta que los regeneres.

El nombre expresa el objetivo del proyecto, no una garantía de compatibilidad universal. Este cambio local no renombra el repositorio remoto ni publica un paquete en npm.
