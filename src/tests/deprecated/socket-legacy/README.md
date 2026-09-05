# Deprecated Socket Legacy Tests

These files are preserved as historical scaffolding from earlier socket/session shapes. They are not wired into any runner because the current socket boundary and service layering have moved on.

Before re-enabling any file here, port it to the current route-client/session APIs and move it into either `src/tests/unit`, `src/tests/socket`, or `src/tests/socket/manual` depending on whether it is deterministic, live-Foundry, or operator-driven.
