# Plan de desarrollo — AnyWeb (Frente A)

**Objetivo:** convertir `anyweb` de prototipo local en una herramienta que otra persona pueda
instalar y usar sin tu máquina, y que falle de forma explícita cuando el sitio cambia.

**Ejecutor:** agentes Frontier (Claude Code / Codex / OpenCode) en ciclos de una semana.
**Rol humano:** planificar, conversar, verificar y cerrar. No escribir código de producción.

---

## 1. Estado real del repo (verificado 2026-10-26)

| Dato | Valor |
|---|---|
| Ruta local | checkout local del repositorio |
| Remoto | `https://github.com/dbqp01/web2api.git` |
| Rama | `c1/base` (base del ciclo; `forge-v1` queda como histórico) |
| Código propio | 4.874 líneas en `src/` (33 módulos) |
| Tests | 61 pasan, 0 fallan (`npm test`) |
| Node | `>=24 <25`, ESM |
| Dependencias | commander, zod, hono, MCP SDK 2.3.1, cheerio, execa, playwright (dev) |
| CI | **ninguno** |
| Publicación | `"private": true` — **no se puede instalar con npm** |
| Estado del árbol | **limpio** — reescritura consolidada en `52626a8` |

**Consecuencia:** hoy AnyWeb solo funciona desde el checkout. `package` emite
`runtime: local_browser_runtime`: si mueves o borras la carpeta, el MCP generado muere.
No hay versión, no hay CI, no hay instalación. Eso es C1.

---

## 2. Invariantes que ningún agente puede romper

Están en `docs/method.md` y `docs/browser-workflows.md`. Si un agente las viola, se rechaza el PR:

1. **Solo lecturas.** Nada de POST, PUT, PATCH, DELETE. Nada de escrituras en el sitio.
2. **GET únicamente**, y solo a rutas y orígenes observados en entrenamiento y declarados.
3. **El caso `eval` nunca participa de la inferencia** de parámetros, acciones ni permisos de red.
4. **Nunca cambiar de motor en silencio** (HTTP ↔ navegador) ante un fallo.
5. **Credenciales fuera del bundle.** Nunca como argumento de conversación.
6. **Límites duros:** 32 acciones, 128 rutas revisadas, 200 peticiones, 30 s por ejecución.
7. **Rechazo explícito antes que éxito dudoso:** `UNPROVEN_PARAMETER`, `AMBIGUOUS_DEPENDENCY`,
   `UNPROVEN_SEARCH_COMPLETENESS`, `RESPONSE_SHAPE_UNSTABLE`, `UPSTREAM_CHANGED`.
8. **Verificación semántica, no solo HTTP 200.**

---

## 3. Los tres ciclos

### C1 — "Instalable y honesto" (2 semanas)

| ID | Tarea | Entregable | Criterio de aceptación |
|---|---|---|---|
| **A0** | Sanear el árbol | Reescritura consolidada en `c1/base` (commit `52626a8`) | ✅ `git status` limpio; 61 tests pasan |
| **A1** | Empaquetado portable | `npm pack` instalable; `files`, `engines`, `bin`, versión | En un directorio temporal limpio: `npm i -g <tarball>` → `anyweb --version`; `package` genera un MCP que arranca sin depender del checkout |
| **A2** | Preflight «no puedo» | `src/net/preflight.mjs` + negativa estructurada | 20 páginas saboteadas: ≥18 negativas correctas; el baseline (sin preflight) fabrica en ≥10 |
| **A3** | Contratos v0 | `contract` en la declaración + `anyweb verify` | 5 sitios reales: cambio de precio pasa; selector roto falla; sesión caída se detecta |
| **A4** | Corpus de 30 sitios | `corpus/` + `anyweb bench` + informe | 30 sitios × 2 corridas; tasa de compilación y supervivencia a 7 días en `REPORT.md` |
| **A5** | CI mínimo | `.github/workflows/test.yml` | Node 24, `npm ci`, `npm test` en cada push; badge en README |

**Definición de terminado de C1:** una persona que no eres tú ejecuta cinco comandos del README
en una máquina limpia y obtiene un MCP funcionando contra un sitio de prueba.

### C2 — "Sobrevive al cambio" (1-2 semanas)

| ID | Tarea | Criterio |
|---|---|---|
| B1 | Reparación de selectores por similitud estructural | Dado un selector muerto, propone ≤3 candidatos y verifica contra el contrato |
| B2 | `health://tools` + historial | Estado por tool en vivo; clasifica 5 tipos de fallo |
| B3 | Taxonomía de rechazos documentada | Cada código con ejemplo, causa y acción sugerida |

### C3 — "Alcance" (1-2 semanas)

| ID | Tarea | Criterio |
|---|---|---|
| C1 | Extensión MV3 de captura | Demostración grabada desde el navegador, sin CLI |
| C2 | Leaderboard público | Página estática generada por `anyweb bench`, con fecha y método |
| C3 | Publicación npm + versionado | `npx anyweb` funciona; changelog y semver |

---

## 4. Orden de ejecución y por qué

```
A0 ──► A1 ──► A2 ──► A3 ──► A4 ──► A5
             └──────► (A2 y A3 pueden ir en paralelo tras A1)
```

- **A0 primero** porque un agente sobre un árbol con 103 borrados va a "arreglar" cosas que ya no existen.
- **A1 antes que A3** porque los contratos solo se pueden demostrar en otra máquina si el paquete es portable.
- **A2 antes que A3** porque sin negativa estructurada, un contrato que falla se confunde con "cero resultados".
- **A4 al final de C1** porque el corpus es también el banco de pruebas de A2 y A3.

---

## 5. Riesgos y mitigación

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| El agente "arregla" los borrados de A0 sin entenderlos | Alta | A0 es decisión humana: restaurar o commitear, nunca mezclar |
| A1 descubre que el runtime depende de rutas absolutas | Alta | Prueba obligatoria en directorio temporal; si falla, se diseña el `runtime` portable antes de seguir |
| A2 da falsos positivos y bloquea sitios legítimos | Media | Umbral calibrado con 20 páginas etiquetadas; modo `--warn` por defecto |
| A3 se rompe con precios que cambian | Media | Contratos por tipo/rango/invariante, nunca igualdad exacta |
| A4 se vuelve un scraper de 30 sitios con ToS dudoso | Media | Solo sitios públicos, sin login, con rate limit y sin redistribuir HTML |
| El agente se sale del alcance | Alta | Un task por sesión + invariantes en `AGENTS.md` + revisión humana antes de commit |

---

## 6. Qué NO entra en C1

- POST y escrituras (fuera de alcance por diseño).
- WhatsApp y conectores específicos (ya existen, no se tocan).
- Interfaz web. Solo CLI, MCP y un `REPORT.md`.
- Extension de navegador (C3).
- Multi-tenant, nube, cuentas.

---

## 7. Cómo se mide el éxito de C1

1. `npx anyweb --version` en una máquina sin el repo.
2. Un MCP generado arranca y responde en un cliente distinto al que lo generó.
3. El informe de 30 sitios existe, tiene fecha y se puede reproducir con un comando.
4. 20 páginas saboteadas: la herramienta se niega; el baseline inventa.
5. `git log` cuenta la historia: un commit por tarea, con el criterio de aceptación en el cuerpo.
