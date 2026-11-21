# Sitio de AnyWeb

Web estática en Astro, independiente del servidor MCP de AnyWeb.

## Desarrollo

Requiere Node.js 22.23.4 o superior (el proyecto principal usa Node.js 24).

```bash
npm ci
npm run dev
```

Para generar y comprobar la versión de producción:

```bash
npm run build
npm run check
```

## Desplegar en Vercel

Importa el repositorio en Vercel y selecciona `website` como **Root Directory**. Vercel detecta Astro y ejecuta `npm run build`; el resultado estático queda en `dist/`. El sitio no necesita variables de entorno, funciones de servidor ni acceso a sesiones o credenciales.

La demostración de la página es una explicación interactiva con datos de ejemplo: no ejecuta AnyWeb ni accede a sitios externos. Consulta el README del repositorio principal para instalar y usar el producto.
