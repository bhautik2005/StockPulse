/**
 * Order bulk-import route.
 *
 * Accepts one .csv or .xlsx file and creates one order for the batch, all
 * attributed to the authenticated user (req.user.id), every line assigned to an
 * explicit or auto-resolved warehouse in one atomic transaction.
 *
 * RBAC: Admin and Manager may call this endpoint. Staff / Clients receive 403.
 * A Manager is further restricted inside the service: they may only import into
 * warehouses where they hold manager_id or an explicit user_warehouses row.
 */
import { Router } from 'express';
import multer from 'multer';

import { ROLES } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { uuidString } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { attachWarehouseScope, requireRole } from '../../middleware/authorize.js';
import * as service from './bulkImport.service.js';

export const bulkImportRouter = Router();

// Only Admins and Managers may bulk-import orders. Staff and Clients are
// read-only on the order placement side of the system.
bulkImportRouter.use(authenticate, requireRole(ROLES.ADMIN, ROLES.MANAGER), attachWarehouseScope);

// ---------------------------------------------------------------------------
// Multer configuration
// ---------------------------------------------------------------------------

const fileFilter = (_req, file, cb) => {
  const ext = (file?.originalname ?? '').toLowerCase();
  const validExts = ['.xlsx', '.xls', '.csv'];
  if (!validExts.some((e) => ext.endsWith(e))) {
    return cb(AppError.badRequest('Invalid file type. Only .xlsx, .xls, and .csv files are supported.', 'INVALID_FILE_TYPE'));
  }
  cb(null, true);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter,
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(AppError.badRequest('Uploaded file exceeds the maximum 5MB size limit.', 'FILE_TOO_LARGE'));
      }
      if (err instanceof AppError) return next(err);
      return next(AppError.badRequest(err.message || 'Error uploading file', 'FILE_UPLOAD_ERROR'));
    }
    if (!req.file) {
      return next(AppError.badRequest('No file was uploaded. Please attach a .xlsx, .xls, or .csv file.', 'NO_FILE_UPLOADED'));
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// POST /api/orders/bulk-import
// ---------------------------------------------------------------------------

/**
 * Bulk import orders from Excel or CSV.
 *
 * Request: multipart/form-data with a `file` field and an optional
 * `warehouse_id` body field. Returns 200 on full success and 400 when any
 * single row fails validation or has insufficient stock -- no partial insert
 * happens in either case.
 *
 * An `Idempotency-Key` request header (UUID) makes retries safe: the same
 * key replays the original batch response instead of creating a second order.
 */
bulkImportRouter.post(
  '/bulk-import',
  handleUpload,
  asyncHandler(async (req, res) => {
    // -----------------------------------------------------------------------
    // Idempotency-Key validation (optional header; must be a UUID when present)
    // -----------------------------------------------------------------------
    const headerKey = req.get('idempotency-key');
    let idempotencyKey;
    if (headerKey) {
      const parsed = uuidString.safeParse(headerKey);
      if (!parsed.success) {
        throw AppError.badRequest('Idempotency-Key header must be a UUID', 'INVALID_IDEMPOTENCY_KEY');
      }
      idempotencyKey = parsed.data;
    }

    // -----------------------------------------------------------------------
    // Optional warehouse_id: when supplied it acts as the default for every
    // line that has no per-row warehouse column. When absent, the service
    // auto-allocates based on available stock.
    // -----------------------------------------------------------------------
    let targetWarehouseId;
    if (req.body.warehouse_id !== undefined && req.body.warehouse_id !== '') {
      const parsed = Number(req.body.warehouse_id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw AppError.badRequest('warehouse_id must be a positive integer when supplied.', 'INVALID_WAREHOUSE_ID');
      }
      targetWarehouseId = parsed;
    }

    const initialStock = Math.max(0, parseInt(req.body.initial_stock ?? '0', 10) || 0);

    // -----------------------------------------------------------------------
    // Step 1: Parse and validate the file synchronously (no DB involvement).
    //         A bad file returns 400 before any SQL is attempted.
    // -----------------------------------------------------------------------
    const parseResult = await service.parseFileToRows({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
    });

    if (parseResult.errors.length > 0) {
      // Surface per-row validation errors before attempting any DB work.
      throw AppError.badRequest(
        `File contained ${parseResult.errors.length} invalid row(s). Fix the errors and re-upload.`,
        'BULK_IMPORT_FAILED',
        parseResult.errors,
      );
    }

    const createdLines = parseResult.validRows;
    if (createdLines.length === 0) {
      throw AppError.badRequest('No valid rows were parsed from the uploaded file.', 'BULK_IMPORT_FAILED');
    }

    // -----------------------------------------------------------------------
    // Step 2: Transactional import. Resolves SKUs, checks warehouse access,
    //         decrements stock, and writes orders + ledger entries atomically.
    // -----------------------------------------------------------------------
    const response = await service.bulkImportOrders({
      actor: req.user,
      scope: req.warehouseScope,
      lines: createdLines,
      warehouseId: targetWarehouseId,
      initialStock,
      idempotencyKey,
    });

    res.status(200).json({ data: response });
  }),
);
