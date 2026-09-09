// GEOGLOWS account slot for the control column.
//
// The library ships a vanilla bootstrap that renders itself into a DOM slot
// (`#auth-action`) and re-queries that slot only when auth state changes, so it
// drops into a React app as long as it is bootstrapped after the div exists.
// Sidebar calls this from an effect for that reason.
//
// One handle at a time, rebuilt on every mount. An earlier version kept a
// create-once singleton to avoid churn under StrictMode's double mount; that
// was wrong. React hands a remount a brand new, empty div, and a handle that
// has already rendered has no reason to render again — so the slot stayed empty
// after every hot reload.
import { bootstrapAuth } from '@geoglows/geoglows-auth/bootstrap';
import '@geoglows/geoglows-auth/core/sign-in.css';

type AuthHandle = ReturnType<typeof bootstrapAuth>;

let handle: AuthHandle | null = null;

export function mountGeoglowsAuth(): AuthHandle | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    console.warn('[auth] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set — sign-in disabled');
    return null;
  }

  // Tear down whatever came before, so a remount that skipped its cleanup
  // (or a hot reload of this module) doesn't leave two handles listening.
  handle?.destroy();

  handle = bootstrapAuth({
    supabaseUrl: url,
    supabasePublishableKey: key,
    portalUrl: import.meta.env.VITE_PORTAL_URL || '',
    // Auth is never on the critical path here — every region, chart and raster
    // works signed out — so an unreachable account service becomes a retry icon
    // rather than a page that keeps trying for the length of a session.
    connect: { attempts: 2, timeoutMs: 10_000, giveUpMs: 60_000, recheckAfterMs: 300_000 },
    onConnectState: ({ phase, reason, attempt, error }) => {
      if (phase === 'connected') return;
      console.debug(`[auth] ${phase} (${reason}, attempt ${attempt})`, error ?? '');
    },
  });
  return handle;
}

export function unmountGeoglowsAuth(): void {
  handle?.destroy();
  handle = null;
}

// The Supabase user id, or null when signed out. The library's AuthUser carries
// it as `sub` (a JWT claim), not `id`.
export const userId = () => handle?.getState().user?.sub ?? null;
