/**
 * Product and catalogue routes.
 */
import { Router } from 'express';
import multer from 'multer';

import { ROLES } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { idParam } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  catalogQuery,
  createProductSchema,
  listProductsQuery,
  updateProductSchema,
} from './products.schemas.js';
import * as service from './products.service.js';

export const productsRouter = Router();
export const catalogRouter = Router();

/**
 * Client catalogue. Requires a session (B2B pricing is not public) but is
 * available to every role, including Clients.
 */
catalogRouter.use(authenticate);

catalogRouter.get(
  '/',
  validate({ query: catalogQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, search, category } = req.validatedQuery;
    const { rows, total } = await service.getCatalog({
      search,
      category,
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ data: rows, meta: { page, limit, total } });
  }),
);

catalogRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const product = await service.getProduct(req.params.id);
    res.json({
      data: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        unit_price: product.unit_price,
        available: product.total_quantity,
        in_stock: product.total_quantity > 0,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// /api/products -- internal catalogue management
// ---------------------------------------------------------------------------

productsRouter.use(authenticate, requireRole(ROLES.ADMIN, ROLES.MANAGER));

productsRouter.get(
  '/',
  validate({ query: listProductsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, search, category, include_inactive: includeInactive } = req.validatedQuery;
    const { rows, total } = await service.listProducts({
      search,
      category,
      includeInactive,
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ data: rows, meta: { page, limit, total } });
  }),
);

productsRouter.post(
  '/',
  validate({ body: createProductSchema }),
  asyncHandler(async (req, res) => {
    const product = await service.createProduct({ input: req.body });
    res.status(201).json({ data: product });
  }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (_req, file, cb) => {
    const originalName = (file.originalname || '').toLowerCase();
    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const isValid = validExtensions.some((ext) => originalName.endsWith(ext));
    if (!isValid) {
      return cb(
        AppError.badRequest(
          'Invalid file type. Only Excel (.xlsx, .xls) and CSV (.csv) files are supported.',
          'INVALID_FILE_TYPE',
        ),
      );
    }
    cb(null, true);
  },
});

function handleBulkUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          AppError.badRequest('Uploaded file exceeds the maximum 5MB size limit.', 'FILE_TOO_LARGE'),
        );
      }
      if (err instanceof AppError) {
        return next(err);
      }
      return next(AppError.badRequest(err.message || 'Error uploading file', 'FILE_UPLOAD_ERROR'));
    }
    if (!req.file) {
      return next(
        AppError.badRequest(
          'No file was uploaded. Please attach a .xlsx, .xls, or .csv file.',
          'NO_FILE_UPLOADED',
        ),
      );
    }
    next();
  });
}

/** Bulk import products from Excel or CSV with target warehouse routing */
productsRouter.post(
  '/bulk-import',
  handleBulkUpload,
  asyncHandler(async (req, res) => {
    const warehouseId = Number(req.body.warehouse_id);
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      throw AppError.badRequest(
        'A valid warehouse_id must be provided for product import.',
        'INVALID_WAREHOUSE_ID',
      );
    }

    // Role-based warehouse authorization check
    if (req.user.role === ROLES.MANAGER) {
      const { rows: accessRows } = await query(
        `SELECT 1 FROM warehouses w
          WHERE w.id = $1 AND w.deleted_at IS NULL
            AND (
              w.manager_id = $2
              OR EXISTS (
                SELECT 1 FROM user_warehouses uw
                 WHERE uw.warehouse_id = w.id AND uw.user_id = $2
              )
            )`,
        [warehouseId, req.user.id],
      );

      if (accessRows.length === 0) {
        throw AppError.forbidden(
          'You do not have permission to import products into this warehouse.',
          'WAREHOUSE_FORBIDDEN',
        );
      }
    }

    const initialStock = Math.max(0, parseInt(req.body.initial_stock ?? '0', 10) || 0);

    const result = await service.bulkImportProducts({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      warehouseId,
      initialStock,
      actor: req.user,
    });

    res.status(200).json({ data: result });
  }),
);

productsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await service.getProduct(req.params.id) });
  }),
);

productsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateProductSchema }),
  asyncHandler(async (req, res) => {
    const product = await service.updateProduct({ productId: req.params.id, patch: req.body });
    res.json({ data: product });
  }),
);

/**
 * Archives a product. Deliberately not a hard delete: order_items and the stock
 * ledger reference products, and history must stay intact.
 */
productsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const product = await service.archiveProduct({ productId: req.params.id });
    res.status(200).json({ data: product, meta: { archived: true } });
  }),
);