"""Tidepool Dip Bot — a staged dip-buy bot for cbBTC/USDC on make.fun.

Strategy (all rules are generic; nothing is fitted to a date, a price level or a
timestamp of any window):

  * The bot watches the 1-minute bars of CBBTC that the harness sends in every
    batch, keeps the highest close of the last 240 bars (4 hours) as its
    reference high, and buys the dip in two stages:
      - stage 1: the close falls 1.5% or more below the 240-bar high -> buy
        with 30% of equity;
      - stage 2: the close falls 2.5% or more below the same high -> buy
        with 70% of equity (the rest of the cash).
    A dip is measured against a trailing high, never against a fixed price, so
    the same rule arms on any 24-hour window, rising, falling or chopping.
  * Exits are staged too, measured against the position's own cost basis:
      - sell half the position once it is worth 1.0% over its cost;
      - sell the rest once it is worth 2.2% over its cost;
      - a trailing stop sells everything if the position's value falls 1.2%
        below its peak since entry while still in profit;
      - a stop-loss sells everything if the position falls 4.0% under cost.
  * One order per batch at most, sells decided before buys, and no buy on a
    batch where a sell was just sent (a sell's proceeds never fund a buy of
    the same reply, and a full exit is never re-bought on the same bar).
  * All arithmetic is integer basis points on the integer prices the bars
    carry, so two runs on the same bars produce the same orders byte for byte.
    No network, no wall clock, no files, no randomness.

The bot speaks agent-fun/bars-replay/v1 through the kit's Python shim, which
is vendored byte-identical under vendor/ (see vendor/makefun_bars.py). Every
batch the harness sends carries one bar, the fills of the previous batch's
orders and the account; the bot answers each batch with exactly one reply
echoing its seq. Orders decided on a batch fill at the next bar's open, so the
bot sizes every buy against the cash it holds when it decides.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"
# Reference high: the highest close of the last 240 bars (4 hours).
HIGH_BARS = 240
# Entry stages: (dip below the reference high, in bps; share of equity, in bps).
STAGE_DIPS_BPS = (150, 250)
STAGE_SIZE_BPS = (3000, 7000)
# Take-profit stages: (gain over cost, in bps; share of the position sold).
TP_GAIN_BPS = (100, 220)
TP_SELL_BPS = (5000, 10000)
# Trailing stop: sell all if the position value falls this far below its peak
# since entry, while still above cost. Stop-loss: sell all this far under cost.
TRAIL_BPS = 120
STOP_BPS = 400
# Slippage cap on every order, 1% past the close the order was decided on.
MAX_SLIPPAGE_BPS = 100


class TidepoolDipBot:
    """State for one run: bar history plus the cycle's entry/exit progress."""

    def __init__(self):
        self.closes = []
        # Next entry stage to fire (0, 1, or 2 when fully entered).
        self.stage = 0
        # Next take-profit level to fire (0, 1, or 2 when fully exited).
        self.tp_stage = 0
        # Peak value of the open position since the cycle began, micro-USDC.
        self.peak_value = None
        # The one order sent on the previous batch, if any: ("buy"|"sell",).
        self.pending = None
        # Position quantity after the previous batch, to reconcile fills.
        self.prev_qty = 0

    def reference_high(self):
        """Highest close of the last HIGH_BARS bars (all of them, early on)."""
        window = self.closes[-HIGH_BARS:]
        return max(window) if window else None

    def reconcile(self, state, batch):
        """Fold the previous batch's fills into the cycle state.

        A fill arrives exactly one batch after its order was sent. A buy that
        filled advances the entry stage; a sell that filled advances the
        take-profit stage, or resets the whole cycle when it emptied the
        position. A rejected order leaves the stage untouched, so the same
        rule simply retries on the next bar while its reason still holds.
        """
        if self.pending is None:
            return
        held = state.positions.get(SYMBOL)
        qty = held.qty if held is not None else 0
        side = self.pending
        self.pending = None
        if qty == self.prev_qty:
            return  # the order was rejected (or filled for nothing): retry later
        if side == "buy":
            self.stage += 1
        elif side == "sell":
            if qty == 0:
                self.stage = 0
                self.tp_stage = 0
                self.peak_value = None
            else:
                self.tp_stage += 1
        if qty > 0:
            # A fill repriced the position: restart the peak at its value now,
            # so a partial sale cannot trip the trailing stop by itself.
            self.peak_value = state.value(SYMBOL, qty)
        self.prev_qty = qty

    def on_batch(self, state, batch):
        for bar in batch["bars"]:
            if bar["symbol"] == SYMBOL:
                self.closes.append(int(bar["c"]))
        self.reconcile(state, batch)
        if state.warming_up:
            return []

        held = state.positions.get(SYMBOL)
        qty = held.qty if held is not None else 0
        orders = []

        if qty > 0:
            value = state.value(SYMBOL, qty)
            cost = held.cost
            if self.peak_value is None or value > self.peak_value:
                self.peak_value = value
            sell_frac_bps = 0
            if self.tp_stage < len(TP_GAIN_BPS) and value * 10000 >= cost * (10000 + TP_GAIN_BPS[self.tp_stage]):
                sell_frac_bps = TP_SELL_BPS[self.tp_stage]
            elif value * 10000 <= cost * (10000 - STOP_BPS):
                sell_frac_bps = 10000
            elif (
                value > cost
                and self.peak_value is not None
                and value * 10000 <= self.peak_value * (10000 - TRAIL_BPS)
            ):
                sell_frac_bps = 10000
            if sell_frac_bps > 0:
                sell_qty = qty * sell_frac_bps // 10000
                if sell_qty <= 0:
                    sell_qty = qty
                orders.append(
                    {
                        "side": "sell",
                        "symbol": SYMBOL,
                        "qty": sell_qty,
                        "max_slippage_bps": MAX_SLIPPAGE_BPS,
                    }
                )
                self.pending = "sell"
                self.prev_qty = qty
                return orders

        if self.stage < len(STAGE_DIPS_BPS):
            high = self.reference_high()
            close = state.close(SYMBOL)
            if high is not None and close is not None and high > 0:
                dip_bps = (high - close) * 10000 // high
                if dip_bps >= STAGE_DIPS_BPS[self.stage]:
                    spend = state.equity * STAGE_SIZE_BPS[self.stage] // 10000
                    room = state.weight_room(SYMBOL)
                    if spend > room:
                        spend = room
                    if spend > state.cash:
                        spend = state.cash
                    if spend >= int(state.hello["fees"]["min_notional_quote_units"]):
                        orders.append(
                            {
                                "side": "buy",
                                "symbol": SYMBOL,
                                "notional_quote_units": spend,
                                "max_slippage_bps": MAX_SLIPPAGE_BPS,
                            }
                        )
                        self.pending = "buy"
                        self.prev_qty = qty
        return orders


def main():
    bot = TidepoolDipBot()
    makefun_bars.run(bot.on_batch)


if __name__ == "__main__":
    main()
