#!/usr/bin/ruby
amount_cents = Integer(ARGV.fetch(0), 10)
mode = ARGV.fetch(1)

if amount_cents.negative?
  warn("amount must be nonnegative")
  exit(2)
elsif mode == "refund"
  puts("refund:#{amount_cents}")
elsif mode == "tax"
  puts(amount_cents * 8 / 100)
else
  warn("unsupported mode: #{mode}")
  exit(2)
end
