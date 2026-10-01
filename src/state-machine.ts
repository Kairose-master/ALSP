/** Normative ALSP v0.3 lifecycle transitions. All persisted state changes go through these functions. */
export type SessionState = 'PROPOSED' | 'AGREED' | 'ACTIVE' | 'RECONCILIATION_REQUIRED' | 'CLOSED';
export type CallState = 'RESERVED' | 'AUTHORIZED' | 'SUBMITTED' | 'RECONCILIATION_REQUIRED' | 'VERIFIED';
const SESSION: Readonly<Record<SessionState, readonly SessionState[]>> = {
  PROPOSED: ['AGREED'], AGREED: ['ACTIVE', 'CLOSED'], ACTIVE: ['RECONCILIATION_REQUIRED', 'CLOSED'],
  RECONCILIATION_REQUIRED: ['ACTIVE', 'CLOSED'], CLOSED: [],
};
const CALL: Readonly<Record<CallState, readonly CallState[]>> = {
  RESERVED: ['AUTHORIZED', 'RECONCILIATION_REQUIRED'], AUTHORIZED: ['SUBMITTED', 'RECONCILIATION_REQUIRED'],
  SUBMITTED: ['RECONCILIATION_REQUIRED', 'VERIFIED'], RECONCILIATION_REQUIRED: ['VERIFIED'], VERIFIED: [],
};
export function transitionSession(from: SessionState, to: SessionState): SessionState {
  if (!SESSION[from]?.includes(to)) throw new Error(`Forbidden session transition: ${from} -> ${to}`);
  return to;
}
export function transitionCall(from: CallState, to: CallState): CallState {
  if (!CALL[from]?.includes(to)) throw new Error(`Forbidden call transition: ${from} -> ${to}`);
  return to;
}
