# Conectar el MCP generado a un cliente

`package` produce un fragmento, no una configuración completa. El fragmento tiene esta forma:

```json
{
  "mcpServers": {
    "anyweb-example": {
      "command": "C:/ruta/absoluta/a/node.exe",
      "args": ["C:/ruta/absoluta/a/dist/example.mjs"],
      "env": { "WEB2API_HOME": "C:/Users/tu-usuario/.web2api" }
    }
  }
}
```

El fragmento utiliza el ejecutable Node y el `WEB2API_HOME` usados al empaquetar, tanto
para HTTP como para navegador. Si los mueves, vuelve a generar y probar el fragmento.

Reglas:

- Combina la entrada en el mapa `mcpServers` existente; no reemplaces el archivo entero.
- Usa rutas **absolutas**; muchos clientes no expanden `~`.
- `command` debe ser el Node 24 que usaste para instalar. Si el cliente lanza otro Node, apunta a la
  ruta absoluta del ejecutable correcto.
- El nombre lo genera `package` como `anyweb-<name>`. Si conservas una entrada antigua `web2api-*`,
  elimínala para no duplicar tools.
- Reinicia el cliente (o abre una sesión nueva) después de cambiar la configuración.

## Claude Code (verificado con 2.1.302)

La CLI acepta un servidor stdio con esta forma:

```bash
claude mcp add --scope user anyweb-example -- node "C:/ruta/absoluta/a/dist/example.mjs"
```

Con un `WEB2API_HOME` no predeterminado:

```bash
claude mcp add --scope user anyweb-example -e WEB2API_HOME="C:/Users/tu-usuario/.web2api" -- node "C:/ruta/absoluta/a/dist/example.mjs"
```

Comprueba la sintaxis exacta de tu versión con `claude mcp add --help`. No copies una entrada de otro
cliente sin adaptar `command`, `args` y `env`.

## Otros clientes

Para clientes con configuración JSON (Claude Desktop y similares), añade la entrada a `mcpServers` en
el archivo que documente tu cliente y reinícialo. Para clientes que solo aceptan un comando, usa
`node` como comando y la ruta absoluta del bundle como único argumento. No inventes rutas de
configuración: consulta la documentación del cliente.

## Qué runtime tienes

| `runtime` | Qué incluye | Qué necesita |
|---|---|---|
| `standalone_http` | Bundle Node autocontenido, sin Playwright | Node 24; si la receta usa sesión, el archivo de sesión en el `WEB2API_HOME` correcto |
| `local_browser_runtime` | Bundle que incluye el servidor de navegador y carga Playwright de forma perezosa | Playwright y Chromium instalados y disponibles para el Node que ejecuta el bundle; no es un bundle HTTP standalone |

El bundle de navegador **no es un bundle HTTP standalone**: necesita Playwright y un Chromium
instalado (`npx playwright install chromium`). El README generado indica mantener disponibles la
instalación de AnyWeb y sus dependencias; si mueves el proyecto, vuelve a empaquetar y a probar. El
bundle HTTP es standalone (no requiere el checkout), pero sigue dependiendo de la sesión guardada si
la operación la necesita.

### Aviso sobre `WEB2API_HOME`

El fragmento incluye `WEB2API_HOME` para ambos runtimes. Si creas manualmente la entrada sin esa
variable, el bundle usará `~/.web2api` por defecto. No muevas el archivo de sesión entre homes sin
volver a probar.

## Verificación independiente

La sonda del repo lista tools y llama una:

```bash
node skills/anyweb/scripts/mcp-probe.mjs "C:/ruta/absoluta/a/dist/example.mjs"
node skills/anyweb/scripts/mcp-probe.mjs "C:/ruta/absoluta/a/dist/example.mjs" product_detail '{"product_name":"Laptop Air"}'
```

Esperado: JSON con `tools` (nombre, descripción, `inputSchema`) y, si pasas tool, `call.content`. Si
`call.isError` es `true`, la sonda sale con 1 y el error viene del servidor. La sonda usa
`@modelcontextprotocol/client`, incluido como dependencia del paquete. Si el bundle usa un `WEB2API_HOME` distinto, expórtalo
antes de ejecutar la sonda (`WEB2API_HOME=... node ...`).

Después de la sonda:

1. Llama la tool desde el cliente real, no solo desde la sonda.
2. Compara el resultado con una fuente independiente (la página, una consulta manual o un segundo
   sistema). Comprueba campos y significado, no solo que no haya error.
3. Prueba una entrada límite/no sensible (otro valor válido) y observa si el resultado cambia como
   debe.
4. Si es posible, prueba sesión ausente/caducada en el laboratorio; no fuerces un 401 en una cuenta
   real.
5. Registra rutas, fecha, runtime, hashes y límites.

## Problemas de conexión

| Síntoma | Causa probable | Acción |
|---|---|---|
| El cliente no muestra tools | Config no recargada, nombre duplicado o bundle inexistente | Revisa ruta absoluta, reinicia, elimina la entrada antigua |
| El servidor sale al arrancar | Node incorrecto, bundle movido, error de importación | Ejecuta la sonda y lee stderr; vuelve a empaquetar si moviste la instalación o el bundle |
| `REAUTH_REQUIRED` | Sesión ausente o caducada en el home que usa el servidor | La persona vuelve a `session login`; verifica `WEB2API_HOME` |
| `UPSTREAM_CHANGED` | El sitio cambió desde la demostración | Vuelve a explorar, `propose`, `review` y `package` |
| `UNREVIEWED_OPERATION` | Ruta no aprobada en la receta | Revisa el flujo; no edites `site.json` a mano |
| `UNSAFE_METHOD_UNSUPPORTED` | La receta intenta un método no-GET | No está soportado; no lo rodees |
| La tool no aparece tras `package` | No está `approved` y `verification.status: "passed"` | Ejecuta `review` con la persona y vuelve a empaquetar |
| Funcionaba y dejó de hacerlo | Sesión caducada, sitio cambiado o checkout movido | Diagnostica en ese orden; no reinstales a ciegas |

## Seguridad de la configuración

- No pongas cookies, tokens ni contraseñas en `env`, `args` ni en el chat. La autenticación vive en el
  archivo de sesión.
- No commitees configuraciones con rutas privadas ni secretos; si el cliente sincroniza configuración,
  trátala como datos personales.
- No expongas el servidor por red ni lo envuelvas en HTTP sin autenticación y aislamiento.
- Si el cliente registra prompts o resultados, pueden quedar datos de la cuenta en sus logs.
