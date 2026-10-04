"use client";

import { useMemo, useState } from "react";
import {
  formatUnits,
  isAddress,
  isHex,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import {
  facilityRecipes,
  getRecipe,
  type FacilityRecipe,
} from "@collateral-rail/shared/recipes";
import { tinybarToWeibar } from "@collateral-rail/shared/hedera";
import { FacilityStep } from "@/components/FacilityStep";
import { ProofReference } from "@/components/ProofReference";
import {
  addresses,
  HEDERA_TESTNET_CHAIN_ID,
  isLiveMode,
  oracleKind,
} from "@/lib/chain";
import { atsAbi, oracleAbi, pythAbi, railAbi } from "@/lib/contracts";
import {
  isRecord,
  readJson,
  RemoteReadError,
  remoteReadMessage,
} from "@/lib/network";
import { hashScanTransaction } from "@/lib/proofs";
import { presentOracleEvidence } from "@/lib/oracle-evidence";
import { referenceDeployment } from "@/lib/reference";

const PRICE_ID =
  "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";

const automationOutcomeAbi = [
  {
    type: "event",
    name: "AutomationReserved",
    inputs: [
      { indexed: true, name: "positionId", type: "bytes32" },
      { indexed: true, name: "scheduleAddress", type: "address" },
      { indexed: false, name: "executionSecond", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "AutomationUnavailable",
    inputs: [{ indexed: true, name: "positionId", type: "bytes32" }],
  },
] as const;

const steps = [
  ["Choose recipe", "Read only"],
  ["Set terms", "Lender"],
  ["Price and fund", "Lender"],
  ["Approve and lock", "Borrower"],
  ["Repay or settle", "Borrower or any account"],
  ["Withdraw credit", "Lender or borrower"],
] as const;

type Preview = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type Mode = "reference" | "live";

type FacilityConsoleProps = {
  initialMode: Mode;
  initialOfferId: string;
  initialPositionId: string;
  initialRecipeId: string;
  initialTerminalChoice: "repay" | "settle";
};

type ActionState = "idle" | "signature" | "mining" | "success" | "error";

type QueryState = {
  mode: Mode;
  offer: string;
  position: string;
  recipe: string;
  terminal: "repay" | "settle";
};

function hbar(tinybar: bigint) {
  return `${formatUnits(tinybar, 8)} HBAR`;
}

const ERROR_GUIDANCE: Record<string, string> = {
  AutomationFundsLocked:
    "Reserved HSS funds cannot be withdrawn while a position still depends on them.",
  BeyondAssetMaturity:
    "The facility would outlive the ATS asset. Shorten the term before retrying.",
  ConfidenceTooWide:
    "The Pyth confidence band is too wide. Wait for a healthier quote before retrying.",
  HoldCallFailed:
    "ATS could not create or release the hold. Confirm roles, KYC, allowance, and free balance.",
  IncorrectFunding:
    "The HBAR amount no longer matches the preview. Refresh the quote before funding.",
  IncorrectUpdateFee:
    "The Pyth update fee changed. Fetch a new Hermes payload and retry.",
  InsufficientAllowance:
    "The borrower must approve enough ATS collateral for this rail before acceptance.",
  InsufficientCollateralCoverage:
    "The requested principal exceeds the configured collateral advance ceiling.",
  InsufficientFreeBalance:
    "The borrower does not have enough free ATS units. Held units cannot be reused.",
  Insolvent:
    "The action would violate the rail solvency invariant, so it was rejected.",
  InvalidPrice:
    "Pyth did not return a positive HBAR price. Wait for a valid update before retrying.",
  InvalidTerms:
    "The facility terms fall outside the deployed rail policy. Review amount, rate, term, and expiry.",
  InvalidHold:
    "ATS returned a hold that did not match the required amount, parties, partition, or expiry.",
  KycRequired:
    "Both counterparties need active ATS KYC before this action can succeed.",
  NativeTransferFailed:
    "The HBAR credit transfer failed. The credit remains available for a later withdrawal.",
  NotBorrower: "Connect the borrower wallet for this action.",
  NotLender: "Connect the lender wallet for this action.",
  NotMatured:
    "This position is not overdue yet. Wait until maturity before permissionless settlement.",
  NothingToWithdraw: "This wallet has no HBAR credit available to withdraw.",
  OfferExpired: "This offer has expired. The lender must fund a new offer.",
  OfferNotFound: "No active funded offer matches that offer ID.",
  PositionNotOpen: "That position is already terminal or does not exist.",
  QuoteMoved:
    "The HBAR quote moved beyond policy. Preview the offer again before acceptance.",
  SelfDealing: "The lender and borrower must be different Hedera accounts.",
  StalePrice:
    "The stored Pyth price is stale. Submit a fresh Hermes update, then retry.",
};

function rawError(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return String(error).slice(0, 2_000);
}

function actionError(error: unknown) {
  const technical = rawError(error);
  const coded = error as {
    code?: number;
    name?: string;
    shortMessage?: string;
  };
  if (error instanceof RemoteReadError) {
    return {
      message: remoteReadMessage(error, "Hermes"),
      technical,
    };
  }
  if (
    coded.code === 4001 ||
    coded.name === "UserRejectedRequestError" ||
    /user rejected|user denied/i.test(technical)
  ) {
    return {
      message: "The wallet signature was rejected. No workflow state changed.",
      technical,
    };
  }
  if (/timed out|timeout/i.test(technical)) {
    return {
      message:
        "Confirmation timed out. Check the transaction receipt before retrying.",
      technical,
    };
  }
  for (const [name, message] of Object.entries(ERROR_GUIDANCE)) {
    if (technical.includes(name)) return { message, technical };
  }
  if (/revert|reverted/i.test(technical)) {
    return {
      message:
        "The transaction reverted. No step was advanced. Review the technical error for the contract reason.",
      technical,
    };
  }
  return {
    message: coded.shortMessage ?? "The transaction could not be confirmed.",
    technical,
  };
}

function policyLine(recipe: FacilityRecipe) {
  return `${recipe.policy.maximumAdvanceBps / 100}% advance · ${recipe.policy.maximumAnnualRateBps / 100}% maximum APR · ${recipe.policy.maximumTermSeconds}s maximum term`;
}

function sameAddress(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function receiptId(
  receipt: TransactionReceipt,
  eventName: "OfferFunded" | "PositionOpened",
) {
  const events = parseEventLogs({
    abi: railAbi,
    eventName,
    logs: receipt.logs,
    strict: true,
  });
  if (events.length !== 1) {
    throw new Error(
      `The confirmed receipt contained ${events.length} ${eventName} events instead of one.`,
    );
  }
  const args = events[0].args as { offerId?: Hex; positionId?: Hex };
  const id = eventName === "OfferFunded" ? args.offerId : args.positionId;
  if (!id || !isHex(id) || id.length !== 66) {
    throw new Error(`${eventName} did not contain a valid identifier.`);
  }
  return id;
}

function automationReceiptMessage(receipt: TransactionReceipt) {
  const events = parseEventLogs({
    abi: automationOutcomeAbi,
    logs: receipt.logs,
    strict: true,
  });
  if (events.some((event) => event.eventName === "AutomationReserved")) {
    return "Offer acceptance is confirmed and an HSS maturity schedule is reserved.";
  }
  if (events.some((event) => event.eventName === "AutomationUnavailable")) {
    return "Offer acceptance is confirmed. HSS was unavailable, so permissionless settlement remains the fallback.";
  }
  return "Offer acceptance is confirmed. Check the position state for its automation outcome.";
}

function hermesPayload(value: unknown): Hex[] {
  if (!isRecord(value) || !isRecord(value.binary)) {
    throw new RemoteReadError(
      "malformed",
      "Hermes returned an unexpected response shape.",
    );
  }
  const values = value.binary.data;
  if (!Array.isArray(values)) {
    throw new RemoteReadError(
      "malformed",
      "Hermes omitted its binary update array.",
    );
  }
  if (values.length === 0) {
    throw new RemoteReadError("empty", "Hermes returned no update payload.");
  }
  if (values.length > 8) {
    throw new RemoteReadError("size", "Hermes returned too many updates.");
  }
  return values.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 64_000 ||
      entry.length % 2 !== 0 ||
      !/^[a-fA-F0-9]+$/.test(entry)
    ) {
      throw new RemoteReadError(
        typeof entry === "string" && entry.length > 64_000
          ? "size"
          : "malformed",
        "Hermes returned invalid update bytes.",
      );
    }
    return `0x${entry}` as Hex;
  });
}

export function FacilityConsole({
  initialMode,
  initialOfferId,
  initialPositionId,
  initialRecipeId,
  initialTerminalChoice,
}: FacilityConsoleProps) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [mode, setModeState] = useState<Mode>(initialMode);
  const [recipe, setRecipeState] = useState(() => getRecipe(initialRecipeId));
  const [activeStep, setActiveStep] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [borrower, setBorrower] = useState("");
  const [collateral, setCollateral] = useState(
    recipe.defaultTerms.collateralAmount,
  );
  const [principalUsd, setPrincipalUsd] = useState(
    recipe.defaultTerms.principalUsd,
  );
  const [rateBps, setRateBps] = useState(
    String(recipe.defaultTerms.annualRateBps),
  );
  const [termSeconds, setTermSeconds] = useState(
    String(recipe.defaultTerms.termSeconds),
  );
  const [offerId, setOfferId] = useState(initialOfferId);
  const [positionId, setPositionId] = useState(initialPositionId);
  const [lender, setLender] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [allowanceSubmitted, setAllowanceSubmitted] = useState(false);
  const [terminalChoice, setTerminalChoiceState] = useState<"repay" | "settle">(
    initialTerminalChoice,
  );
  const [message, setMessage] = useState(() =>
    initialMode === "reference"
      ? "Reference mode is ready. No wallet or secret is required."
      : isLiveMode
        ? "Live mode is ready for a Hedera testnet wallet."
        : "Live mode is unavailable until public deployment addresses are configured.",
  );
  const [transactionHash, setTransactionHash] = useState<Hex>();
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [technicalError, setTechnicalError] = useState("");
  const oracleEvidence = presentOracleEvidence(referenceDeployment);

  const terms = useMemo(() => {
    if (!isAddress(borrower)) return undefined;
    try {
      return {
        borrower: borrower as Address,
        collateralAmount: BigInt(collateral),
        principalUsdE8: parseUnits(principalUsd, 8),
        annualRateBps: Number(rateBps),
        termSeconds: BigInt(termSeconds),
        offerExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      } as const;
    } catch {
      return undefined;
    }
  }, [borrower, collateral, principalUsd, rateBps, termSeconds]);

  const canRead = mode === "live" && isLiveMode && Boolean(publicClient);
  const correctChain = chainId === HEDERA_TESTNET_CHAIN_ID;
  const canWrite =
    canRead && isConnected && correctChain && Boolean(address) && !isPending;
  const actionBusy =
    isPending || actionState === "signature" || actionState === "mining";
  const borrowerSigner = sameAddress(address, borrower);
  const lenderSigner = !lender || sameAddress(address, lender);

  function validBytes32(value: string): value is Hex {
    return isHex(value) && value.length === 66;
  }

  function replaceUrl(next: Partial<QueryState> = {}) {
    const state: QueryState = {
      mode: next.mode ?? mode,
      offer: next.offer ?? offerId,
      position: next.position ?? positionId,
      recipe: next.recipe ?? recipe.id,
      terminal: next.terminal ?? terminalChoice,
    };
    const params = new URLSearchParams();
    params.set("recipe", getRecipe(state.recipe).id);
    params.set("mode", state.mode === "live" ? "live" : "reference");
    if (validBytes32(state.offer)) params.set("offer", state.offer);
    if (validBytes32(state.position)) params.set("position", state.position);
    params.set("terminal", state.terminal === "settle" ? "settle" : "repay");
    window.history.replaceState(null, "", `/facility?${params.toString()}`);
  }

  function updateOfferId(value: string) {
    setOfferId(value);
    replaceUrl({ offer: value });
  }

  function updatePositionId(value: string) {
    setPositionId(value);
    replaceUrl({ position: value });
  }

  function setTerminalChoice(value: "repay" | "settle") {
    setTerminalChoiceState(value);
    replaceUrl({ terminal: value });
  }

  function setMode(nextMode: Mode) {
    setModeState(nextMode);
    setActiveStep(0);
    setActionState("idle");
    setTechnicalError("");
    setMessage(
      nextMode === "reference"
        ? "Reference mode is ready. No wallet or secret is required."
        : isLiveMode
          ? "Live mode is ready for a Hedera testnet wallet."
          : "Live mode is unavailable until public deployment addresses are configured.",
    );
    replaceUrl({ mode: nextMode });
  }

  function chooseRecipe(id: string) {
    const next = getRecipe(id);
    setRecipeState(next);
    setCollateral(next.defaultTerms.collateralAmount);
    setPrincipalUsd(next.defaultTerms.principalUsd);
    setRateBps(String(next.defaultTerms.annualRateBps));
    setTermSeconds(String(next.defaultTerms.termSeconds));
    setPreview(undefined);
    setCompleted(new Set());
    replaceUrl({ recipe: next.id });
  }

  function finishStep(
    step: number,
    next = Math.min(step + 1, steps.length - 1),
  ) {
    setCompleted((current) => new Set(current).add(step));
    setActiveStep(next);
    window.requestAnimationFrame(() => {
      document.getElementById(`facility-step-${next}`)?.focus();
    });
  }

  async function run(
    label: string,
    action: () => Promise<Hex>,
    onReceipt?: (receipt: TransactionReceipt) => string | void,
  ) {
    if (!publicClient || !canWrite) {
      setActionState("error");
      setMessage(
        !correctChain
          ? "Switch the connected wallet to Hedera testnet before signing."
          : "Connect a wallet before submitting this transaction.",
      );
      return;
    }
    try {
      setTechnicalError("");
      setActionState("signature");
      setMessage(`${label} is waiting for a wallet signature.`);
      const hash = await action();
      setTransactionHash(hash);
      setActionState("mining");
      setMessage(`${label} was submitted. Waiting for a mined receipt.`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        throw new Error(`${label} reverted in its mined receipt.`);
      }
      const receiptMessage = onReceipt?.(receipt);
      setActionState("success");
      setMessage(receiptMessage ?? `${label} is confirmed on Hedera testnet.`);
    } catch (error) {
      const described = actionError(error);
      setActionState("error");
      setMessage(described.message);
      setTechnicalError(described.technical);
    }
  }

  async function switchToTestnet() {
    try {
      setTechnicalError("");
      await switchChainAsync({ chainId: HEDERA_TESTNET_CHAIN_ID });
      setMessage("The wallet is connected to Hedera testnet.");
    } catch (error) {
      const described = actionError(error);
      setActionState("error");
      setMessage(described.message);
      setTechnicalError(described.technical);
    }
  }

  async function quote() {
    if (!publicClient || !addresses.rail || !terms) {
      setMessage(
        "Enter a valid borrower and terms. Public live addresses are also required.",
      );
      return;
    }
    try {
      setTechnicalError("");
      const result = await publicClient.readContract({
        address: addresses.rail,
        abi: railAbi,
        functionName: "previewOffer",
        args: [terms],
      });
      setPreview(result);
      setMessage(
        oracleKind === "pyth"
          ? "Quote read from the rail using its validated Pyth price."
          : "Quote read from the rail using Hedera's HIP-475 settlement conversion rate.",
      );
    } catch (error) {
      const described = actionError(error);
      setMessage(described.message);
      setTechnicalError(described.technical);
    }
  }

  async function updatePyth() {
    if (!publicClient || !addresses.oracle) return;
    const oracleAddress = addresses.oracle;
    await run("Pyth update", async () => {
      const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PRICE_ID.slice(2)}&encoding=hex`;
      const payload = await readJson(url, {
        origin: "https://hermes.pyth.network",
        pathPrefix: "/v2/updates/price/latest",
        maxBytes: 192_000,
      });
      const updateData = hermesPayload(payload);
      const fee = await publicClient.readContract({
        address: addresses.pyth,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [updateData],
      });
      return writeContractAsync({
        address: oracleAddress,
        abi: oracleAbi,
        functionName: "updatePrice",
        args: [updateData],
        value: tinybarToWeibar(fee),
      });
    });
  }

  async function fund() {
    if (!addresses.rail || !terms || !preview || !address) return;
    await run(
      "Offer funding",
      () =>
        writeContractAsync({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "fundOffer",
          args: [terms],
          value: tinybarToWeibar(preview[1]),
        }),
      (receipt) => {
        const confirmedOfferId = receiptId(receipt, "OfferFunded");
        setLender(address);
        updateOfferId(confirmedOfferId);
        finishStep(2);
      },
    );
  }

  async function approve() {
    if (!addresses.atsToken || !addresses.rail) return;
    await run(
      "ATS allowance",
      () =>
        writeContractAsync({
          address: addresses.atsToken!,
          abi: atsAbi,
          functionName: "approve",
          args: [addresses.rail!, BigInt(collateral)],
        }),
      () => setAllowanceSubmitted(true),
    );
  }

  function validOfferId(): Hex | undefined {
    return validBytes32(offerId) ? offerId : undefined;
  }

  function validPositionId(): Hex | undefined {
    return validBytes32(positionId) ? positionId : undefined;
  }

  async function accept() {
    const id = validOfferId();
    if (!addresses.rail || !id) return;
    await run(
      "Offer acceptance",
      () =>
        writeContractAsync({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "acceptOffer",
          args: [id],
        }),
      (receipt) => {
        updatePositionId(receiptId(receipt, "PositionOpened"));
        finishStep(3);
        return automationReceiptMessage(receipt);
      },
    );
  }

  async function cancel() {
    const id = validOfferId();
    if (!addresses.rail || !id) return;
    await run("Offer cancellation", () =>
      writeContractAsync({
        address: addresses.rail!,
        abi: railAbi,
        functionName: "cancelOffer",
        args: [id],
      }),
    );
  }

  async function repay() {
    const id = validPositionId();
    if (!addresses.rail || !id || !publicClient) return;
    await run(
      "Repayment",
      async () => {
        const position = await publicClient.readContract({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "getPosition",
          args: [id],
        });
        return writeContractAsync({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "repay",
          args: [id],
          value: tinybarToWeibar(position.repaymentTinybar),
        });
      },
      () => finishStep(4),
    );
  }

  async function settle() {
    const id = validPositionId();
    if (!addresses.rail || !id) return;
    await run(
      "Permissionless settlement",
      () =>
        writeContractAsync({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "settle",
          args: [id],
        }),
      () => finishStep(4),
    );
  }

  async function withdraw() {
    if (!addresses.rail) return;
    await run(
      "Credit withdrawal",
      () =>
        writeContractAsync({
          address: addresses.rail!,
          abi: railAbi,
          functionName: "withdraw",
        }),
      () => finishStep(5),
    );
  }

  function referenceBody(step: number) {
    const selectedPosition = referenceDeployment.positions.find((candidate) =>
      terminalChoice === "settle"
        ? candidate.state === "DEFAULTED"
        : candidate.state === "REPAID",
    );
    const lifecycle = referenceDeployment.lifecycle;
    const primaryProof =
      step === 2
        ? lifecycle.fundedOffer
        : step === 3
          ? lifecycle.holdCreation
          : step === 4
            ? terminalChoice === "repay"
              ? lifecycle.repaidFacility
              : lifecycle.maturedDefault
            : step === 5
              ? lifecycle.liveConfigurationRead
              : null;
    const supportingProof =
      step === 2
        ? oracleEvidence.proof
        : step === 4 && terminalChoice === "settle"
          ? lifecycle.hssScheduleCreation
          : null;

    return (
      <div className="referenceStep">
        {step === 0 && (
          <>
            <label className="fieldLabel">
              Financing recipe
              <select
                value={recipe.id}
                onChange={(event) => chooseRecipe(event.target.value)}
              >
                {facilityRecipes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <p>{recipe.purpose}</p>
          </>
        )}
        <p>
          {referenceDeployment.status === "verified"
            ? "This step is reconstructed from the committed Hedera testnet record."
            : referenceDeployment.notice}
        </p>
        {step === 1 && <p className="monoLine">{policyLine(recipe)}</p>}
        {step === 2 && (
          <dl className="proofMiniLedger">
            <div>
              <dt>{oracleEvidence.label}</dt>
              <dd>{oracleEvidence.value}</dd>
            </div>
            <div>
              <dt>Cash leg</dt>
              <dd>Exact tinybar</dd>
            </div>
          </dl>
        )}
        {step === 3 && (
          <p className="monoLine">
            {selectedPosition
              ? `ATS hold ${selectedPosition.holdId} · ${selectedPosition.collateralAmount} units`
              : "ATS hold proof pending"}
          </p>
        )}
        {step === 4 && (
          <div className="choiceRow" role="group" aria-label="Terminal path">
            <button
              aria-pressed={terminalChoice === "repay"}
              onClick={() => setTerminalChoice("repay")}
              type="button"
            >
              Repaid path
            </button>
            <button
              aria-pressed={terminalChoice === "settle"}
              onClick={() => setTerminalChoice("settle")}
              type="button"
            >
              Default path
            </button>
          </div>
        )}
        {step === 5 && (
          <p className="monoLine">
            Cash liabilities and HSS reserves are proven as separate balances.
          </p>
        )}
        {supportingProof && (
          <ProofReference
            explorerCheckedAt={
              referenceDeployment.verification.linkAudit.checkedAt
            }
            explorerStatus={
              referenceDeployment.verification.linkAudit.hashScanStatus
            }
            proof={supportingProof}
          />
        )}
        {step >= 2 && (
          <ProofReference
            explorerCheckedAt={
              referenceDeployment.verification.linkAudit.checkedAt
            }
            explorerStatus={
              referenceDeployment.verification.linkAudit.hashScanStatus
            }
            proof={primaryProof}
          />
        )}
        <button
          className="primaryButton"
          onClick={() => finishStep(step)}
          type="button"
        >
          {step === steps.length - 1 ? "Replay complete" : "Continue"}
        </button>
      </div>
    );
  }

  function expectedActor(step: number) {
    if (step === 0) return "Read only";
    if (step === 1) return "Lender configures the terms";
    if (step === 2) {
      return lender ? `Lender ${shortAddress(lender)}` : "Funding lender";
    }
    if (step === 3) {
      return isAddress(borrower)
        ? `Borrower ${shortAddress(borrower)}`
        : "Configured borrower";
    }
    if (step === 4) {
      return terminalChoice === "repay"
        ? isAddress(borrower)
          ? `Borrower ${shortAddress(borrower)}`
          : "Configured borrower"
        : "Any testnet account after maturity";
    }
    return "Wallet with available credit";
  }

  function actorLine(step: number) {
    return (
      <p className="actorLine">
        Expected actor: <b>{expectedActor(step)}</b>
        {address
          ? ` · Connected ${shortAddress(address)}`
          : " · No wallet connected"}
      </p>
    );
  }

  function liveBody(step: number) {
    if (step === 0) {
      return (
        <>
          <label className="fieldLabel">
            Financing recipe
            <select
              value={recipe.id}
              onChange={(event) => chooseRecipe(event.target.value)}
            >
              {facilityRecipes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <p>{recipe.purpose}</p>
          <p className="monoLine">{policyLine(recipe)}</p>
          {actorLine(step)}
          <button
            className="primaryButton"
            onClick={() => finishStep(0)}
            type="button"
          >
            Use this recipe
          </button>
        </>
      );
    }

    if (step === 1) {
      return (
        <>
          {actorLine(step)}
          <div className="compactForm">
            <label className="fieldLabel wide">
              Borrower address
              <input
                value={borrower}
                onChange={(event) => {
                  setBorrower(event.target.value);
                  setPreview(undefined);
                }}
                placeholder="0x..."
              />
            </label>
            <label className="fieldLabel">
              Collateral units
              <input
                inputMode="numeric"
                value={collateral}
                onChange={(event) => {
                  setCollateral(event.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <label className="fieldLabel">
              Principal, USD
              <input
                inputMode="decimal"
                value={principalUsd}
                onChange={(event) => {
                  setPrincipalUsd(event.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <label className="fieldLabel">
              Annual rate, bps
              <input
                inputMode="numeric"
                value={rateBps}
                onChange={(event) => {
                  setRateBps(event.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <label className="fieldLabel">
              Term, seconds
              <input
                inputMode="numeric"
                value={termSeconds}
                onChange={(event) => {
                  setTermSeconds(event.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
          </div>
          <button
            className="primaryButton"
            disabled={!terms}
            onClick={() => finishStep(1)}
            type="button"
          >
            Apply terms
          </button>
        </>
      );
    }

    if (step === 2) {
      return (
        <>
          {actorLine(step)}
          <p>
            {oracleKind === "pyth"
              ? "Pyth converts the USD cash terms into exact tinybar. It does not value the ATS security."
              : "HIP-475 converts the USD cash terms using Hedera's active network settlement conversion rate. It is not a live market price or an ATS security valuation."}
          </p>
          {preview && (
            <dl className="proofMiniLedger">
              <div>
                <dt>Principal</dt>
                <dd>{hbar(preview[1])}</dd>
              </div>
              <div>
                <dt>Repayment</dt>
                <dd>{hbar(preview[2])}</dd>
              </div>
              <div>
                <dt>HBAR/USD</dt>
                <dd>${formatUnits(preview[4], 8)}</dd>
              </div>
            </dl>
          )}
          <button
            className="primaryButton"
            disabled={
              !terms ||
              actionBusy ||
              (preview ? !canWrite || sameAddress(address, borrower) : !canRead)
            }
            onClick={preview ? fund : quote}
            type="button"
          >
            {preview ? "Fund exact HBAR" : "Preview offer"}
          </button>
          <details className="technicalDetails">
            <summary>Technical details</summary>
            {oracleKind === "pyth" ? (
              <>
                <p>
                  If the stored quote is stale, submit a fresh Hermes payload
                  before previewing again.
                </p>
                <button
                  className="secondaryButton"
                  disabled={!canWrite || actionBusy}
                  onClick={updatePyth}
                  type="button"
                >
                  Update Pyth
                </button>
              </>
            ) : (
              <p>
                The adapter reads system contract 0x168. HIP-475 supplies the
                active network settlement conversion rate without a publisher
                timestamp or confidence band.
              </p>
            )}
          </details>
        </>
      );
    }

    if (step === 3) {
      return (
        <>
          {actorLine(step)}
          <label className="fieldLabel">
            Offer ID
            <input
              value={offerId}
              onChange={(event) => updateOfferId(event.target.value)}
              placeholder="0x + 64 hex characters"
            />
          </label>
          <p>
            The ATS hold is read back after creation. Amount, escrow,
            destination, partition, and expiry must match.
          </p>
          <button
            className="primaryButton"
            disabled={
              !canWrite ||
              !borrowerSigner ||
              actionBusy ||
              (allowanceSubmitted && !validOfferId())
            }
            onClick={allowanceSubmitted ? accept : approve}
            type="button"
          >
            {allowanceSubmitted
              ? "Accept and lock collateral"
              : "Approve ATS collateral"}
          </button>
          <details className="technicalDetails">
            <summary>Technical details</summary>
            <button
              className="secondaryButton"
              disabled={
                !canWrite || !lenderSigner || !validOfferId() || actionBusy
              }
              onClick={cancel}
              type="button"
            >
              Cancel funded offer
            </button>
          </details>
        </>
      );
    }

    if (step === 4) {
      return (
        <>
          {actorLine(step)}
          <label className="fieldLabel">
            Position ID
            <input
              value={positionId}
              onChange={(event) => updatePositionId(event.target.value)}
              placeholder="0x + 64 hex characters"
            />
          </label>
          <div className="choiceRow" role="group" aria-label="Terminal action">
            <button
              aria-pressed={terminalChoice === "repay"}
              onClick={() => setTerminalChoice("repay")}
              type="button"
            >
              Repay and release
            </button>
            <button
              aria-pressed={terminalChoice === "settle"}
              onClick={() => setTerminalChoice("settle")}
              type="button"
            >
              Settle overdue
            </button>
          </div>
          <button
            className="primaryButton"
            disabled={
              !canWrite ||
              !validPositionId() ||
              actionBusy ||
              (terminalChoice === "repay" && !borrowerSigner)
            }
            onClick={terminalChoice === "repay" ? repay : settle}
            type="button"
          >
            Submit terminal action
          </button>
          <details className="technicalDetails">
            <summary>Technical details</summary>
            <p>
              HSS improves timing. Public settlement remains the correctness
              path when automation is unavailable.
            </p>
          </details>
        </>
      );
    }

    return (
      <>
        {actorLine(step)}
        <p>
          Pull payments keep external HBAR transfers outside the facility state
          transition.
        </p>
        <button
          className="primaryButton"
          disabled={!canWrite || actionBusy}
          onClick={withdraw}
          type="button"
        >
          Withdraw available credit
        </button>
      </>
    );
  }

  const transactionLink = hashScanTransaction(transactionHash);
  const htsSettlement =
    recipe.settlement.kind === "hts" ? recipe.settlement : undefined;

  if (htsSettlement) {
    return (
      <div className="workbenchShell">
        <header className="workbenchIntro">
          <div>
            <span className="kicker">HTS settlement candidate</span>
            <h1>One isolated rail, pending public proof.</h1>
          </div>
        </header>

        <div className="workbenchContext">
          <span>{recipe.name}</span>
          <span>Hedera testnet · 296</span>
          <span>No wallet requested</span>
        </div>

        <div className="inlineNotice" role="note">
          <b>HTS wallet actions are intentionally unavailable here.</b>
          <span>
            This recipe cannot reuse the HBAR workflow. Enable it only after
            both HTS evidence profiles pass their live verification and
            publication gates.
          </span>
        </div>

        <div className="stepBody">
          <label className="fieldLabel">
            Financing recipe
            <select
              value={recipe.id}
              onChange={(event) => chooseRecipe(event.target.value)}
            >
              {facilityRecipes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <p>{recipe.purpose}</p>
          <dl className="proofMiniLedger">
            <div>
              <dt>Settlement token</dt>
              <dd>
                {htsSettlement.symbol} · {htsSettlement.tokenId}
              </dd>
            </div>
            <div>
              <dt>Token decimals</dt>
              <dd>{htsSettlement.decimals}</dd>
            </div>
            <div>
              <dt>Valuation oracle</dt>
              <dd>Live Pyth USDC/USD</dd>
            </div>
            <div>
              <dt>Accounting boundary</dt>
              <dd>HTS liabilities and HBAR automation reserves</dd>
            </div>
          </dl>
          <p className="monoLine">
            Public Circle evidence: pending · Controlled mechanics evidence:
            pending
          </p>
          <details className="technicalDetails">
            <summary>Candidate verification commands</summary>
            <p>
              <code>yarn demo:testnet:hts:controlled</code>
            </p>
            <p>
              <code>yarn demo:testnet:hts:usdc</code>
            </p>
            <p>
              <code>yarn verify:deployment:hts</code>
            </p>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="workbenchShell">
      <header className="workbenchIntro">
        <div>
          <span className="kicker">Facility workbench</span>
          <h1>One obligation, step by step.</h1>
        </div>
        <div className="modeSwitch" aria-label="Facility mode">
          <button
            aria-pressed={mode === "reference"}
            onClick={() => setMode("reference")}
            type="button"
          >
            Reference replay
          </button>
          <button
            aria-pressed={mode === "live"}
            onClick={() => setMode("live")}
            type="button"
          >
            Live wallet
          </button>
        </div>
      </header>

      <div className="workbenchContext">
        <span>{recipe.name}</span>
        <span>Hedera testnet · 296</span>
        <span>
          {mode === "reference"
            ? referenceDeployment.status
            : "Wallet execution"}
        </span>
      </div>

      {mode === "live" && !isLiveMode && (
        <div className="inlineNotice" role="note">
          <b>Live addresses are not configured.</b>
          <span>
            Add public rail, ATS token, and oracle addresses. Signing stays in
            the connected wallet.
          </span>
        </div>
      )}

      {mode === "live" && isLiveMode && isConnected && !correctChain && (
        <div className="inlineNotice" role="alert">
          <b>Wrong network.</b>
          <span>
            The connected wallet is on chain {chainId}. Transactions require
            Hedera testnet chain {HEDERA_TESTNET_CHAIN_ID}.
          </span>
          <button
            className="secondaryButton"
            disabled={isSwitching}
            onClick={switchToTestnet}
            type="button"
          >
            {isSwitching ? "Switching" : "Switch to testnet"}
          </button>
        </div>
      )}

      <div className="facilitySteps">
        {steps.map(([title, actor], index) => (
          <FacilityStep
            active={activeStep === index}
            actor={mode === "live" ? expectedActor(index) : actor}
            completed={completed.has(index)}
            index={index}
            key={title}
            onSelect={() => setActiveStep(index)}
            receipt={mode === "reference" ? "Reviewed" : "Confirmed"}
            title={title}
          >
            {mode === "reference" ? referenceBody(index) : liveBody(index)}
          </FacilityStep>
        ))}
      </div>

      <div className="statusLine" role="status">
        <b className="actionState" data-state={actionState}>
          {actionState === "signature"
            ? "Awaiting signature"
            : actionState === "mining"
              ? "Awaiting receipt"
              : actionState === "success"
                ? "Confirmed"
                : actionState === "error"
                  ? "Action required"
                  : "Ready"}
        </b>
        <span>{message}</span>
        {transactionLink && (
          <a href={transactionLink} rel="noopener noreferrer" target="_blank">
            View receipt
          </a>
        )}
        {mode === "live" && address && <small>Signer {address}</small>}
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
