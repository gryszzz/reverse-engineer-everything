#!/usr/bin/ruby
amount_cents = Integer(ARGV.fetch(0), 10)
puts(amount_cents * 8 / 100)
