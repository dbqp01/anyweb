# Laboratorio autenticado (test/lab)

Objetivo: medir de forma objetiva lo que un MCP generado por AnyWeb hace contra un sitio con sesión, sin usar cuentas ni credenciales reales. El laboratorio separa tres cosas que un test de "HTTP 200" confunde: autenticación, lectura autorizada y escritura controlada. La respuesta del MCP nunca se usa como prueba de sí misma; el estado se contrasta con un oráculo independiente.

## Piezas

| Archivo | Qué hace |
|---|---|
| `test/lab/server.mjs` | Sitio HTTP en `127.0.0.1` con login ficticio, cookie de sesión, CSRF, lectura protegida, escritura validada y ledger JSONL append-only. |
| `test/authenticated-lab.test.mjs` | Contrato del fixture y flujo real `init → explore → propose → review → package → cliente MCP`. |

No hay dependencias nuevas. El flujo MCP usa el Chromium de Playwright que ya requiere `explore`.

## Ejecutar

```bash
node --test test/authenticated-lab.test.mjs
```

Dos tests; el segundo tarda decenas de segundos porque arranca Chromium, compila, empaqueta y conecta un cliente MCP real.

## Contrato del fixture

La cuenta es ficticia: `lab.user@example.invalid` y una contraseña aleatoria por ejecución (`startLab()` la devuelve; no se registra en logs ni en el repo). Todos los datos son inventados.

| Petición | Resultado esperado |
|---|---|
| `GET /login` | Formulario HTML; no requiere sesión. |
| `POST /login` (JSON o formulario) | Credenciales válidas: cookie `lab_sid` `HttpOnly; SameSite=Lax` y, en JSON, `{ user, csrf }`. Credenciales inválidas: `401`, sin cookie. |
| `GET /api/notes?tag=work` sin cookie o con cookie falsa | `401`; nunca datos vacíos que parezcan éxito. |
| `GET /api/notes?tag=work` con sesión | `200` con las notas de ese tag, ordenadas por id. |
| `POST /api/notes` sin sesión | `401` antes de mirar el cuerpo. |
| `POST /api/notes` sin `x-lab-csrf` o con token incorrecto | `403`; el estado no cambia. |
| `POST /api/notes` con campo no permitido, id/tag/texto inválido o JSON malformado | `400`; el estado no cambia. |
| `POST /api/notes` válido | `201`, una nota nueva y un evento `note.created` en el ledger. |
| Repetir el mismo `id` | `409`; no se duplica el evento ni la nota. |

`GET /app?tag=...` es la página que usa la demostración: carga `/api/notes?tag=...` con la cookie. Así el tráfico observado por `explore` es el mismo que reproducirá el MCP.

## Oráculo

El servidor escribe cada mutación en `ledger.jsonl` **antes** de aplicarla en memoria. `lab.oracle.notes(tag)` y `lab.oracle.events()` leen ese archivo directamente; no pasan por la API ni por el MCP. El test compara:

- la lectura del MCP con las notas reconstruidas del ledger;
- el evento `note.created` con la nota devuelta por la escritura;
- que una escritura rechazada o un duplicado no añadan eventos.

Límite honesto: el ledger lo escribe el mismo proceso que sirve el sitio. Detecta respuestas cacheadas, inventadas o desactualizadas, pero no un servidor que mienta coherentemente en la API y en el ledger. Para el laboratorio local es suficiente; no es un atestado externo ni sirve como evidencia de producción.

## Qué mide el test del MCP generado

1. Login ficticio por HTTP y estado de sesión guardado con `writeSession` del producto (el mismo formato que consume el MCP).
2. Dos demostraciones `train` (`work`, `home`) y una `eval` (`archive`) desde Chromium; `propose` compila solo con las de entrenamiento y verifica la reservada.
3. `review` ejecuta la receta autenticada y `package` genera el bundle.
4. El cliente MCP lista solo `notes_by_tag` y lo marca `readOnlyHint`.
5. Se crea una nota **después** de las demostraciones; la llamada MCP devuelve exactamente el estado del oráculo. Eso descarta que el resultado sea una repetición de la demo.
6. El bundle no contiene la contraseña, el token CSRF ni el id de sesión.
7. Con cookie falsa y sin archivo de sesión, el MCP devuelve `REAUTH_REQUIRED` y no inventa datos; el oráculo no cambia.
8. Un tag sin resultados devuelve `VERIFICATION_FAILED`, no una lista vacía presentada como éxito.
9. Una declaración con `effect: "write"` es rechazada por `init` (`INVALID_INPUT`, con `effect` en los issues): el producto actual no puede generar esa tool.

## Conexión faltante: escritura por MCP

El fixture sí tiene una escritura controlada y verificable, pero el MCP generado no puede exponerla. A fecha 2026-10-27, en el código de producción:

- `src/artifact/recipe.mjs` — `recipeSchema.effect` solo acepta `read | download`; `createRecipeRunner` rechaza cualquier paso que no sea `GET` (`UNSAFE_METHOD_UNSUPPORTED`); `readWorkflowOutput` fija `effect: 'read'`.
- `src/artifact/site.mjs` — `toolSchema.effect` y `draftSiteSchema` aceptan solo `read | download`.
- `src/explore/guard.mjs` — `SAFE_METHODS` es solo `GET` y `confirm()` lanza `HUMAN_APPROVAL_UNAVAILABLE`; no hay canal de aprobación humana verificable.
- `src/mcp/server.mjs` — solo registra tools de receta; `readOnlyHint` se deriva de `effect`, pero no existe `effect: write`, contrato de resultado de escritura ni gate de aprobación.

Por eso el test no simula una tool de escritura del MCP. Prueba la escritura en el fixture y deja el hueco medido: `write_tools=0` en el diagnóstico. El gap probe fallará cuando el producto cambie de efecto; en ese momento hay que ampliar este laboratorio, no relajar el test.

Cuando exista la frontera de escritura, el caso a añadir es: declarar `add_note`, demostrar la escritura en el lab, aprobar la operación concreta fuera del control del agente, invocarla desde el cliente MCP y comparar el estado del oráculo antes/después. Sin aprobación, debe fallar cerrado y no mutar el ledger. No usar esta receta contra un sitio real.

## Límites

- Solo loopback y HTTP; no hay TLS, rate limiting ni multi-usuario.
- No se ejecuta `anyweb session login` (es interactivo y exige TTY); el test crea el estado con `writeSession` después de un login HTTP real contra el fixture. Es una costura de test, no una prueba de esa UX.
- No se prueba expiración real del servidor: se simulan cookie falsa y ausencia de sesión.
- No se prueba UVCV ni ninguna cuenta real. No hay escrituras reales.
- El bundle se ejecuta desde el checkout; la instalación aislada se cubre en otro test.

## Resultado observado

Ejecutado en este workspace (Windows, Node 24.20.0), 2026-10-27:

```text
✔ lab fixture: fictional login, protected read, controlled write and independent oracle
✔ generated MCP: authenticated read matches the ledger oracle, fails closed, and exposes no write
ℹ measured: read_tools=1 write_tools=0 auth_denials=2 empty_checks=1 oracle=.../ledger.jsonl
ℹ tests 2, pass 2, fail 0
```

El tiempo y la ruta del ledger cambian por ejecución; los conteos son los que produce el test, no una estimación.
