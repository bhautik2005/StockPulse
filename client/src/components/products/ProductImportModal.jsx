import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as xlsx from 'xlsx';
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  RefreshCw,
  Upload,
  Warehouse,
  X,
} from 'lucide-react';

import { useAuth } from '../../context/AuthContext.jsx';
import { describeError } from '../../lib/errors.js';
import { formatNumber } from '../../lib/format.js';
import { productsApi, warehousesApi } from '../../services/endpoints.js';
import { Badge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { Alert, Spinner } from '../ui/Feedback.jsx';
import { Field, Input, Select } from '../ui/Input.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

const SAMPLE_CSV = `sku,name,category,unit_price,reorder_level
SKU-1001,Wireless Keyboard,Electronics,49.99,15
SKU-1002,Optical Mouse,Electronics,24.50,20
SKU-1003,USB-C Fast Cable 2m,Accessories,9.99,50
SKU-1004,Adjustable Laptop Stand,Office,34.00,10
SKU-1005,Noise Cancelling Headset,Audio,89.00,8`;

const HEADER_ALIASES = {
  sku: ['sku', 'product_sku', 'product sku', 'item_sku', 'code'],
  name: ['name', 'product_name', 'product name', 'item_name', 'title'],
  category: ['category', 'product_category', 'product category', 'cat'],
  unit_price: ['unit_price', 'unit price', 'price', 'unitprice', 'rate'],
  reorder_level: ['reorder_level', 'reorder level', 'reorder', 'reorderlevel', 'min_stock'],
  quantity: ['quantity', 'qty', 'initial_stock', 'initial stock', 'stock'],
};

function downloadSampleTemplate(type = 'csv') {
  if (type === 'xlsx') {
    const wsData = [
      ['sku', 'name', 'category', 'unit_price', 'reorder_level', 'quantity'],
      ['SKU-1001', 'Wireless Keyboard', 'Electronics', 49.99, 15, 10],
      ['SKU-1002', 'Optical Mouse', 'Electronics', 24.5, 20, 15],
      ['SKU-1003', 'USB-C Fast Cable 2m', 'Accessories', 9.99, 50, 25],
      ['SKU-1004', 'Adjustable Laptop Stand', 'Office', 34.0, 10, 5],
      ['SKU-1005', 'Noise Cancelling Headset', 'Audio', 89.0, 8, 12],
    ];
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Products');
    xlsx.writeFile(wb, 'stockpulse_products_template.xlsx');
  } else {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'stockpulse_products_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

export function ProductImportModal({ open, onClose, onSuccess }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [file, setFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewRows, setPreviewRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [previewError, setPreviewError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState(null);
  const [serverError, setServerError] = useState(null);

  // Warehouse and initial stock options
  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('');
  const [initialStock, setInitialStock] = useState('10');
  const [loadingWarehouses, setLoadingWarehouses] = useState(false);

  const fileInputRef = useRef(null);

  const isManager = user?.role === 'Manager';
  const isAdmin = user?.role === 'Admin';

  // Fetch available warehouses on modal open
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
          // If manager, or admin without selection, select first available warehouse
          setSelectedWarehouseId((curr) => curr || String(list[0].id));
        }
      })
      .catch((err) => {
        if (!cancelled) setServerError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingWarehouses(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetState = useCallback(() => {
    setFile(null);
    setPreviewRows([]);
    setTotalRows(0);
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

  const parseFileForPreview = useCallback((selectedFile) => {
    setPreviewError(null);
    setPreviewRows([]);
    setTotalRows(0);

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

        const headers = raw[headerIdx].map((h) => String(h).trim().toLowerCase());
        const colMap = { sku: -1, name: -1, category: -1, unit_price: -1, reorder_level: -1, quantity: -1 };

        headers.forEach((h, idx) => {
          for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (colMap[key] === -1 && aliases.includes(h)) {
              colMap[key] = idx;
            }
          }
        });

        const missing = [];
        if (colMap.sku === -1) missing.push('sku');
        if (colMap.name === -1) missing.push('name');
        if (colMap.unit_price === -1) missing.push('unit_price');

        if (missing.length > 0) {
          setPreviewError(
            `Missing required column headers: ${missing.join(', ')}. Required headers are: sku, name, unit_price. Optional: category, reorder_level, quantity.`,
          );
          return;
        }

        const dataRows = raw.slice(headerIdx + 1).filter((row) =>
          row?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== ''),
        );

        if (dataRows.length === 0) {
          setPreviewError('File contains column headers but zero product rows.');
          return;
        }

        const preview = dataRows.slice(0, 5).map((row, i) => ({
          rowNumber: headerIdx + 2 + i,
          sku: String(row[colMap.sku] ?? '').trim(),
          name: String(row[colMap.name] ?? '').trim(),
          category: colMap.category !== -1 ? String(row[colMap.category] ?? '').trim() : '—',
          unit_price: colMap.unit_price !== -1 ? String(row[colMap.unit_price] ?? '').trim() : '—',
          reorder_level:
            colMap.reorder_level !== -1 && String(row[colMap.reorder_level] ?? '').trim() !== ''
              ? String(row[colMap.reorder_level]).trim()
              : '10 (default)',
          quantity:
            colMap.quantity !== -1 && String(row[colMap.quantity] ?? '').trim() !== ''
              ? String(row[colMap.quantity]).trim()
              : null,
        }));

        setPreviewRows(preview);
        setTotalRows(dataRows.length);
      } catch (err) {
        setPreviewError('Failed to parse file preview. Please ensure the file is not corrupted.');
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  }, []);

  const handleSelectFile = useCallback(
    (selectedFile) => {
      if (!selectedFile) return;
      const validExts = ['.xlsx', '.xls', '.csv'];
      const name = selectedFile.name.toLowerCase();
      const isValid = validExts.some((ext) => name.endsWith(ext));

      if (!isValid) {
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
    },
    [parseFileForPreview],
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile) handleSelectFile(droppedFile);
    },
    [handleSelectFile],
  );

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleSubmit = async () => {
    if (!file || previewError || !selectedWarehouseId) return;

    setUploading(true);
    setServerError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('warehouse_id', selectedWarehouseId);
    formData.append('initial_stock', initialStock || '0');

    try {
      const response = await productsApi.bulkImport(formData);
      setResults(response.data);
    } catch (err) {
      setServerError(describeError(err));
    } finally {
      setUploading(false);
    }
  };

  const selectedWarehouse = warehouses.find((w) => String(w.id) === String(selectedWarehouseId));

  return (
    <Dialog
      open={open}
      onClose={handleModalClose}
      title={results ? 'Import Results' : 'Import Products'}
      description={
        results
          ? 'Summary of the processed product batch and warehouse stock registration.'
          : 'Upload an Excel or CSV file to bulk import products and register stock directly into your warehouse.'
      }
      size="lg"
      footer={
        results ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={resetState}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Import another file
              </Button>
              {results.warehouse?.id ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    handleModalClose();
                    navigate(`/inventory?warehouse_id=${results.warehouse.id}`);
                  }}
                >
                  <Boxes className="h-4 w-4" aria-hidden="true" />
                  View in Inventory
                </Button>
              ) : null}
            </div>
            <Button onClick={handleModalClose}>Done</Button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Sample templates:</span>
              <button
                type="button"
                onClick={() => downloadSampleTemplate('csv')}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                CSV
              </button>
              <span>·</span>
              <button
                type="button"
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
                onClick={handleSubmit}
                loading={uploading}
                disabled={!file || !selectedWarehouseId || Boolean(previewError) || totalRows === 0}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {totalRows > 0 ? `Import ${formatNumber(totalRows)} products` : 'Import products'}
              </Button>
            </div>
          </div>
        )
      }
    >
      {results ? (
        /* Results View */
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
              <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                Total Rows Processed
              </p>
              <p className="mt-1 text-2xl font-bold tabular">{formatNumber(results.totalProcessed)}</p>
            </div>
            <div className="rounded-lg border border-success/30 bg-success/10 p-3 shadow-xs">
              <p className="text-2xs font-medium uppercase tracking-wider text-success">
                Successfully Imported
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
                Skipped / Failed
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

          <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3 text-xs">
            <Warehouse className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
            <div>
              <span className="font-semibold text-foreground">Target Warehouse: </span>
              <span>
                {results.warehouse ? `${results.warehouse.code} — ${results.warehouse.name}` : 'Assigned'}
              </span>
              <span className="ml-2 text-muted-foreground">
                ({results.initialStock} baseline units per product recorded in inventory)
              </span>
            </div>
          </div>

          {results.failedCount === 0 ? (
            <div className="flex items-center gap-3 rounded-md border border-success/30 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">All products imported successfully!</p>
                <p className="text-xs opacity-90">
                  {results.successCount} product lines and stock balances have been registered in{' '}
                  {results.warehouse?.name ?? 'your warehouse'}.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-destructive">
                  Failure Breakdown ({results.errors.length} issues detected)
                </span>
                <span className="text-2xs text-muted-foreground">
                  Valid rows were successfully committed.
                </span>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-card/50">
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-16">Row</TH>
                      <TH className="w-32">SKU</TH>
                      <TH>Reason / Error</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {results.errors.map((err, idx) => (
                      <TR key={idx}>
                        <TD className="font-mono text-xs text-muted-foreground tabular">
                          Row {err.row}
                        </TD>
                        <TD className="font-mono text-xs font-semibold">{err.sku || '—'}</TD>
                        <TD className="text-xs text-destructive">{err.error}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Upload & Parameters View */
        <div className="flex flex-col gap-4">
          {serverError ? (
            <Alert tone="destructive" title="Upload Failed">
              {serverError}
            </Alert>
          ) : null}

          {/* Warehouse Selection & Initial Stock Controls */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {isAdmin ? (
              <Field
                label="Destination Warehouse"
                hint="Products and inventory lines will be created for this warehouse"
                required
              >
                {(props) => (
                  <Select
                    {...props}
                    value={selectedWarehouseId}
                    onChange={(e) => setSelectedWarehouseId(e.target.value)}
                    disabled={uploading || loadingWarehouses}
                    required
                  >
                    <option value="">
                      {loadingWarehouses ? 'Loading warehouses...' : 'Select target warehouse...'}
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
                hint="Products and stock will be registered to your assigned warehouse"
              >
                {() => (
                  <div className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-xs font-medium text-foreground">
                    <Warehouse className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {selectedWarehouse
                        ? `${selectedWarehouse.code} — ${selectedWarehouse.name}`
                        : loadingWarehouses
                          ? 'Loading assigned warehouse...'
                          : 'No warehouse assigned'}
                    </span>
                    <Badge tone="primary" className="ml-auto text-2xs">
                      Assigned
                    </Badge>
                  </div>
                )}
              </Field>
            )}

            <Field
              label="Initial Stock per Product"
              hint="Default quantity on hand allocated for each product"
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min="0"
                  step="1"
                  value={initialStock}
                  onChange={(e) => setInitialStock(e.target.value)}
                  placeholder="10"
                  disabled={uploading}
                />
              )}
            </Field>
          </div>

          {/* Drag & Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !file && fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-all ${
              file
                ? 'cursor-default border-border bg-accent/20'
                : 'cursor-pointer hover:border-primary/60 hover:bg-accent/40'
            } ${
              isDragging ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border/80'
            }`}
          >
            <input
              ref={fileInputRef}
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
                      {totalRows > 0 ? `${formatNumber(totalRows)} rows ready` : 'Processing...'}
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

          {/* Upload Progress Bar */}
          {uploading ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 font-medium">
                  <Spinner className="h-3.5 w-3.5" />
                  Registering products and stock in {selectedWarehouse?.name ?? 'warehouse'}...
                </span>
                <span className="text-2xs text-muted-foreground">Please wait</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-full animate-pulse bg-primary" />
              </div>
            </div>
          ) : null}

          {/* Validation Alert */}
          {previewError ? (
            <Alert tone="destructive" title="Cannot import file">
              {previewError}
            </Alert>
          ) : null}

          {/* Preview Table */}
          {previewRows.length > 0 && !uploading ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Data Preview</span>
                <Badge tone="default">
                  Showing first {previewRows.length} of {formatNumber(totalRows)} rows
                </Badge>
              </div>

              <div className="overflow-hidden rounded-md border border-border bg-card">
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-24">SKU</TH>
                      <TH>Product Name</TH>
                      <TH className="w-24">Category</TH>
                      <TH className="w-20 text-right">Price</TH>
                      <TH className="w-24 text-right">Reorder Lvl</TH>
                      <TH className="w-20 text-right">Initial Qty</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {previewRows.map((row) => (
                      <TR key={row.rowNumber}>
                        <TD className="font-mono text-xs font-medium">{row.sku}</TD>
                        <TD className="max-w-[12rem] truncate text-xs">{row.name}</TD>
                        <TD className="text-xs text-muted-foreground">{row.category}</TD>
                        <TD className="text-right text-xs tabular">${row.unit_price}</TD>
                        <TD className="text-right text-xs text-muted-foreground tabular">
                          {row.reorder_level}
                        </TD>
                        <TD className="text-right text-xs font-semibold tabular text-primary">
                          {row.quantity ?? initialStock}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
