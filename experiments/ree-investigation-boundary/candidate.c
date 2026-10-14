#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;

  const double unit_price = strtod(argv[1], NULL);
  const double quantity = strtod(argv[2], NULL);
  printf("%.2f\n", floor(unit_price * quantity + 0.5));
  return 0;
}
