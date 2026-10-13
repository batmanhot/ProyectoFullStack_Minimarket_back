# Despliegue seguro

Antes de ejecutar `npx prisma migrate deploy` en producción, crea y verifica un
respaldo restaurable de PostgreSQL. La migración `20261009213031_align_plan_config`
elimina columnas antiguas de `plan_configs`; en una base histórica debe ensayarse
primero en una copia y documentarse la equivalencia de cada límite/feature.

Variables mínimas de producción:

```env
NODE_ENV=production
APP_MODE=production
FRONTEND_URL=https://app.example.com
CORS_ORIGINS=https://app.example.com
JWT_SECRET=<secreto-aleatorio-largo>
SUPERADMIN_PASS=<contraseña-aleatoria-larga>
```

No uses `localhost`, secretos de ejemplo ni ejecutes el seed en producción.
