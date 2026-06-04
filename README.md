# Portal de Citas — Dra. Nancy Romero

Portal web para que los pacientes soliciten citas desde su teléfono.

## Despliegue en Railway

1. Sube este repositorio a GitHub
2. Ve a railway.app e inicia sesión con GitHub
3. Crea un nuevo proyecto → Deploy from GitHub repo
4. Selecciona este repositorio
5. Configura las variables de entorno:
   - `GMAIL_USUARIO` = dra.nancyromero26@gmail.com
   - `GMAIL_PASSWORD` = (contraseña de aplicación de 16 caracteres)
   - `API_KEY` = miconsulta-dra-romero-2024

## Variables de entorno requeridas

| Variable | Descripción |
|----------|-------------|
| GMAIL_USUARIO | Correo Gmail para enviar confirmaciones |
| GMAIL_PASSWORD | Contraseña de aplicación de Google (16 caracteres) |
| API_KEY | Clave para que la app de escritorio se conecte |
| PORT | Puerto (Railway lo asigna automáticamente) |
