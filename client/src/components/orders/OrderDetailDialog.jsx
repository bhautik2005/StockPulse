import { useState } from 'react';
import { Ban, CheckCircle2, Clock, History } from 'lucide-react';

import { useAuth } from '../../context/AuthContext.jsx';
import { useApiResource } from '../../hooks/useApiResource.js';
import { ALLOWED_TRANSITIONS } from '../../lib/constants.js';
import { describeError } from '../../lib/errors.js';
import { formatAmount, formatDateTime, formatMoney, formatRelative } from '../../lib/format.js';
import { ordersApi } from '../../services/endpoints.js';
import { StatusBadge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { ErrorState, Skeleton } from '../ui/Feedback.jsx';
import { Field, Textarea } from '../ui/Input.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../ui/Table.jsx';
import { useToast } from '../ui/Toast.jsx';

/** Statuses from which the API still allows a cancellation. */
const CANCELLABLE = ['Pending', 'Processing', 'Partially Shipped'];

export function OrderDetailDialog({ orderId, onClose, onChanged }) {
  const { isInternal } = useAuth();
  const toast = useToast();

  const order = useApiResource(() => ordersApi.get(orderId), [orderId], { skip: !orderId });

  const [mode, setMode] = useState(null); // 'advance' | 'cancel'
  const [nextStatus, setNextStatus] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const data = order.data;
  const transitions = data ? ALLOWED_TRANSITIONS[data.status] ?? [] : [];
  const canCancel = Boolean(data) && CANCELLABLE.includes(data.status);

  function reset() {
    setMode(null);
    setNextStatus('');
    setReason('');
    setError(null);
  }

  async function handleAdvance(event) {
    event.preventDefault();
    if (!nextStatus) return;
    setSubmitting(true);
    setError(null);
    try {
      await ordersApi.updateStatus(data.id, nextStatus, reason.trim() || undefined);
      toast.success('Order updated', `${data.order_number} is now ${nextStatus}.`);
      reset();
      order.reload();
      onChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await ordersApi.cancel(data.id, reason.trim());
      toast.success('Order cancelled', `Stock for ${data.order_number} was returned to its warehouses.`);
      reset();
      order.reload();
      onChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={Boolean(orderId)}
      onClose={() => {
        reset();
        onClose();
      }}
      size="xl"
      title={data ? `Order ${data.order_number}` : 'Order'}
      description={data ? `${data.client?.name} · placed ${formatDateTime(data.created_at)}` : 'Loading…'}
      footer={
        data ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={data.status} />
              {data.status === 'Delivered' ? (
                <span className="flex items-center gap-1 text-2xs text-success">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Stock consumed
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {isInternal && transitions.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setMode(mode === 'advance' ? null : 'advance')}>
                  Change status
                </Button>
              ) : null}
              {canCancel ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setMode(mode === 'cancel' ? null : 'cancel')}
                >
                  <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                  Cancel order
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {order.error ? (
        <ErrorState error={order.error} onRetry={order.reload} />
      ) : order.loading || !data ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {data.cancelled_reason ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs font-medium text-destructive">Cancellation reason</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{data.cancelled_reason}</p>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-border p-3">
              <p className="text-2xs text-muted-foreground">Total</p>
              <p className="tabular mt-0.5 text-sm font-semibold">
                {formatMoney(data.total_amount, data.currency)}
              </p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-2xs text-muted-foreground">Lines</p>
              <p className="tabular mt-0.5 text-sm font-semibold">{data.items.length}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-2xs text-muted-foreground">Client</p>
              <p className="mt-0.5 truncate text-sm font-semibold">{data.client?.name}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-2xs text-muted-foreground">Last change</p>
              <p className="mt-0.5 text-sm font-semibold">{formatRelative(data.updated_at)}</p>
            </div>
          </div>

          {/* Status change and cancellation are forms, not menus: both need a
              reason, and a reason is what makes the audit trail readable. */}
          {mode === 'advance' ? (
            <form className="flex flex-col gap-3 rounded-md border border-border p-3" onSubmit={handleAdvance}>
              <p className="text-xs font-medium">Move to</p>
              <div className="flex flex-wrap gap-1.5">
                {transitions.map((status) => (
                  <Button
                    key={status}
                    type="button"
                    size="sm"
                    variant={nextStatus === status ? 'default' : 'outline'}
                    onClick={() => setNextStatus(status)}
                  >
                    {status}
                  </Button>
                ))}
              </div>
              <Field label="Note" hint="Optional. Recorded against the change.">
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Dispatched with DHL 7741"
                  />
                )}
              </Field>
              {error ? <p className="text-xs text-destructive">{describeError(error)}</p> : null}
              <div className="flex justify-end">
                <Button type="submit" size="sm" loading={submitting} disabled={!nextStatus}>
                  Apply
                </Button>
              </div>
            </form>
          ) : null}

          {mode === 'cancel' ? (
            <form className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3" onSubmit={handleCancel}>
              <p className="text-xs font-medium">Cancel this order</p>
              <p className="text-2xs text-muted-foreground">
                Every line goes back into the warehouse it came from, as a new ledger entry. A reason
                of at least 3 characters is required.
              </p>
              <Field label="Reason" required>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Client reduced their requirement"
                    autoFocus
                  />
                )}
              </Field>
              {error ? <p className="text-xs text-destructive">{describeError(error)}</p> : null}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  loading={submitting}
                  disabled={reason.trim().length < 3}
                >
                  Confirm cancellation
                </Button>
              </div>
            </form>
          ) : null}

          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Warehouse</TH>
                  <TH className="text-right">Qty</TH>
                  <TH className="text-right">Unit price</TH>
                  <TH className="text-right">Line total</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">{item.product_name}</span>
                        <span className="font-mono text-2xs text-muted-foreground">{item.product_sku}</span>
                      </div>
                    </TD>
                    <TD className="font-mono text-2xs text-muted-foreground">
                      {item.warehouse?.code ?? '—'}
                    </TD>
                    <TDNumeric className="text-xs">{formatAmount(item.quantity)}</TDNumeric>
                    <TDNumeric className="text-xs">
                      {formatMoney(item.price_at_purchase, data.currency)}
                    </TDNumeric>
                    <TDNumeric className="text-xs">
                      {formatMoney(item.line_total, data.currency)}
                    </TDNumeric>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-end gap-3 border-t border-border bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">Order total</span>
              <span className="tabular text-sm font-semibold">
                {formatMoney(data.total_amount, data.currency)}
              </span>
            </div>
          </div>

          {/* Prices are frozen per line, so the order is a record of what was
              sold at that price rather than a live view of the catalogue. */}
          <p className="text-2xs text-muted-foreground">
            Unit prices are the catalogue prices at the moment the order was placed.
          </p>

          {(data.status_history ?? []).length > 0 ? (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Status history
              </p>
              <ol className="flex flex-col gap-2 border-l border-border pl-3">
                {data.status_history.map((entry, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-2 text-xs">
                    <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-muted-foreground">{entry.from ?? 'Created'}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">{entry.to}</span>
                    <span className="text-2xs text-muted-foreground">
                      {entry.changed_by ?? 'system'} · {formatDateTime(entry.at)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}