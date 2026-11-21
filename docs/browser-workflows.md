# Aprender y reutilizar flujos de navegador

AnyWeb puede convertir demostraciones realizadas con `explore` en una receta de navegador parametrizada y exponerla mediante MCP. Sirve para lecturas cuyo resultado depende de JavaScript o del estado de la página y no se obtiene reproduciendo las peticiones HTTP observadas.

## Recorrido

```text
Declaración con execution: browser + extracción DOM
  → dos demostraciones train y una eval mediante explore
  → inferencia de acciones y parámetros usando solo train
  → reproducción de los tres casos en navegadores nuevos
  → comparación con los resultados DOM capturados
  → review con una entrada elegida por el usuario
  → package y llamada MCP
```

El resultado es un programa declarativo, sin código JavaScript generado ni un agente que vuelva a decidir cada clic. El motor HTTP sigue siendo el predeterminado; no existe cambio automático de motor cuando una ejecución falla.

## Preparación

Requiere Node 24, `npm ci` y `npx playwright install chromium`. No se añadió otra dependencia de navegador.

Usa [el ejemplo de declaración](../examples/browser-product-lookup.json) como plantilla. Su dominio y selectores son ilustrativos: sustituye el origen y la extracción por los del sitio autorizado. Si ya existe una declaración para ese origen, edita su herramienta para añadir `"execution": "browser"` y `extract`; `init` preserva los archivos existentes.

```bash
node src/cli.mjs init --file examples/browser-product-lookup.json
node src/cli.mjs explore start --site https://example.com --start-url https://example.com --headed
```

Delimita una demostración y empieza siempre por `explore open`, para que la receta pueda reproducirse desde un contexto nuevo:

```bash
node src/cli.mjs explore mark --site https://example.com --tool browser_detail --role train --input '{"product_name":"Laptop Pro"}'
node src/cli.mjs explore open --site https://example.com --url https://example.com
```

Usa `explore type`, `click` y `press` con los refs del snapshot actual. Al terminar, ejecuta `explore mark end --site https://example.com`. Repite con otra entrada `train` y una tercera `eval`, manteniendo la misma secuencia funcional. Los clics manuales en la ventana no se registran como acciones del programa: utiliza los comandos de exploración.

```bash
node src/cli.mjs propose --site https://example.com
node src/cli.mjs explore stop --site https://example.com
node src/cli.mjs review --site https://example.com
node src/cli.mjs package --site https://example.com
```

Las demostraciones viven en el daemon: ejecuta `propose` antes de detenerlo. `review` muestra las acciones aprendidas y las rutas de red que se aprobarían. Después de `package`, registra el fragmento `.mcp.json` indicado por el comando.

## Qué aprende y comprueba

- Navegaciones a URLs constantes; escritura de texto; clics por ID, test ID, etiqueta o nombre accesible; teclas acotadas.
- Si el texto escrito o el nombre del elemento pulsado cambia exactamente con una entrada entre ambas demostraciones, lo convierte en un parámetro. Rechaza diferencias ambiguas, transformaciones no representadas y secuencias inconsistentes.
- Cada entrada debe participar en una acción y aparecer en algún campo del resultado. Los campos presentes y no vacíos en ambos ejemplos pasan a ser obligatorios.
- `propose` compara exactamente la salida de cada reproducción con el DOM capturado en esa demostración. El caso `eval` no se usa para aprender acciones, parámetros ni permisos de red.
- La política de red del navegador fija las claves de consulta observadas en `train`: cada valor es literal o está vinculado a una entrada. La revisión muestra estas reglas y el motor rechaza parámetros adicionales, duplicados o valores distintos antes de enviar la petición.
- En ejecución comprueba relación entre entradas y salida, campos requeridos y selectores no ambiguos. Esto detecta ciertas roturas; no demuestra por sí solo que un precio o una fecha sigan siendo correctos. Los sitios con valores variables pueden necesitar un contrato de evaluación distinto y actualmente fallar en la comparación exacta.

## Alcance y límites

Esta versión admite lecturas con peticiones GET a las rutas y orígenes observados en entrenamiento y declarados en el sitio. GET no demuestra que un endpoint carezca de efectos: hay que revisar su significado antes de aprobarlo. No se admiten POST, escrituras, descargas, redirecciones, WebSocket, service workers, ventanas nuevas ni diálogos. Las peticiones no revisadas abortan el flujo. Las redirecciones se rechazan antes de que Chromium las siga.

Las políticas de navegador antiguas sin reglas de consulta solo permiten peticiones sin parámetros; vuelve a proponer y revisar la herramienta si los necesita. Parámetros aleatorios o variables que no coincidan con una entrada declarada (por ejemplo, algunos identificadores de caché) no son compatibles con esta inferencia.

Las sesiones se cargan desde el estado guardado localmente con `session login`; cada invocación crea y cierra un contexto nuevo. No se aceptan cabeceras de sesión manuales en este motor ni se enseñan contraseñas mediante acciones de escritura. El estado generado durante una invocación no se persiste. Las aplicaciones dependientes de IndexedDB o perfiles especiales pueden requerir un conector dedicado.

Límites: 32 acciones, 128 rutas revisadas, 200 peticiones y 30 segundos por ejecución después de lanzar Chromium. La creación del navegador tiene su propio timeout de 15 segundos. Si Chromium no arranca, se cae o el sitio responde 429 o 5xx, la ejecución se repite una vez; un captcha o una página de WAF devuelve `CHALLENGE_REQUIRED` sin reintentar. No hay reparación de selectores ni búsqueda autónoma de la tarea.

`package` devuelve `runtime: local_browser_runtime`. Genera un bundle MCP con una instantánea de la receta, pero Playwright permanece externo y se resuelve desde la instalación que lo generó; Chromium se instala aparte. Mover o borrar esa instalación puede romper el bundle de navegador. Los sitios exclusivamente HTTP conservan `runtime: standalone_http`.

## Lo que enseña un conector escrito a mano

El conector de Temu (ahora en Obsession, `packages/temu-anyweb/mcp/`) resolvió a mano cuatro
problemas que este motor todavía no resuelve de forma general. Son la referencia para las próximas
capacidades. No están implementadas aquí.

| Problema | Cómo lo resolvió el conector | Qué hace hoy el motor |
|---|---|---|
| Sitios que bloquean navegadores automatizados al iniciar sesión | La persona inicia sesión en su Chrome normal, sin automatización, con un perfil aislado (`--user-data-dir`). Las llamadas reutilizan ese perfil en modo headless con `launchPersistentContext` y `channel: 'chrome'`. Así pasan las comprobaciones antibot y se conserva IndexedDB. | `session login` abre Chromium controlado por Playwright, y cada llamada carga un `storageState` en un Chromium nuevo. |
| Coste de lanzar el navegador en cada llamada | Mantiene un solo contexto vivo entre llamadas y las pone en cola, una a la vez. Solo la primera llamada paga el arranque. | Cada invocación lanza y cierra Chromium, de 1 a 3 s por llamada. |
| Resultados con markup cambiante | No usa selectores fijos. Toma cada enlace de producto y sube hasta el ancestro que tiene imagen y precio. Saca el título de `aria-label`, `title` o `alt`, y ordena por cuántos términos de la consulta contiene (mínimo 60 %). | La extracción depende de los selectores aprendidos en las demostraciones. |
| Sesión caducada a mitad de uso | Reconoce el login por la URL o por el encabezado, cierra el contexto y devuelve `LOGIN_REQUIRED` sin reintentar. | Responde `REAUTH_REQUIRED` ante 401/403 o una redirección a login, y `CHALLENGE_REQUIRED` ante un captcha. |

Las dos primeras filas son las que más rinden en un motor general: un perfil real de Chrome como
tipo de sesión, y un runner que mantiene el contexto abierto mientras el MCP vive.

## Evidencia reproducible

```bash
node --test test/browser.test.mjs test/browser-e2e.test.mjs
npm test
```

La prueba integral usa una página local cuyo catálogo y ficha se calculan en JavaScript, sin endpoints de búsqueda/detalle. Enseña dos productos, evalúa un tercero y consulta un cuarto desde un cliente MCP. También comprueba que no se empaqueten herramientas pendientes de revisión. Las pruebas negativas cubren evaluación incorrecta, entrada inválida, campo desaparecido, sesión ausente y bloqueo de escrituras, rutas no revisadas y redirecciones. Es evidencia local, no una certificación de compatibilidad con sitios externos.

Referencias de implementación: [routing y service workers de Playwright](https://playwright.dev/docs/api/class-browsercontext#browser-context-route), [control de redirecciones en Route.fetch](https://playwright.dev/docs/api/class-route#route-fetch).
