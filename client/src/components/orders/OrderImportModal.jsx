/**
 * OrderImportModal
 *
 * A multi-step modal for bulk-importing orders from a .csv or .xlsx file.
 *
 * Flow:
 *   1. Warehouse selection (Admin sees dropdown; Manager sees their assigned warehouse)
 *   2. File upload (drag-and-drop zone with client-side preview + validation)
 *   3. Pre-submission error display (invalid rows are shown before sending)
 *   4. Server-side submission with progress indicator
 *   5. Results view (success/failure breakdown with row-level detail)
 *
 * Design matches ProductImportModal exactly so the two import flows are visually
 * consistent. Column header aliases follow bulkImport.schemas.js so the same
 * template file works for both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as xlsx from 'xlsx';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  RefreshCw,
  ShoppingCart,
  Upload,
  Warehouse,
  X,
} from 'lucide-react';

import { useAuth } from '../../context/AuthContext.jsx';
import { describeError } from '../../lib/errors.js';
import { formatMoney, formatNumber } from '../../lib/format.js';
import { ordersApi, warehousesApi } from '../../services/endpoints.js';
import { Badge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { Alert, Spinner } from '../ui/Feedback.jsx';
import { Field, Input, Select } from '../ui/Input.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

// ---------------------------------------------------------------------------
// Sample template
// ---------------------------------------------------------------------------

const SAMPLE_CSV = `sku,product_name,unit_price,quantity
WIDGET-001,Industrial Widget A,29.99,10
WIDGET-002,Industrial Widget B,49.50,5
CABLE-USB-C,USB-C Fast Cable 2m,9.99,20
STAND-LPT,Adjustable Laptop Stand,34.00,3`;

/** Column header aliases that the server accepts (mirrors bulkImport.schemas.js). */
const HEADER_ALIASES = {
  sku: ['sku', 'product_sku', 'product sku', 'item_sku', 'code'],
  product_name: ['product_name', 'product name', 'item_name', 'name'],
  unit_price: ['unit_price', 'unit price', 'price'],
  quantity: ['quantity', 'qty'],
  warehouse_id: ['warehouse_id', 'warehouse'],
  currency: ['currency', 'ccy', 'currency code'],
};

function downloadSampleTemplate(type = 'csv') {
  if (type === 'xlsx') {
    const wsData = [
      ['sku', 'product_name', 'unit_price', 'quantity', 'currency'],
      ['WIDGET-001', 'Industrial Widget A', 29.99, 10, 'USD'],
      ['WIDGET-002', 'Industrial Widget B', 49.50, 5, 'USD'],
      ['CABLE-USB-C', 'USB-C Fast Cable 2m', 9.99, 20, 'USD'],
      ['STAND-LPT', 'Adjustable Laptop Stand', 34.00, 3, 'USD'],
    ];
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Orders');
    xlsx.writeFile(wb, 'stockpulse_orders_template.xlsx');
  } else {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'stockpulse_orders_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Client-side row validator (mirrors the server's bulkImport.service.js logic
// closely enough to catch obvious errors before the upload round-trip).
// ---------------------------------------------------------------------------

function resolveHeaderIndices(headerRow) {
  const indices = { sku: -1, product_name: -1, unit_price: -1, quantity: -1, warehouse_id: -1, currency: -1 };
  headerRow.forEach((rawCol, idx) => {
    const clean = String(rawCol ?? '').trim().toLowerCase().replace(/[\r\n\t]+/g, ' ');
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (indices[field] === -1 && aliases.includes(clean)) {
        indices[field] = idx;
      }
    }
  });
  return indices;
}

function validatePreviewRow(row, colIndices, rowNumber) {
  const errors = [];

  const sku = String(row[colIndices.sku] ?? '').trim();
  if (!sku) errors.push('Missing SKU');
  else if (sku.includes('\u0000')) errors.push('SKU contains null byte');
  else if (sku.length < 2 || sku.length > 50) errors.push('SKU must be 2–50 characters');
  else if (!/^[A-Za-z0-9._-]+$/.test(sku)) errors.push('SKU: letters, digits, dot, underscore, hyphen only');

  const name = String(row[colIndices.product_name] ?? '').trim();
  if (!name) errors.push('Missing product name');
  else if (name.includes('\u0000')) errors.push('Product name contains null byte');

  const priceRaw = String(row[colIndices.unit_price] ?? '').trim().replace(/^\$/, '');
  const price = Number(priceRaw);
  if (priceRaw === '') errors.push('Missing unit price');
  else if (!Number.isFinite(price) || price < 0) errors.push('Unit price must be ≥ 0');
  else if ((priceRaw.split('.')[1] ?? '').length > 2) errors.push('Unit price: max 2 decimal places');

  const qtyRaw = colIndices.quantity !== -1 ? row[colIndices.quantity] : undefined;
  if (qtyRaw !== undefined && String(qtyRaw).trim() !== '') {
    const qty = Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a positive integer');
  }

  return {
    rowNumber,
    sku: sku || 'N/A',
    name: name || '—',
    price: priceRaw || '—',
    qty: qtyRaw !== undefined && String(qtyRaw).trim() !== '' ? String(qtyRaw).trim() : '—',
    currency: colIndices.currency !== -1 ? String(row[colIndices.currency] ?? '').trim().toUpperCase() || '—' : '—',
    errors,
    isValid: errors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrderImportModal({ open, onClose, onSuccess }) {
  const { user, isAdmin, can } = useAuth();

  const [file, setFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewRows, setPreviewRows] = useState([]);  // first 5 rows for display
  const [totalRows, setTotalRows] = useState(0);
  const [invalidRows, setInvalidRows] = useState([]);   // rows with client-side errors
  const [previewError, setPreviewError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState(null);
  const [serverError, setServerError] = useState(null);

  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('');
  const [loadingWarehouses, setLoadingWarehouses] = useState(false);

  const fileInputRef = useRef(null);
  const isManager = can('Manager');

  // -------------------------------------------------------------------------
  // Fetch warehouses when modal opens
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingWarehouses(true);

    warehousesApi
      .list({ limit: 100 })
      .then((res) => {
        if (cancelled) return;
        const list = res.data ?? [];
        setWarehouses(list);
        if (list.length > 0) {
          setSelectedWarehouseId((curr) => curr || String(list[0].id));
        }
      })
      .catch((err) => {
        if (!cancelled) setServerError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingWarehouses(false);
      });

    return () => { cancelled = true; };
  }, [open]);

  // -------------------------------------------------------------------------
  // State reset
  // -------------------------------------------------------------------------

  const resetState = useCallback(() => {
    setFile(null);
    setPreviewRows([]);
    setTotalRows(0);
    setInvalidRows([]);
    setPreviewError(null);
    setUploading(false);
    setResults(null);
    setServerError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleModalClose = useCallback(() => {
    const hadSuccess = results && results.successCount > 0;
    const finalResults = results;
    resetState();
    onClose();
    if (hadSuccess) onSuccess?.(finalResults);
  }, [results, resetState, onClose, onSuccess]);

  // -------------------------------------------------------------------------
  // File parsing (client-side preview + validation)
  // -------------------------------------------------------------------------

  const parseFileForPreview = useCallback((selectedFile) => {
    setPreviewError(null);
    setPreviewRows([]);
    setTotalRows(0);
    setInvalidRows([]);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = xlsx.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          setPreviewError('The uploaded file contains no sheets.');
          return;
        }

        const worksheet = workbook.Sheets[sheetName];
        const raw = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        if (!raw || raw.length === 0) {
          setPreviewError('The uploaded file is empty.');
          return;
        }

        let headerIdx = -1;
        for (let i = 0; i < raw.length; i++) {
          if (raw[i]?.some((cell) => String(cell).trim() !== '')) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) {
          setPreviewError('File contains no headers or data.');
          return;
        }

        const colIndices = resolveHeaderIndices(raw[headerIdx]);

        const missing = [];
        if (colIndices.sku === -1) missing.push('sku');
        if (colIndices.product_name === -1) missing.push('product_name');
        if (colIndices.unit_price === -1) missing.push('unit_price');

        if (missing.length > 0) {
          setPreviewError(
            `Missing required column headers: ${missing.join(', ')}. ` +
            `Required: sku, product_name, unit_price. Optional: quantity, currency, warehouse_id.`,
          );
          return;
        }

        const dataRows = raw
          .slice(headerIdx + 1)
          .map((row, i) => ({ row, rowNumber: headerIdx + 2 + i }))
          .filter(({ row }) => row?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== ''));

        if (dataRows.length === 0) {
          setPreviewError('File contains column headers but no data rows.');
          return;
        }

        const validated = dataRows.map(({ row, rowNumber }) =>
          validatePreviewRow(row, colIndices, rowNumber),
        );

        const invalid = validated.filter((r) => !r.isValid);
        setInvalidRows(invalid);
        setPreviewRows(validated.slice(0, 5));
        setTotalRows(dataRows.length);
      } catch {
        setPreviewError('Failed to parse file preview. Ensure the file is not corrupted.');
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  }, []);

  const handleSelectFile = useCallback((selectedFile) => {
    if (!selectedFile) return;
    const validExts = ['.xlsx', '.xls', '.csv'];
    const name = selectedFile.name.toLowerCase();
    if (!validExts.some((ext) => name.endsWith(ext))) {
      setPreviewError('Invalid file type. Please upload a .xlsx, .xls, or .csv file.');
      return;
    }
    if (selectedFile.size > 5 * 1024 * 1024) {
      setPreviewError('File size exceeds the 5MB limit.');
      return;
    }
    setFile(selectedFile);
    setServerError(null);
    parseFileForPreview(selectedFile);
  }, [parseFileForPreview]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) handleSelectFile(droppedFile);
  }, [handleSelectFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  const hasClientErrors = invalidRows.length > 0;
  const canSubmit = file && !previewError && !hasClientErrors && totalRows > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setUploading(true);
    setServerError(null);

    const formData = new FormData();
    formData.append('file', file);
    if (selectedWarehouseId) {
      formData.append('warehouse_id', selectedWarehouseId);
    }

    try {
      const response = await ordersApi.bulkImport(formData);
      setResults(response.data);
    } catch (err) {
      setServerError(describeError(err));
    } finally {
      setUploading(false);
    }
  };

  const selectedWarehouse = warehouses.find((w) => String(w.id) === String(selectedWarehouseId));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog
      open={open}
      onClose={handleModalClose}
      title={results ? 'Import Results' : 'Bulk Order Import'}
      description={
        results
          ? 'Summary of the processed order batch.'
          : 'Upload an Excel or CSV file to create orders in bulk. Each row becomes one order line attributed to your account.'
      }
      size="lg"
      footer={
        results ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button variant="outline" onClick={resetState}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Import another file
            </Button>
            <Button onClick={handleModalClose}>Done</Button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Sample templates:</span>
              <button
                type="button"
                id="orders-import-download-csv"
                onClick={() => downloadSampleTemplate('csv')}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                CSV
              </button>
              <span>·</span>
              <button
                type="button"
                id="orders-import-download-xlsx"
                onClick={() => downloadSampleTemplate('xlsx')}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Excel (.xlsx)
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleModalClose} disabled={uploading}>
                Cancel
              </Button>
              <Button
                id="orders-import-submit"
                onClick={handleSubmit}
                loading={uploading}
                disabled={!canSubmit}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {totalRows > 0 ? `Import ${formatNumber(totalRows)} order line${totalRows === 1 ? '' : 's'}` : 'Import orders'}
              </Button>
            </div>
          </div>
        )
      }
    >
      {results ? (
        /* ------------------------------------------------------------------ */
        /* Results View                                                        */
        /* ------------------------------------------------------------------ */
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
              <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                Rows Processed
              </p>
              <p className="mt-1 text-2xl font-bold tabular">{formatNumber(results.totalProcessed)}</p>
            </div>
            <div className="rounded-lg border border-success/30 bg-success/10 p-3 shadow-xs">
              <p className="text-2xs font-medium uppercase tracking-wider text-success">
                Lines Imported
              </p>
              <p className="mt-1 text-2xl font-bold tabular text-success">
                {formatNumber(results.successCount)}
              </p>
            </div>
            <div
              className={`rounded-lg border p-3 shadow-xs ${
                results.failedCount > 0
                  ? 'border-destructive/30 bg-destructive/10'
                  : 'border-border bg-card'
              }`}
            >
              <p
                className={`text-2xs font-medium uppercase tracking-wider ${
                  results.failedCount > 0 ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                Failed
              </p>
              <p
                className={`mt-1 text-2xl font-bold tabular ${
                  results.failedCount > 0 ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {formatNumber(results.failedCount)}
              </p>
            </div>
          </div>

          {results.orderNumber ? (
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3 text-xs">
              <ShoppingCart className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <span className="font-semibold text-foreground">Order created: </span>
                <span className="font-mono">{results.orderNumber}</span>
                {results.replayed ? (
                  <Badge tone="outline" className="ml-2 text-2xs">Replayed</Badge>
                ) : null}
              </div>
            </div>
          ) : null}

          {results.failedCount === 0 ? (
            <div className="flex items-center gap-3 rounded-md border border-success/30 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">All order lines imported successfully!</p>
                <p className="text-xs opacity-90">
                  {results.successCount} line{results.successCount === 1 ? '' : 's'} have been placed and inventory decremented.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        /* ------------------------------------------------------------------ */
        /* Upload & Parameters View                                             */
        /* ------------------------------------------------------------------ */
        <div className="flex flex-col gap-4">
          {serverError ? (
            <Alert tone="destructive" title="Import Failed">
              {serverError}
            </Alert>
          ) : null}

          {/* Warehouse Selection */}
          {isAdmin ? (
            <Field
              label="Destination Warehouse"
              hint="Lines without an explicit warehouse column will be fulfilled from here (or auto-allocated when left blank)"
            >
              {(props) => (
                <Select
                  {...props}
                  id="orders-import-warehouse"
                  value={selectedWarehouseId}
                  onChange={(e) => setSelectedWarehouseId(e.target.value)}
                  disabled={uploading || loadingWarehouses}
                >
                  <option value="">
                    {loadingWarehouses ? 'Loading warehouses…' : 'Auto-allocate by stock'}
                  </option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field
              label="Destination Warehouse"
              hint="Lines will be fulfilled from your assigned warehouse or auto-allocated"
            >
              {() => (
                <div className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-xs font-medium text-foreground">
                  <Warehouse className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate">
                    {selectedWarehouse
                      ? `${selectedWarehouse.code} — ${selectedWarehouse.name}`
                      : loadingWarehouses
                        ? 'Loading assigned warehouse…'
                        : 'Auto-allocate by stock'}
                  </span>
                  <Badge tone="primary" className="ml-auto text-2xs">
                    Assigned
                  </Badge>
                </div>
              )}
            </Field>
          )}

          {/* Drag & Drop Zone */}
          <div
            id="orders-import-dropzone"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !file && fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-all ${
              file
                ? 'cursor-default border-border bg-accent/20'
                : 'cursor-pointer hover:border-primary/60 hover:bg-accent/40'
            } ${isDragging ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border/80'}`}
          >
            <input
              ref={fileInputRef}
              id="orders-import-file-input"
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) handleSelectFile(e.target.files[0]);
              }}
            />

            {file ? (
              <div className="flex w-full items-center justify-between gap-3">
                <div className="flex items-center gap-3 truncate">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="truncate text-left">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-2xs text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB ·{' '}
                      {totalRows > 0 ? `${formatNumber(totalRows)} rows ready` : 'Processing…'}
                    </p>
                  </div>
                </div>
                {!uploading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetState();
                    }}
                    className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Change file
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FileUp className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">Click to upload or drag and drop</p>
                  <p className="text-2xs text-muted-foreground">
                    Excel (.xlsx, .xls) or CSV (.csv) up to 5MB
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Upload Progress */}
          {uploading ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 font-medium">
                  <Spinner className="h-3.5 w-3.5" />
                  Processing order lines and decrementing inventory…
                </span>
                <span className="text-2xs text-muted-foreground">Please wait</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-full animate-pulse bg-primary" />
              </div>
            </div>
          ) : null}

          {/* File parsing / header error */}
          {previewError ? (
            <Alert tone="destructive" title="Cannot import file">
              {previewError}
            </Alert>
          ) : null}

          {/* Client-side row validation errors */}
          {hasClientErrors && !previewError && !uploading ? (
            <div className="flex flex-col gap-2">
              <Alert tone="destructive" title={`${invalidRows.length} row${invalidRows.length === 1 ? '' : 's'} failed validation`}>
                Fix the errors below before uploading. The entire batch will be rejected if any row is invalid.
              </Alert>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-card/50">
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-14">Row</TH>
                      <TH className="w-28">SKU</TH>
                      <TH>Error(s)</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {invalidRows.map((row) => (
                      <TR key={row.rowNumber}>
                        <TD className="font-mono text-xs text-muted-foreground tabular">
                          {row.rowNumber}
                        </TD>
                        <TD className="font-mono text-xs font-semibold">{row.sku}</TD>
                        <TD className="text-xs text-destructive">{row.errors.join('; ')}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          ) : null}

          {/* Preview Table */}
          {previewRows.length > 0 && !uploading && !previewError ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Data Preview</span>
                <div className="flex items-center gap-2">
                  {hasClientErrors ? (
                    <Badge tone="destructive">
                      {invalidRows.length} invalid row{invalidRows.length === 1 ? '' : 's'}
                    </Badge>
                  ) : (
                    <Badge tone="success">All rows valid</Badge>
                  )}
                  <Badge tone="default">
                    Showing first {previewRows.length} of {formatNumber(totalRows)} rows
                  </Badge>
                </div>
              </div>

              <div className="overflow-hidden rounded-md border border-border bg-card">
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-8">Row</TH>
                      <TH className="w-28">SKU</TH>
                      <TH>Product Name</TH>
                      <TH className="w-20 text-right">Price</TH>
                      <TH className="w-20 text-right">Qty</TH>
                      <TH className="w-14 text-right">CCY</TH>
                      <TH className="w-12 text-right">OK?</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {previewRows.map((row) => (
                      <TR
                        key={row.rowNumber}
                        className={!row.isValid ? 'bg-destructive/5' : undefined}
                      >
                        <TD className="font-mono text-2xs text-muted-foreground tabular">
                          {row.rowNumber}
                        </TD>
                        <TD className="font-mono text-xs font-medium">{row.sku}</TD>
                        <TD className="max-w-[10rem] truncate text-xs">{row.name}</TD>
                        <TD className="text-right text-xs tabular">{row.price !== '—' ? `$${row.price}` : '—'}</TD>
                        <TD className="text-right text-xs font-semibold tabular text-primary">
                          {row.qty}
                        </TD>
                        <TD className="text-right text-2xs text-muted-foreground">{row.currency}</TD>
                        <TD className="text-right">
                          {row.isValid ? (
                            <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-success" aria-label="Valid" />
                          ) : (
                            <AlertCircle className="ml-auto h-3.5 w-3.5 text-destructive" aria-label="Invalid" title={row.errors.join('; ')} />
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>

              {totalRows > 5 ? (
                <p className="text-2xs text-muted-foreground text-center">
                  … and {formatNumber(totalRows - 5)} more row{totalRows - 5 === 1 ? '' : 's'} not shown
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Required columns info */}
          {!file ? (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Required columns
              </p>
              <div className="flex flex-wrap gap-1.5">
                {['sku', 'product_name', 'unit_price', 'quantity'].map((col) => (
                  <span
                    key={col}
                    className="rounded bg-background px-2 py-0.5 font-mono text-2xs border border-border"
                  >
                    {col}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-2xs text-muted-foreground">
                Optional: <span className="font-mono">currency</span>, <span className="font-mono">warehouse_id</span>.
                SKUs must already exist in the product catalogue.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
