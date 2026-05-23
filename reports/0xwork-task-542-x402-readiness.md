# 0xWork Task 542: Service/x402 Readiness Check

Date: 2026-05-23

Task: https://www.0xwork.org/tasks/542

Service checked:

- Production preview: https://x402-wallet-readiness-service.vercel.app/api/800402/preview
- Agent metadata: https://x402-wallet-readiness-service.vercel.app/.well-known/agent.json
- Protected receipt endpoint: https://x402-wallet-readiness-service.vercel.app/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516

## Summary

I verified that the hosted service can be safely discovered by agents before
payment and that its protected receipt endpoint returns a machine-readable x402
payment challenge without requiring secrets, API keys, or unnecessary paid
calls.

## Readiness Findings

- The service preview endpoint is public and returns version `0.3.0`.
- The agent metadata declares ERC-8004-style identity status
  `erc-8004-ready`.
- The service publishes two paid x402 service surfaces:
  `Base wallet readiness` and `800402 agent commerce receipt`.
- The payment rail is native USDC on Base mainnet:
  `eip155:8453`.
- The accepted USDC contract is
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- The payment recipient is
  `0xb19262185bac9748e2b71674Ef48676448F7A516`.
- The protected receipt endpoint returns HTTP `402 Payment Required`.
- The x402 accept entry uses scheme `exact`, amount `2000000`
  atomic USDC units, and a 300 second timeout.
- The x402 metadata includes discovery tags:
  `800402`, `erc-8004`, `x402`, `base`, `usdc`, and `agent-commerce`.

## Commands Used

```sh
curl -fsS https://x402-wallet-readiness-service.vercel.app/api/800402/preview
curl -fsS https://x402-wallet-readiness-service.vercel.app/.well-known/agent.json
curl -i https://x402-wallet-readiness-service.vercel.app/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516
```

## Safety Notes

- No private keys, wallet secrets, auth tokens, or environment dumps were used
  in the public proof.
- The check did not submit any paid x402 transaction.
- The proof only verifies discovery, payment requirements, and published
  metadata.

