// Tidepool Dip Bot — a staged dip-buy bot for cbBTC/USDC on make.fun.
//
// Strategy (all rules are generic; nothing is fitted to a date, a price level
// or a timestamp of any window):
//
//   * The bot watches the 1-minute bars of CBBTC that the harness sends in
//     every batch, keeps the highest close of the last 240 bars (4 hours) as
//     its reference high, and buys the dip in two stages:
//       - stage 1: the close falls 1.5% or more below the 240-bar high ->
//         buy with 20% of equity;
//       - stage 2: the close falls 2.5% or more below the same high -> buy
//         with 80% of equity (the rest of the cash). The deeper stage takes
//         the larger share, because the edge of a dip-buy grows with depth.
//     A dip is measured against a trailing high, never against a fixed price,
//     so the same rule arms on any 24-hour window, rising, falling or
//     chopping. The high must also be fresh — set within the last 60 bars —
//     because a dip from a fresh high is a pullback, while a decline from a
//     high set hours ago is a downtrend the bot stays out of.
//   * Exits are staged too, measured against the position's own cost basis:
//       - sell half the position once it is worth 1.0% over its cost;
//       - sell the rest once it is worth 2.2% over its cost;
//       - a trailing stop sells everything if the position's value falls
//         1.2% below its peak since entry while still in profit;
//       - a stop-loss sells everything if the position falls 4.0% under cost.
//   * Reload: after the first take-profit banks half the position, a fresh
//     dip of 2.0% or more below the same reference high buys the freed cash
//     back in (at most twice per cycle), and the take-profits re-arm on the
//     blended cost — so a choppy recovery is traded dip by dip instead of
//     sat through, while the banked profit and the stop-loss cap the risk.
//   * One order per batch at most, sells decided before buys, and no buy on a
//     batch where a sell was just sent (a sell's proceeds never fund a buy of
//     the same reply, and a full exit is never re-bought on the same bar).
//   * All arithmetic is integer basis points on the integer prices the bars
//     carry, so two runs on the same bars produce the same orders byte for
//     byte. No network, no wall clock, no files, no randomness.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's TypeScript shim,
// vendored byte-identical under vendor/ (see vendor/makefun-bars.ts). Every
// batch the harness sends carries one bar, the fills of the previous batch's
// orders and the account; the bot answers each batch with exactly one reply
// echoing its seq. Orders decided on a batch fill at the next bar's open, so
// the bot sizes every buy against the cash it holds when it decides.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Reference high: the highest close of the last 240 bars (4 hours). */
const HIGH_BARS = 240;
/** Freshness window: the reference high must have been set within these bars. */
const FRESH_BARS = 60;
/** Entry stages: dip below the reference high, in bps. */
const STAGE_DIPS_BPS = [150n, 250n];
/** Entry stages: share of equity spent, in bps. The deeper stage takes the
 * larger share: the edge of a dip-buy grows with the depth of the dip. */
const STAGE_SIZE_BPS = [2000n, 8000n];
/** Take-profit stages: gain over cost, in bps. */
const TP_GAIN_BPS = [100n, 220n];
/** Take-profit stages: share of the position sold, in bps. */
const TP_SELL_BPS = [5000n, 10000n];
/** Reload: once the first take-profit has banked half the position, a fresh
 * dip of this size below the reference high buys the freed cash back in.
 * Share of equity spent per reload, and how many reloads one cycle allows. */
const RELOAD_DIP_BPS = 200n;
const RELOAD_SIZE_BPS = 5000n;
const MAX_RELOADS = 2;
/** Trailing stop: sell all if the position value falls this far below its peak since entry, while still above cost. */
const TRAIL_BPS = 120n;
/** Stop-loss: sell all this far under cost. */
const STOP_BPS = 400n;
/** Slippage cap on every order, 1% past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;

/** State for one run: bar history plus the cycle's entry/exit progress. */
class TidepoolDipBot {
  closes: bigint[] = [];
  /** Next entry stage to fire (0, 1, or 2 when fully entered). */
  stage = 0;
  /** Next take-profit level to fire (0, 1, or 2 when fully exited). */
  tpStage = 0;
  /** Reloads still allowed in this cycle (re-buys after the first take-profit). */
  reloadsLeft = MAX_RELOADS;
  /** Peak value of the open position since the cycle began, micro-USDC. */
  peakValue: bigint | null = null;
  /** The one order sent on the previous batch, if any: 'buy', 'sell' or 'reload'. */
  pending: 'buy' | 'sell' | 'reload' | null = null;
  /** Position quantity after the previous batch, to reconcile fills. */
  prevQty = 0n;

  /** Highest close of the last HIGH_BARS bars (all of them, early on). */
  referenceHigh(): bigint | null {
    const window = this.closes.slice(-HIGH_BARS);
    if (window.length === 0) return null;
    let high = window[0]!;
    for (const c of window) if (c > high) high = c;
    return high;
  }

  /**
   * Whether the reference high is fresh: the highest close of the last 60
   * bars equals the 240-bar high, so the high was set within the last hour.
   * A dip from a fresh high is a pullback (the setup this bot trades); a
   * decline from a high set hours ago is a downtrend, and the bot stays out.
   */
  highIsFresh(): boolean {
    const recent = this.closes.slice(-FRESH_BARS);
    if (recent.length === 0) return false;
    let highRecent = recent[0]!;
    for (const c of recent) if (c > highRecent) highRecent = c;
    return highRecent === this.referenceHigh();
  }

  /**
   * Fold the previous batch's fills into the cycle state.
   *
   * A fill arrives exactly one batch after its order was sent. A buy that
   * filled advances the entry stage; a sell that filled advances the
   * take-profit stage, or resets the whole cycle when it emptied the
   * position. A rejected order leaves the stage untouched, so the same rule
   * simply retries on the next bar while its reason still holds.
   */
  reconcile(state: BarsState, _batch: Batch): void {
    if (this.pending === null) return;
    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;
    const side = this.pending;
    this.pending = null;
    if (qty === this.prevQty) return; // the order was rejected: retry later
    if (side === 'buy') {
      this.stage += 1;
    } else if (side === 'reload') {
      // A re-buy after the first take-profit: the cost basis blends, so the
      // take-profits re-arm on the blended position; one reload is spent.
      this.reloadsLeft -= 1;
      this.tpStage = 0;
    } else if (side === 'sell') {
      if (qty === 0n) {
        this.stage = 0;
        this.tpStage = 0;
        this.reloadsLeft = MAX_RELOADS;
        this.peakValue = null;
      } else {
        this.tpStage += 1;
      }
    }
    if (qty > 0n) {
      // A fill repriced the position: restart the peak at its value now, so a
      // partial sale cannot trip the trailing stop by itself.
      this.peakValue = state.value(SYMBOL, qty);
    }
    this.prevQty = qty;
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.closes.push(BigInt(bar.c));
    }
    this.reconcile(state, batch);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;
    const orders: OrderInput[] = [];

    if (qty > 0n) {
      const value = state.value(SYMBOL, qty);
      const cost = held!.cost;
      if (this.peakValue === null || value > this.peakValue) this.peakValue = value;
      let sellFracBps = 0n;
      if (this.tpStage < TP_GAIN_BPS.length && value * BPS >= cost * (BPS + TP_GAIN_BPS[this.tpStage]!)) {
        sellFracBps = TP_SELL_BPS[this.tpStage]!;
      } else if (value * BPS <= cost * (BPS - STOP_BPS)) {
        sellFracBps = BPS;
      } else if (
        value > cost &&
        this.peakValue !== null &&
        value * BPS <= this.peakValue * (BPS - TRAIL_BPS)
      ) {
        sellFracBps = BPS;
      }
      if (sellFracBps > 0n) {
        let sellQty = (qty * sellFracBps) / BPS;
        if (sellQty <= 0n) sellQty = qty;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        orders.push(sell);
        this.pending = 'sell';
        this.prevQty = qty;
        return orders;
      }
    }

    if (this.stage < STAGE_DIPS_BPS.length) {
      const high = this.referenceHigh();
      const close = state.close(SYMBOL);
      if (high !== null && close !== null && high > 0n && this.highIsFresh()) {
        const dipBps = high > close ? ((high - close) * BPS) / high : 0n;
        if (dipBps >= STAGE_DIPS_BPS[this.stage]!) {
          let spend = (state.equity * STAGE_SIZE_BPS[this.stage]!) / BPS;
          const room = state.weightRoom(SYMBOL);
          if (spend > room) spend = room;
          if (spend > state.cash) spend = state.cash;
          if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
            const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
            orders.push(buy);
            this.pending = 'buy';
            this.prevQty = qty;
          }
        }
      }
    } else if (this.tpStage === 1 && this.reloadsLeft > 0 && qty > 0n) {
      // Reload: the first take-profit banked half the position; a fresh dip
      // below the same reference high buys the freed cash back in, and the
      // take-profits re-arm on the blended cost. The dip is measured against
      // the cycle's reference high, not a fresh one: the chop after a bounce
      // retests the same high, and the banked profit plus the stop-loss cap
      // the downside of re-adding there.
      const high = this.referenceHigh();
      const close = state.close(SYMBOL);
      if (high !== null && close !== null && high > 0n) {
        const dipBps = high > close ? ((high - close) * BPS) / high : 0n;
        if (dipBps >= RELOAD_DIP_BPS) {
          let spend = (state.equity * RELOAD_SIZE_BPS) / BPS;
          const room = state.weightRoom(SYMBOL);
          if (spend > room) spend = room;
          if (spend > state.cash) spend = state.cash;
          if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
            const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
            orders.push(buy);
            this.pending = 'reload';
            this.prevQty = qty;
          }
        }
      }
    }
    return orders;
  }
}

const bot = new TidepoolDipBot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
