#!/usr/bin/python3
from decimal import Decimal, ROUND_HALF_UP
import sys

amount_cents = Decimal(sys.argv[1])
tax_cents = (amount_cents * Decimal("0.08")).quantize(
    Decimal("1"), rounding=ROUND_HALF_UP
)
print(int(tax_cents))
