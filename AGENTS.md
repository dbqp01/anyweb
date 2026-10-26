# Contexto para agentes Frontier

> Copia este archivo como `AGENTS.md` en la raíz del repo **después de A0**.
> Claude Code lo lee como `CLAUDE.md`; Codex y OpenCode leen `AGENTS.md`.
> Si usas Claude Code: `cp AGENTS.md CLAUDE.md`.

## Qué es este repositorio

AnyWeb MCP convierte demostraciones de navegador en servidores MCP. El usuario demuestra una
operación dos veces (`train`), el sistema infiere parámetros, la comprueba con un tercer caso
reservado (`eval`) y empaqueta un servidor MCP que expone esa operación como tool.

Flujo: `explore → propose → review → package`.

## Mapa del código

| Ruta | Qué hace | Tocar con cuidado |
|---|---|---|
| `src/cli.mjs` | Punto de entrada; bins `anyweb` y `web2api` | Sí: cambios de flags rompen todo |
| `src/commands/*.mjs` | `init`, `explore`, `propose`, `review`, `package`, `session` | Sí |
| `src/artifact/recipe.mjs` | Inferencia de dependencias, `inferChecks`, códigos de rechazo | **Núcleo**: aquí vive el método |
| `src/artifact/browser.mjs` | Recetas con `execution: browser` | Sí |
| `src/explore/guard.mjs` | Intercepta rutas; bloquea métodos no seguros y URLs destructivas | **Invariante de seguridad** |
| `src/explore/marks.mjs` | Marcas `train`/`eval` de las demostraciones | **Invariante**: eval no infiere |
| `src/browser/runner.mjs` | Reproduce el programa en Chromium nuevo | Sí |
| `src/net/upstream.mjs`, `src/net/boundary.mjs` | Peticiones HTTP y límites | Sí |
| `src/mcp/server.mjs`, `src/mcp/entry.mjs` | Servidor MCP generado | Sí |
| `docs/method.md` | Método y criterios | Documento normativo |
| `docs/browser-workflows.md` | Recorrido del motor de navegador y límites | Documento normativo |
| `test/*.test.mjs` | 61 tests con `node --test` | No borrar ninguno |

## Comandos

```bash
npm ci                        # instalar
npm test                      # 61 tests, ~142 s
npm run test:live             # test contra sitio real (requiere red)
node src/cli.mjs --help
node --check src/cli.mjs      # sintaxis sin ejecutar
```

## Invariantes (violarlos invalida el PR)

1. Solo lecturas. **Nunca** POST/PUT/PATCH/DELETE contra el sitio.
2. GET solo a rutas y orígenes observados en `train` y declarados.
3. El caso `eval` **nunca** participa de la inferencia.
4. Nunca cambiar de motor (HTTP ↔ navegador) en silencio.
5. Credenciales fuera del bundle y fuera de los argumentos de tool.
6. Límites: 32 acciones, 128 rutas, 200 peticiones, 30 s por ejecución.
7. Ante la duda, **rechazar con código**, no devolver vacío.

## Convenciones de código

- ESM puro, sin `require`.
- Node 24; no usar APIs posteriores.
- Nombres de archivo en minúsculas; módulos por responsabilidad, no por capa.
- Errores con código (`UNPROVEN_PARAMETER`, etc.), no strings sueltos.
- Tests en `test/<área>.test.mjs`, con `node:test` y `node:assert/strict`.
- Sin dependencias nuevas sin justificarlo en el PR.

## Cómo reportar

Al terminar una tarea, responde exactamente con:

```
TAREA: <id>
CAMBIOS: <archivos>
COMANDOS: <lo que corriste y su salida real>
CRITERIO: <cómo demuestras cada punto del DoD>
RIESGOS: <qué puede romperse>
SIGUIENTE: <qué haría después, si acaso>
```

Si no puedes cumplir un criterio, dilo y detente. No lo maquilles.
