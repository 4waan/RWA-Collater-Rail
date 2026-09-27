"use client";

import { useState } from "react";
import { formatUnits, isHex, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { ProofReference } from "@/components/ProofReference";
import { addresses, isLiveMode } from "@/lib/chain";
import {
  atsAbi,
  automationStates,
  DEFAULT_PARTITION,
  positionStates,
  railAbi,
} from "@/lib/contracts";
import {
  isRecord,
  isMirrorTransactionIdentifier,
  readJson,
  RemoteReadError,
  remoteReadMessage,
} from "@/lib/network";
import { presentOracleEvidence } from "@/lib/oracle-evidence";
import { referenceDeployment } from "@/lib/reference";

type PositionSelection = "repaid" | "defaulted";

type LiveEvidence = {
  state: string;
  automation: string;
  lender: string;
  borrower: string;
  collateral: string;
  free: string;
  held: string;
  principal: string;
  repayment: string;
  maturity: string;
  schedule: string;
};

type MirrorFact = {
  result: string;
  consensusTimestamp: string;
  transactionId: string;
};

type VerifyConsoleProps = {
  initialPosition: PositionSelection;
};

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseMirrorPayload(value: unknown, requestedId: string) {
  if (!isRecord(value) || !Array.isArray(value.transactions)) {
    throw new RemoteReadError(
      "malformed",
      "Mirror Node returned an unexpected response shape.",
    );
  }
  if (value.transactions.length === 0) {
    throw new RemoteReadError(
      "empty",
      "Mirror Node returned no matching transaction.",
    );
  }
  if (value.transactions.length > 100) {
    throw new RemoteReadError(
      "size",
      "Mirror Node returned too many transactions.",
    );
  }
  const transactions = value.transactions.filter(isRecord).slice(0, 10);
  const first = transactions[0];
  if (!first) {
    throw new RemoteReadError(
      "malformed",
      "Mirror Node returned no valid transaction object.",
    );
  }
  const result = stringField(first, "result");
  const consensusTimestamp = stringField(first, "consensus_timestamp");
  const transactionId = stringField(first, "transaction_id") ?? requestedId;
  if (
    !result ||
    !consensusTimestamp ||
    !/^\d+\.\d+$/.test(consensusTimestamp) ||
    !isMirrorTransactionIdentifier(transactionId)
  ) {
    throw new RemoteReadError(
      "malformed",
      "Mirror Node omitted required transaction fields.",
    );
  }
  return {
    fact: { result, consensusTimestamp, transactionId },
    raw: { transactions },
  };
}

function boundedError(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 2_000)
    : String(error).slice(0, 2_000);
}

export function VerifyConsole({ initialPosition }: VerifyConsoleProps) {
  const publicClient = usePublicClient();
  const [selection, setSelection] =
    useState<PositionSelection>(initialPosition);
  const [positionId, setPositionId] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [liveEvidence, setLiveEvidence] = useState<LiveEvidence>();
  const [mirrorFact, setMirrorFact] = useState<MirrorFact>();
  const [rawMirror, setRawMirror] = useState<Record<string, unknown>>();
  const [isReadingPosition, setIsReadingPosition] = useState(false);
  const [isReadingMirror, setIsReadingMirror] = useState(false);
  const [technicalError, setTechnicalError] = useState("");
  const [message, setMessage] = useState(
    "Select a terminal path to inspect its claims and sources.",
  );

  const lifecycle = referenceDeployment.lifecycle;
  const position = referenceDeployment.positions.find((candidate) =>
    selection === "repaid"
      ? candidate.state === "REPAID"
      : candidate.state === "DEFAULTED",
  );
  const terminalProof =
    selection === "repaid"
      ? lifecycle.repaidFacility
      : lifecycle.maturedDefault;
  const hold = referenceDeployment.holds.find(
    (candidate) => candidate.positionId === position?.id,
  );
  const oracleEvidence = presentOracleEvidence(referenceDeployment);

  const claims = [
    {
      claim: oracleEvidence.claim,
      source: oracleEvidence.source,
      detail: oracleEvidence.detail,
      proof: oracleEvidence.proof,
    },
    {
      claim: "The lender funded an exact HBAR principal.",
      source: "AtsCollateralRail and Mirror receipt",
      detail: position
        ? `${formatUnits(BigInt(position.principalTinybar), 8)} HBAR`
        : "Awaiting verified publication",
      proof: lifecycle.fundedOffer,
    },
    {
      claim: "ATS collateral entered a distinct native hold.",
      source: "ATS partition hold inspection",
      detail:
        position && hold
          ? `Hold ${position.holdId}, ${position.collateralAmount} units at block ${hold.state.blockNumber}`
          : "Awaiting verified publication",
      proof: lifecycle.holdCreation,
    },
    {
      claim: "An HSS schedule entity was confirmed independently.",
      source: "HSS entity and Mirror Node",
      detail: lifecycle.hssScheduleCreation
        ? lifecycle.hssScheduleCreation.executedTimestamp
          ? `Executed at ${lifecycle.hssScheduleCreation.executedTimestamp}`
          : `Schedule ${lifecycle.hssScheduleCreation.scheduleId}, execution pending`
        : "Awaiting verified publication",
      proof: lifecycle.hssScheduleCreation,
    },
    {
      claim:
        selection === "repaid"
          ? "Repayment released the collateral hold."
          : "Overdue collateral reached one terminal execution.",
      source:
        selection === "repaid"
          ? "Rail state and ATS hold release"
          : !position
            ? "Rail terminal state and ATS hold execution"
            : position.terminalPath === "permissionless-fallback"
              ? "Permissionless fallback and ATS hold execution"
              : "HSS call and ATS hold execution",
      detail: position
        ? `${position.state} via ${position.terminalPath.replaceAll("-", " ")}, observed on testnet`
        : "Awaiting verified publication",
      proof: terminalProof,
    },
    {
      claim: "Final contract state was read at an exact block.",
      source: "Hedera JSON-RPC state proof",
      detail: referenceDeployment.verification.state
        ? `${Object.keys(referenceDeployment.verification.state.assertions).length} assertions`
        : "Awaiting verified publication",
      proof: referenceDeployment.verification.state,
    },
    {
      claim:
        "Dated lifecycle accounting was covered by a current Mirror balance.",
      source: "Hedera Mirror account balance",
      detail: referenceDeployment.verification.balance
        ? `${formatUnits(BigInt(referenceDeployment.verification.balance.balanceTinybar), 8)} HBAR checked ${referenceDeployment.verification.balance.checkedAt}, balance timestamp ${referenceDeployment.verification.balance.balanceTimestamp}`
        : "Awaiting verified publication",
      proof: referenceDeployment.verification.balance,
    },
  ];

  function selectPosition(next: PositionSelection) {
    setSelection(next);
    window.history.replaceState(null, "", `/verify?position=${next}`);
  }

  async function readPosition() {
    if (
      !publicClient ||
      !addresses.rail ||
      !addresses.atsToken ||
      !isHex(positionId) ||
      positionId.length !== 66
    ) {
      setMessage("A live deployment and a 32-byte position ID are required.");
      return;
    }
    setIsReadingPosition(true);
    setLiveEvidence(undefined);
    setTechnicalError("");
    try {
      const id = positionId as Hex;
      const result = await publicClient.readContract({
        address: addresses.rail,
        abi: railAbi,
        functionName: "getPosition",
        args: [id],
      });
      const [free, held] = await Promise.all([
        publicClient.readContract({
          address: addresses.atsToken,
          abi: atsAbi,
          functionName: "balanceOfByPartition",
          args: [DEFAULT_PARTITION, result.borrower],
        }),
        publicClient.readContract({
          address: addresses.atsToken,
          abi: atsAbi,
          functionName: "getHeldAmountForByPartition",
          args: [DEFAULT_PARTITION, result.borrower],
        }),
      ]);
      setLiveEvidence({
        state: positionStates[result.state] ?? `Unknown ${result.state}`,
        automation:
          automationStates[result.automation] ?? `Unknown ${result.automation}`,
        lender: result.lender,
        borrower: result.borrower,
        collateral: result.collateralAmount.toString(),
        free: free.toString(),
        held: held.toString(),
        principal: `${formatUnits(result.principalTinybar, 8)} HBAR`,
        repayment: `${formatUnits(result.repaymentTinybar, 8)} HBAR`,
        maturity: new Date(Number(result.maturity) * 1000).toISOString(),
        schedule: result.scheduleAddress,
      });
      setMessage(
        "Live state loaded. Free and held ATS balances remain separate.",
      );
    } catch (error) {
      setTechnicalError(boundedError(error));
      setMessage(
        /timed out|timeout/i.test(boundedError(error))
          ? "The Hedera state read timed out. Try again."
          : "The Hedera state read failed. Nothing was displayed as verified.",
      );
    } finally {
      setIsReadingPosition(false);
    }
  }

  async function readMirror() {
    if (!isMirrorTransactionIdentifier(transactionId)) {
      setMessage("Enter a Hedera transaction ID or 32-byte transaction hash.");
      return;
    }
    setIsReadingMirror(true);
    setMirrorFact(undefined);
    setRawMirror(undefined);
    setTechnicalError("");
    try {
      const payload = await readJson(
        `https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(transactionId)}`,
        {
          origin: "https://testnet.mirrornode.hedera.com",
          pathPrefix: "/api/v1/transactions/",
          maxBytes: 256_000,
        },
      );
      const parsed = parseMirrorPayload(payload, transactionId);
      setMirrorFact(parsed.fact);
      setRawMirror(parsed.raw);
      setMessage("Mirror facts loaded and parsed from a nonempty result set.");
    } catch (error) {
      setTechnicalError(boundedError(error));
      setMessage(remoteReadMessage(error, "Mirror Node"));
    } finally {
      setIsReadingMirror(false);
    }
  }

  return (
    <div className="proofShell">
      <header className="proofHeader">
        <div>
          <span className="kicker">Financial proof ledger</span>
          <h1>Follow one position from claim to source.</h1>
        </div>
        <div className="positionSwitch" aria-label="Reference position">
          <button
            aria-pressed={selection === "repaid"}
            onClick={() => selectPosition("repaid")}
            type="button"
          >
            Repaid position
          </button>
          <button
            aria-pressed={selection === "defaulted"}
            onClick={() => selectPosition("defaulted")}
            type="button"
          >
            Defaulted position
          </button>
        </div>
      </header>

      <section className="selectedProof" aria-label="Selected position proof">
        <div className="positionIdentity">
          <span>{selection} path</span>
          <b>{position?.id ?? "Reference evidence pending"}</b>
          <small>
            {position
              ? `Hold ${position.holdId} · ${position.automation} automation`
              : referenceDeployment.notice}
          </small>
        </div>

        <ol className="proofClaims">
          {claims.map((item, index) => (
            <li key={item.claim}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{item.claim}</h2>
                <p>{item.detail}</p>
                <small>{item.source}</small>
              </div>
              <ProofReference
                explorerCheckedAt={
                  referenceDeployment.verification.linkAudit.checkedAt
                }
                explorerStatus={
                  referenceDeployment.verification.linkAudit.hashScanStatus
                }
                proof={item.proof}
              />
            </li>
          ))}
        </ol>
      </section>

      <section className="factLedger" aria-label="Separate financial facts">
        <h2>Facts that must not be collapsed</h2>
        <dl>
          <div>
            <dt>Free ATS balance</dt>
            <dd>
              {referenceDeployment.ats
                ? referenceDeployment.ats.balances.borrower.free
                : "Pending"}
            </dd>
          </div>
          <div>
            <dt>Held ATS balance</dt>
            <dd>
              {referenceDeployment.ats
                ? referenceDeployment.ats.balances.borrower.held
                : "Pending"}
            </dd>
          </div>
          <div>
            <dt>{oracleEvidence.label}</dt>
            <dd>{oracleEvidence.value}</dd>
          </div>
          <div>
            <dt>Cash liabilities</dt>
            <dd>
              {referenceDeployment.accounting
                ? `${formatUnits(BigInt(referenceDeployment.accounting.cashLiabilitiesTinybar), 8)} HBAR`
                : "Pending"}
            </dd>
          </div>
          <div>
            <dt>HSS reserve</dt>
            <dd>
              {referenceDeployment.accounting
                ? `${formatUnits(BigInt(referenceDeployment.accounting.reservedAutomationTinybar), 8)} HBAR`
                : "Pending"}
            </dd>
          </div>
          <div>
            <dt>State read block</dt>
            <dd>
              {referenceDeployment.verification.state?.blockNumber ?? "Pending"}
            </dd>
          </div>
          <div>
            <dt>Current rail balance</dt>
            <dd>
              {referenceDeployment.verification.balance
                ? `${formatUnits(BigInt(referenceDeployment.verification.balance.balanceTinybar), 8)} HBAR`
                : "Pending"}
            </dd>
          </div>
        </dl>
        <p>{oracleEvidence.caveat}</p>
      </section>

      <details className="liveVerifier">
        <summary>Verify another live position</summary>
        <div className="liveVerifierGrid">
          <section>
            <h2>Contract state</h2>
            <label className="fieldLabel">
              Position ID
              <input
                value={positionId}
                onChange={(event) => setPositionId(event.target.value)}
                placeholder="0x..."
              />
            </label>
            <button
              className="primaryButton"
              disabled={!isLiveMode || isReadingPosition}
              onClick={readPosition}
              type="button"
            >
              {isReadingPosition ? "Reading state" : "Read contract state"}
            </button>
            {liveEvidence && (
              <dl className="parsedFacts">
                {Object.entries(liveEvidence).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section>
            <h2>Mirror receipt</h2>
            <label className="fieldLabel">
              Transaction ID or hash
              <input
                value={transactionId}
                onChange={(event) => setTransactionId(event.target.value)}
                placeholder="0.0.123-123-456 or 0x..."
              />
            </label>
            <button
              className="primaryButton"
              disabled={isReadingMirror}
              onClick={readMirror}
              type="button"
            >
              {isReadingMirror ? "Reading Mirror" : "Query Mirror Node"}
            </button>
            {mirrorFact && (
              <dl className="parsedFacts">
                {Object.entries(mirrorFact).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {rawMirror && (
              <details className="rawEvidence">
                <summary>Raw Mirror JSON</summary>
                <pre>{JSON.stringify(rawMirror, null, 2).slice(0, 4_000)}</pre>
              </details>
            )}
          </section>
        </div>
      </details>

      <details className="rawEvidence referenceRaw">
        <summary>Raw committed reference record</summary>
        <pre>
          {JSON.stringify(referenceDeployment, null, 2).slice(0, 12_000)}
        </pre>
      </details>

      <div className="statusLine" role="status">
        {message}
      </div>
      {technicalError && (
        <details className="technicalDetails errorDetails">
          <summary>Technical error</summary>
          <pre>{technicalError}</pre>
        </details>
      )}
    </div>
  );
}
