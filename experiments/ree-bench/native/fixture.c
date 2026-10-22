/* Owned accuracy fixture. It is not a third-party program and is not launched by the bench. */
static const char MARKER[] = "ree-bench-marker";

int add_one(int value) {
  return value + 1;
}

void entry(void) {
  add_one((int)MARKER[0]);
}
