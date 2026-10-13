import 'dotenv/config'

const nodeEnv = process.env.NODE_ENV || 'development'

export const config = {
  // Servidor
  port:        parseInt(process.env.PORT || '3001'),
  nodeEnv,
  host:        process.env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean),

  // JWT
  jwtSecret:    process.env.JWT_SECRET    || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

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
