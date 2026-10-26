# Temu — AnyWeb MCP

Conector local de solo lectura para buscar productos y consultar su ficha con la sesión personal de Temu. La página puede mostrar precios u ofertas ligados a la cuenta.

## Iniciar sesión

```bash
node src/cli.mjs temu login
```

El login inicial abre Google Chrome instalado directamente, sin Chromium for Testing ni automatización. Si aparece el acceso de Google, usa el formulario de Temu con correo o teléfono y su código. Cierra esa ventana de Chrome y pulsa Enter en la terminal; el perfil aislado queda en `~/.web2api/profiles/temu-chrome/`. El conector no exporta cookies. No envíes contraseñas ni códigos al MCP.

Después del login, el MCP realiza las búsquedas y consultas en modo headless: no muestra ventanas de Chrome ni requiere interacción con el navegador.

Si el perfil no tiene una sesión válida, las herramientas responden `LOGIN_REQUIRED`. Vuelve a ejecutar el comando de login para renovar la sesión.

## Registrar el MCP

```bash
node src/cli.mjs temu package
```

El comando genera `~/.web2api/connectors/temu/.mcp.json`. Agrega esa configuración al cliente MCP que uses. El servidor corre en este equipo y usa las dependencias ya instaladas en el repositorio.

## Herramientas

- `temu_search_products`: busca por texto y devuelve nombre, precio mostrado, imagen y URL de producto.
- `temu_product_details`: lee nombre, precio mostrado, descripción e imagen desde una URL de Temu.

Ambas herramientas son de solo lectura; no modifican carrito ni pedidos y no realizan compras. La extracción depende del HTML que Temu sirve en la cuenta y puede requerir ajustes si cambia su web. La contraseña, cookies y perfil no se incluyen en el registro MCP ni se envían al modelo.
