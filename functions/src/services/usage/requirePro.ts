import { ApiRouteError } from '@/lib/apiResponse';
import { getUserEntitlement, type Entitlement } from './entitlement';

/**
 * Gate for CalHow Pro-only endpoints (AI meal insights, menu scanner).
 * Same entitlement source as the scan quota — RevenueCat, verified
 * server-side, never a client claim — and the same fail-closed policy (a
 * RevenueCat outage reads as 'free'; see entitlement.ts).
 */
export async function assertPro(uid: string, getEntitlement: (uid: string) => Promise<Entitlement> = getUserEntitlement): Promise<void> {
  if ((await getEntitlement(uid)) !== 'pro') {
    throw new ApiRouteError('pro_required', 'This feature is part of CalHow Pro.');
  }
}
