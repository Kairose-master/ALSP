/** Shared vocabulary for ALSP profiles. These types carry no payment or registry assumptions. */
export interface SessionReference {
  sessionId: string;
  termsHash: string;
}

export interface OperationReference extends SessionReference {
  operationId: string;
  sequence: number;
  previousHead: string;
}

export interface SessionReceipt extends OperationReference {
  receiptHash: string;
  evidence: readonly EvidenceReference[];
}

export interface EvidenceReference {
  kind: string;
  digest: string;
  uri?: string;
}
