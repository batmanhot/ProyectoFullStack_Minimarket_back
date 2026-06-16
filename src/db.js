// @prisma/client es CommonJS — usar default import en proyectos ESM
import pkg from '@prisma/client'
const { PrismaClient } = pkg

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})

export default prisma
