# CLPR live-session checklist

Date: September 30, 2026

Record each answer in issue #15 with the speaker, source, and any public commit
or environment identifier. Treat an answer as guidance until public code or a
measured run confirms it.

## Questions

1. Which LFDT CLPR commit or future tag should external application developers
   use as the compatibility target?
2. Is bidirectional Hiero state-proof generation available outside the current
   public harness? If yes, which ProofService and Block Node versions provide it?
3. Which hosted ledgers, CLPR services, channels, verifiers, endpoints, and
   connectors may early adopters use?
4. Is the native Hiero CLPR application API stable enough for a bounty
   prototype, or should applications target the EVM service interface?
5. What finality and timeout behavior should a financial application assume?
6. What recovery model is recommended when a channel, endpoint, or proof
   producer is unavailable after one ledger may have committed value?
7. Are canonical collateral-mobility payloads or sample applications planned?
8. Does the Scaffold-HBAR bounty treat an isolated ATS plus CLPR experiment as
   load-bearing integration when the existing HBAR fallback remains intact?
9. Which local, Solo, hosted, and evidence artifacts should the final submission
   expose to judges?

## Decisions after the session

- Keep the current commit pins unless maintainers identify a replacement.
- Enable hosted execution only after documenting exact public endpoints,
  credentials boundaries, costs, and cleanup behavior.
- Never weaken safe freezing during total proof unavailability merely to make a
  demo appear live.
- Update public support claims only after the matching command has succeeded and
  its evidence record has passed validation and secret scanning.
