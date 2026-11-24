// The two private `subscriptions/listen` extensions the SDK's own listen router cannot express. Both
// are answered in front of the SDK handler (transports/http.ts), beside the Tasks extension, and
// only for the 2026-07-28 protocol.
//
// Advisory push (`notifications/advisory`): its subscription key and event are not expressible
// through the SDK's own SubscriptionFilter/ServerEvent union. Only intercepted when a bus is wired
// (i.e. experiential.proactive.enabled) AND the client actually asked for advisory notifications.
//
// Resource updates (`notifications/resources/updated`): see mcp/resource-subscriptions.ts.

import type { FolderAcl } from "../acl";
import type { AdvisoryBus } from "../mcp/advisories";
import { serveAdvisorySubscription, subscribesToAdvisories } from "../mcp/advisories";
import type { CallerContext } from "../mcp/registry";
import { serveResourceSubscription, subscribesToResources } from "../mcp/resource-subscriptions";
import { canReadResourceUri } from "../mcp/resources";
import type { VaultRegistry } from "../vault/registry";

export function serveListenExtension(input: {
  body: unknown;
  /** The request's `mcp-protocol-version` header is the 2026-07-28 revision. */
  modern: boolean;
  signal: AbortSignal;
  owner: { vaultId: string; caller: string | null };
  advisoryBus?: AdvisoryBus;
  vaultRegistry?: VaultRegistry;
  aclFor: (vaultId: string) => FolderAcl | undefined;
  /** Called at most once, and only when a resource subscription is served. */
  makeContext: () => CallerContext;
}): Response | undefined {
  const { body, modern, signal, owner, advisoryBus, vaultRegistry, aclFor, makeContext } = input;
  if (advisoryBus && modern && subscribesToAdvisories(body)) {
    return serveAdvisorySubscription(body, advisoryBus, owner, signal);
  }
  if (vaultRegistry && modern && subscribesToResources(body)) {
    // Built once, at subscribe time: contextFromAuthInfo can open a workspace session, so it must
    // not run per event. The ACL is still resolved per event, so an ACL change reaches the stream.
    const ctx = makeContext();
    return serveResourceSubscription(
      body,
      vaultRegistry.changes,
      (uri) => canReadResourceUri(vaultRegistry, ctx, uri, aclFor),
      signal,
    );
  }
  return undefined;
}
