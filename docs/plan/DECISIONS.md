# Registro de decisiones — AnyWeb

Una entrada por decisión que cambia el rumbo. Sin esto, en dos semanas no sabrás por qué el
código es así y el siguiente agente reinventará la decisión.

Formato: fecha · tarea · decisión · por qué · alternativa descartada · consecuencia.

---

## 2026-10-26 · A0 · Reescritura consolidada
- **Decisión:** la limpieza fue deliberada (nuevo enfoque, buena parte del código rehecha). Se consolida en la rama `c1/base`, commit `52626a8`; `forge-v1` queda intacta como histórico.
- **Qué contenía:** 103 archivos retirados (studio web, evidencia, conectores previos) y un árbol nuevo sin trackear: `src/{artifact,commands,explore,browser,connectors,mcp,net}`, `test/` (61 verdes), `docs/`, `examples/`, `experiments/`.
- **Por qué rama nueva:** el estado anterior se conserva y el nuevo enfoque tiene su propia línea de historia.
- **Consecuencia:** el árbol está limpio y verificado; se puede lanzar A1 sin riesgo de que el agente "arregle" archivos que ya no existen.

---

## 2026-10-26 · C1 · Alcance
- **Decisión:** C1 es "instalable y honesto", no "más features".
- **Por qué:** hoy `package` emite `runtime: local_browser_runtime` y `private: true`: el producto solo existe en esta máquina.
- **Alternativa descartada:** empezar por contratos (A3). Se descartó porque no se pueden demostrar en otra máquina sin A1.
- **Consecuencia:** el primer entregable visible es un `npm pack` que funciona, no una demo nueva.

---

<!-- Plantilla
## AAAA-MM-DD · <tarea> · <título>
- **Decisión:**
- **Por qué:**
- **Alternativa descartada:**
- **Consecuencia:**
-->
