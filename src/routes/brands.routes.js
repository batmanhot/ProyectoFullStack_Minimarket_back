import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const toDto = (b) => ({ id: b.slug, slug: b.slug, name: b.name, description: b.description, color: b.color, logoUrl: b.logoUrl, isActive: b.isActive, createdAt: b.createdAt })

export default async function brandsRoutes(fastify) {

  // GET /api/brands
  fastify.get('/brands', { preHandler: PRE }, async (req, reply) => {
    const { search, isActive } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    }
    const brands = await prisma.brand.findMany({ where, orderBy: { name: 'asc' } })
    return sendOk(reply, brands.map(toDto), { total: brands.length })
  })

  // POST /api/brands
  fastify.post('/brands', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1),
      slug:        z.string().optional(),
      description: z.string().default(''),
      color:       z.string().default('#6b7280'),
      logoUrl:     z.string().default(''),
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
    while (await prisma.brand.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug } } })) {
      attempts++
      slug = `${slug}-${attempts}`
    }

    const brand = await prisma.brand.create({ data: { ...parsed.data, slug, tenantId: req.tenantId } })
    return sendOk(reply, toDto(brand), null, 201)
  })

  // PUT /api/brands/:slug
  fastify.put('/brands/:slug', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1).optional(),
      description: z.string().optional(),
      color:       z.string().optional(),
      logoUrl:     z.string().optional(),
      isActive:    z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const brand = await prisma.brand.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug: req.params.slug } } })
    if (!brand) return send404(reply, 'Marca')

    const updated = await prisma.brand.update({ where: { id: brand.id }, data: { ...parsed.data, updatedAt: new Date() } })
    return sendOk(reply, toDto(updated))
  })

  // DELETE /api/brands/:slug
  fastify.delete('/brands/:slug', { preHandler: PRE }, async (req, reply) => {
    const brand = await prisma.brand.findUnique({ where: { tenantId_slug: { tenantId: req.tenantId, slug: req.params.slug } } })
    if (!brand) return send404(reply, 'Marca')

    const inUse = await prisma.product.count({ where: { tenantId: req.tenantId, brandId: req.params.slug, isActive: true } })
    if (inUse > 0) return send409(reply, `No se puede eliminar: ${inUse} producto(s) usan esta marca`)

    await prisma.brand.delete({ where: { id: brand.id } })
    return sendOk(reply, { slug: req.params.slug, deleted: true })
  })
}
