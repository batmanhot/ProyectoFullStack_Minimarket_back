import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

// El slug se expone como "id" en la respuesta para compatibilidad con el frontend
const toDto = (c) => ({ id: c.slug, slug: c.slug, name: c.name, description: c.description, color: c.color, icon: c.icon, isActive: c.isActive, createdAt: c.createdAt })

export default async function categoriesRoutes(fastify) {

  // GET /api/categories
  fastify.get('/categories', { preHandler: PRE }, async (req, reply) => {
    const { search, isActive } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    }
    const cats = await prisma.category.findMany({ where, orderBy: { name: 'asc' } })
    return sendOk(reply, cats.map(toDto), { total: cats.length })
  })

  // POST /api/categories
  fastify.post('/categories', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1),
      slug:        z.string().optional(),
      description: z.string().default(''),
      color:       z.string().default('#6b7280'),
      icon:        z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    // Generar slug desde el nombre si no viene del frontend
    let slug = parsed.data.slug || parsed.data.name.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    // Si el slug ya existe, agregar sufijo numérico
    let attempts = 0
    while (await prisma.category.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug } } })) {
      attempts++
      slug = `${slug}-${attempts}`
    }

    const cat = await prisma.category.create({ data: { ...parsed.data, slug, tenantId: req.tenantId } })
    return sendOk(reply, toDto(cat), null, 201)
  })

  // PUT /api/categories/:slug
  fastify.put('/categories/:slug', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1).optional(),
      description: z.string().optional(),
      color:       z.string().optional(),
      icon:        z.string().optional(),
      isActive:    z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const cat = await prisma.category.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug: req.params.slug } } })
    if (!cat) return send404(reply, 'Categoría')

    const updated = await prisma.category.update({ where: { id: cat.id }, data: { ...parsed.data, updatedAt: new Date() } })
    return sendOk(reply, toDto(updated))
  })

  // DELETE /api/categories/:slug
  fastify.delete('/categories/:slug', { preHandler: PRE }, async (req, reply) => {
    const cat = await prisma.category.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug: req.params.slug } } })
    if (!cat) return send404(reply, 'Categoría')

    const inUse = await prisma.product.count({ where: { tenantId: req.tenantId, categoryId: req.params.slug, isActive: true } })
    if (inUse > 0) return send409(reply, `No se puede eliminar: ${inUse} producto(s) usan esta categoría`)

    await prisma.category.delete({ where: { id: cat.id } })
    return sendOk(reply, { slug: req.params.slug, deleted: true })
  })
}
