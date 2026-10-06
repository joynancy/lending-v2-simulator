# XRPL Lending V2 — Collateral Management Simulator

An interactive simulator implementing the rules in the Collateral Management PRD:
ILTV draw gate, LLTV liquidation gate, revolving draws, all-or-nothing vs arrears-only
liquidation depth, liquidation buffer, surplus retention, and the FLC waterfall.

Includes the PRD's Appendix A worked example as a one-click preset.

## Deploy
This is a standard Vite + React project. Vercel detects it automatically:
build command `npm run build`, output directory `dist`.

## Run locally
```
npm install
npm run dev
```
