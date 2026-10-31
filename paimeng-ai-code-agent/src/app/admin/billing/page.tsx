import { BillingManager } from '@/components/billing/billing-manager';
import { ReconcilePanel } from '@/components/billing/reconcile-panel';

export default function Billing() {
  return <>
    <BillingManager />
    <ReconcilePanel />
  </>;
}
