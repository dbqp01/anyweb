# Validación puntual: lectura autenticada genérica

Fecha: 2026-10-28, zona horaria America/Lima. Estado: **lectura real verificada con inyección de sesión en memoria**; no es una validación de instalación ni del flujo de captura de sesión del producto.

## Método

- Se usó la sesión activa y autorizada del navegador real en `https://uvcv.edu.pe/`. No se modificaron tareas, cuentas ni mensajes.
- Se leyeron dos páginas de tareas con GET y se compiló una receta genérica HTTP a partir de esas observaciones. La entrada variable era el identificador de la tarea y la extracción era HTML declarativa; no se escribió un conector específico de Moodle.
- Se llamó una tercera tarea, no usada en el entrenamiento, mediante un cliente MCP y el servidor MCP genérico conectados en memoria. Para esta prueba, la cookie del origen se inyectó directamente en el runner; no se persistió ni se incluyó en el bundle ni en esta evidencia.
- El navegador obtuvo por separado la página de esa tercera tarea. Se compararon la identidad, el texto de estado y el texto de fecha que devolvió el MCP con el DOM leído en el navegador. No se publican identificadores, valores de sesión, nombres de cursos ni resultados personales.
- La transferencia en memoria entre el navegador y el proceso local de prueba usó una sola petición a `127.0.0.1`, con ruta aleatoria de un uso; el proceso finalizó después. El cuerpo de la petición no se registró.

## Salida real resumida

```json
{"mcpListedTool":true,"mcpCallSucceeded":true,"unseenInputMatches":true,"statusMatchesBrowser":true,"dateTextMatchesBrowser":true,"resultHasStatus":true,"resultHasDates":true,"credentialsPersisted":false}
```

## Alcance y límites

Esto comprueba una lectura autenticada concreta y un caso nuevo con la implementación local. No comprueba instalación desde npm, captura de sesión accesible al usuario, reproducción automática de demostraciones, persistencia de una sesión, tolerancia a cambios de la página, compatibilidad con otras tareas ni escrituras. La comparación se hace contra el DOM de la misma fuente, no contra un sistema independiente de Moodle. No permite afirmar compatibilidad universal. La prueba de laboratorio automatizada sigue siendo necesaria para reproducción pública sin credenciales reales.
