import {
  isScheduleProof,
  isStateProof,
  isTransactionProof,
  safeMirrorLink,
  type ReferenceProof,
  safeHashScanLink,
} from "@/lib/proofs";

type ProofReferenceProps = {
  proof: ReferenceProof | null | undefined;
  explorerCheckedAt?: string | null;
  explorerStatus?: "available" | "mixed" | "unavailable" | "unchecked";
};

function ExplorerSource({
  checkedAt,
  href,
  label,
  status = "unchecked",
}: {
  checkedAt?: string | null;
  href: string | undefined;
  label: string;
  status?: ProofReferenceProps["explorerStatus"];
}) {
  if (!href)
    return <b className="proofInvalid">Invalid explorer link omitted</b>;
  const checkedDate = checkedAt?.slice(0, 10);
  return (
    <div className="explorerSource" data-explorer-status={status}>
      {status === "unavailable" && (
        <small className="proofUnavailable" role="status">
          HashScan was unavailable{checkedDate ? ` on ${checkedDate}` : ""}.
          Mirror evidence remains authoritative.
        </small>
      )}
      {status === "mixed" && (
        <small className="proofUnavailable" role="status">
          Some HashScan links were unavailable
          {checkedDate ? ` on ${checkedDate}` : ""}. Mirror evidence remains
          authoritative.
        </small>
      )}
      {status === "unchecked" && (
        <small>HashScan availability is not part of proof verification.</small>
      )}
      <a
        className="proofLink proofLinkSecondary"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {status === "unavailable" ? `Retry ${label}` : `Open ${label}`}
      </a>
    </div>
  );
}

export function ProofReference({
  proof,
  explorerCheckedAt,
  explorerStatus,
}: ProofReferenceProps) {
  if (!proof) return <b className="proofPending">Proof pending</b>;

  if (isTransactionProof(proof)) {
    return (
      <div className="typedProof" data-proof-type="transaction">
        <span>Transaction receipt</span>
        <small>
          {proof.result} at {proof.consensusTimestamp}
        </small>
        <a
          className="proofLink"
          href={safeMirrorLink(proof.mirror, "transaction")}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open authoritative Mirror receipt
        </a>
        <ExplorerSource
          checkedAt={explorerCheckedAt}
          href={safeHashScanLink(proof.hashScan, "transaction")}
          label="transaction on HashScan"
          status={explorerStatus}
        />
      </div>
    );
  }

  if (isScheduleProof(proof)) {
    return (
      <div className="typedProof" data-proof-type="schedule">
        <span>HSS schedule</span>
        <small>
          {proof.scheduleId}
          {proof.executedTimestamp
            ? ` executed at ${proof.executedTimestamp}`
            : " execution pending"}
        </small>
        <a
          className="proofLink"
          href={safeMirrorLink(proof.mirror, "schedule")}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open authoritative Mirror schedule
        </a>
        <ExplorerSource
          checkedAt={explorerCheckedAt}
          href={safeHashScanLink(proof.hashScan, "schedule")}
          label="schedule on HashScan"
          status={explorerStatus}
        />
      </div>
    );
  }

  if (isStateProof(proof)) {
    return (
      <div className="typedProof" data-proof-type="state">
        <span>Verified contract state</span>
        <small>
          Block {proof.blockNumber} via {proof.rpcOrigin}
        </small>
      </div>
    );
  }

  return <b className="proofInvalid">Invalid proof omitted</b>;
}
