import { z } from 'zod';
import { paginationQuery, positiveInt } from '../../lib/commonSchemas.js';

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'Code may contain letters, digits and hyphens only')
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(100),
  location: z.string().trim().min(2).max(255),
  manager_id: positiveInt.nullable().optional(),
});

export const updateWarehouseSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    location: z.string().trim().min(2).max(255).optional(),
    manager_id: positiveInt.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const listWarehousesQuery = paginationQuery.extend({
  include_inactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});