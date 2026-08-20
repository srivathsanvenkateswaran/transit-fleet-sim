# Committed wire evidence

These files are raw response bodies and headers captured from the running
service. The process used a frozen clock and forced full coverage plus confirmed
duty so repeated captures are stable:

```text
PORT=3103
SIM_CLOCK=2026-08-20T09:41:26Z
BUS_COVERAGE_SHARE=1
DUTY_CONFIRMED_SHARE=1
DUTY_INFERRED_SHARE=0
DUTY_UNKNOWN_SHARE=0
DUTY_OUT_OF_SERVICE_SHARE=0
```

The JSON was written directly by `curl -o`; it was not parsed, reformatted or
edited. `tests/evidence/evidence.test.ts` parses these committed bytes on every
test run and asserts the claims made by the API contract.
