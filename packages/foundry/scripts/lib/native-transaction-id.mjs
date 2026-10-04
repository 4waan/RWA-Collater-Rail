const NATIVE_TRANSACTION_ID_RE = /^(0\.0\.\d+)@(\d+)\.(\d{9})$/u;

export function toMirrorNativeTransactionId(transactionId) {
  const match = NATIVE_TRANSACTION_ID_RE.exec(transactionId ?? "");
  if (!match) throw new Error("Invalid native Hedera transaction ID.");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function toMirrorEvmBaseTransactionPath(consensusTimestamp) {
  if (!/^\d+\.\d{1,9}$/u.test(consensusTimestamp ?? "")) {
    throw new Error("Invalid EVM consensus timestamp.");
  }
  return `/api/v1/transactions?timestamp=${consensusTimestamp}`;
}
