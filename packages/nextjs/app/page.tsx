import Link from "next/link";
import { RecipeExplorer } from "@/components/RecipeExplorer";
import { isTransactionProof } from "@/lib/proofs";
import { referenceDeployment } from "@/lib/reference";
import { presentOracleEvidence } from "@/lib/oracle-evidence";

export default function OverviewPage() {
  const repaid = referenceDeployment.positions.find(
    (position) => position.state === "REPAID",
  );
  const defaulted = referenceDeployment.positions.find(
    (position) => position.state === "DEFAULTED",
  );
  const verifiedTransactions =
    referenceDeployment.transactions.filter(isTransactionProof).length;
  const oracleEvidence = presentOracleEvidence(referenceDeployment);

  return (
    <main className="homePage">
      <section className="homeFrame promiseFrame">
        <div className="frameIndex">01 / Promise</div>
        <div className="promiseCopy">
          <span className="kicker">A reusable financing kernel for Hedera</span>
          <h1>Finance an ATS security.</h1>
          <p>
            Start without rebuilding custody, compliance ordering, oracle
            safety, maturity automation, or public proof. Change the financing
            policy, not the safety model.
          </p>
          <Link className="primaryButton" href="#recipes">
            Explore a financing recipe
          </Link>
        </div>
        <p className="frameAside">
          One tested kernel combines ATS holds, exact HBAR accounting, typed
          settlement conversion, HSS automation, and Mirror evidence.
        </p>
      </section>

      <section className="homeFrame recipeFrame" id="recipes">
        <div className="frameIndex">02 / Recipe</div>
        <RecipeExplorer />
      </section>

      <section className="homeFrame proofFrame">
        <div className="frameIndex">03 / Proof</div>
        <div className="proofIntro">
          <span className="kicker">Public testnet evidence</span>
          <h2>Every claim has a source.</h2>
          <p>
            The reference record separates contract state, ATS balances, the
            {` ${oracleEvidence.label}, `}HSS schedules, authoritative Mirror
            sources, and secondary HashScan links. Missing proof stays visibly
            pending.
          </p>
          <dl className="proofStatus" aria-label="Reference evidence status">
            <div>
              <dt>Status</dt>
              <dd>{referenceDeployment.status}</dd>
            </div>
            <div>
              <dt>Mirror-confirmed transactions</dt>
              <dd>{verifiedTransactions}</dd>
            </div>
          </dl>
          <Link className="primaryButton" href="/verify?position=repaid">
            Verify the lifecycle
          </Link>
        </div>
        <div className="terminalLines" aria-label="Reference terminal paths">
          <div>
            <span>Repaid path</span>
            <b>{repaid ? "Verified" : "Awaiting publication"}</b>
            <small>
              {repaid ? `Hold ${repaid.holdId}` : "No claim invented"}
            </small>
          </div>
          <div>
            <span>Default path</span>
            <b>{defaulted ? "Verified" : "Awaiting publication"}</b>
            <small>
              {defaulted
                ? `${defaulted.terminalPath.replaceAll("-", " ")} observed on testnet`
                : "No claim invented"}
            </small>
          </div>
        </div>
      </section>
    </main>
  );
}
