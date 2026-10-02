"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { isLiveMode } from "@/lib/chain";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const requestedLive =
    pathname === "/facility" && searchParams.get("mode") === "live";
  const walletMode = isLiveMode && requestedLive;

  return (
    <header className="siteHeader">
      <Link className="wordmark" href="/">
        <span className="mark" aria-hidden="true">
          R/C
        </span>
        <span>RWA Credit Rail</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/">Recipes</Link>
        <Link href="/facility">Facility</Link>
        <Link href="/verify">Verify</Link>
      </nav>
      <div className="headerActions">
        <span className={`modePill ${walletMode ? "live" : "reference"}`}>
          {walletMode
            ? "Live testnet"
            : requestedLive
              ? "Live unavailable"
              : "Reference mode"}
        </span>
        {!walletMode ? (
          <span className="walletButton noWallet">No wallet required</span>
        ) : isConnected && address ? (
          <button
            className="walletButton"
            onClick={() => disconnect()}
            type="button"
          >
            {shortAddress(address)}
          </button>
        ) : (
          <button
            className="walletButton"
            disabled={!connectors[0] || isPending}
            onClick={() =>
              connectors[0] && connect({ connector: connectors[0] })
            }
            type="button"
          >
            {isPending ? "Connecting" : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
