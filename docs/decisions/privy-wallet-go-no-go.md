# Privy automatic wallet decision: no-go pending non-production proof

Date: 2026-08-03

Decision: keep `ensure_payout_wallet` fail-closed as `feature_unavailable` and
ship the independently verifiable external Ethereum address path first. This is
not a rejection of Privy; it is a custody and identity gate that cannot be
proven without the dedicated development app/environment.

The go decision requires evidence that:

- the Privy user is bound to immutable numeric GitHub id, never mutable login;
- the wallet is user-owned, Ethereum mainnet, deterministic/index `0`, and
  repeated ensure calls cannot create duplicates;
- Harness Arena cannot read/export a private key or expose signing/payments to
  MCP; recovery/export/deletion is a browser-only user flow;
- webhook signatures are verified before inserting a durable receipt, invalid
  attempts cannot poison an event id, and duplicate/out-of-order delivery is
  deterministic;
- production and development tenants/credentials/data are isolated;
- deletion, account recovery, consent, terms, costs, support, and incident
  response are accepted by the owner.

Until all items pass, no provider request is made by the wallet ensure API and
no Privy identifier is stored. The payout profile supports one verified
user-controlled Ethereum-mainnet external address, and MCP cannot transfer or
sign funds.

