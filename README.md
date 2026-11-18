# cbbtc-staged-dip-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/ddyss7676/cbbtc-staged-dip-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/ddyss7676/cbbtc-staged-dip-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Tidepool Dip Bot — a staged dip-buy trading bot for cbBTC/USDC. Built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.

## Run it

```sh
python3 -P -s main.py
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) and is graded with the kit's local grader:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repository> --driver docker
```

## Strategy

Simulation only: the bot trades $1,000 of paper money against 1-minute on-chain cbBTC prices (Orca Whirlpool, Solana). Nothing is traded for real.

- **Reference high:** the highest close of the last 240 bars (4 hours).
- **Staged dip entries:** buy 30% of equity when the close falls 1.5% below the reference high; buy the remaining 70% when it falls 2.5% below it. The dip is always measured against a trailing high, never a fixed price or timestamp, so the rule arms on any 24-hour window.
- **Staged take-profits:** sell half the position at +1.0% over its cost, the rest at +2.2% over cost.
- **Trailing stop:** sell everything if the position's value falls 1.2% below its peak since entry while still in profit.
- **Stop-loss:** sell everything at 4.0% under cost.
- **Discipline:** at most one order per batch, sells before buys, no buy on a batch where a sell was sent, 1% slippage cap on every order. All arithmetic is integer basis points, so two runs on the same bars produce identical orders.

## Layout

- `main.py` — the bot (Python 3.13, standard library only).
- `vendor/makefun_bars.py` — the kit's protocol shim, copied byte-identical from the competition kit.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=en1fh11t&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
