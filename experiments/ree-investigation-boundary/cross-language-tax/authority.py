#!/usr/bin/python3
from decimal import Decimal, ROUND_HALF_UP
import sys

amount_cents = Decimal(sys.argv[1])
mode = sys.argv[2]

if amount_cents < 0:
    print("amount must be nonnegative", file=sys.stderr)
    raise SystemExit(2)
if mode == "refund":
    print(f"refund:{int(amount_cents)}")
elif mode == "tax":
    tax_cents = (amount_cents * Decimal("0.08")).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    )
    print(int(tax_cents))
else:
    print(f"unsupported mode: {mode}", file=sys.stderr)
    raise SystemExit(2)
