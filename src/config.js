import 'dotenv/config'

export const config = {
  // Servidor
  port:        parseInt(process.env.PORT || '3001'),
  nodeEnv:     process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // JWT
  jwtSecret:    process.env.JWT_SECRET    || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // factu-api (SUNAT) — Fase 7, pendiente
  factuApiUrl:  process.env.FACTU_API_URL  || 'http://localhost:3002/api/v1',
  factuApiKey:  process.env.FACTU_API_KEY  || '',
  emisorId:     process.env.EMISOR_ID      || '',
  emisorRuc:    process.env.EMISOR_RUC     || '',
  emisorNombre: process.env.EMISOR_NOMBRE  || '',

  // Superadmin credentials (acceso global, sin tenant)
  superadminUser: process.env.SUPERADMIN_USER || 'superadmin',
  superadminPass: process.env.SUPERADMIN_PASS || 'superadmin123',

  // SMTP — para notificaciones de alertas por email
  // Configurar en .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: process.env.SMTP_PORT || '587',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '',
}
