import type { RpcSession } from "./session.ts";

// Local-only owner token. It contains no connection details and is never sent
// over the wire or written with cached projections.
const sessionOwners = new WeakMap<RpcSession, object>();

export function rpcSessionOwner(session: RpcSession): object {
  const existing = sessionOwners.get(session);
  if (existing) return existing;
  const owner = Object.freeze({});
  sessionOwners.set(session, owner);
  return owner;
}
