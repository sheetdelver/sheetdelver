# State Machine Test

This interactive test script verifies that `SocketFoundryClient` correctly detects and handles all Foundry VTT state transitions by **connecting directly to the Foundry server**.

## What This Tests

This test verifies the **backend state detection logic** in `SocketFoundryClient.ts`, not the frontend UI. It:
- Creates a direct connection to your Foundry server
- Calls `client.status` and `client.getSystem()` to check state
- Verifies that the state machine correctly identifies: setup, startup, connected, loggedIn states
- Tests state transitions as you manipulate Foundry

## Prerequisites

1. **Foundry VTT** must be running and accessible
2. **settings.yaml** must be configured at `<DATA_DIR>/config/settings.yaml` with your Foundry URL and credentials

Note: `security.service-token` is for internal privileged API bearer flow and is not used as a Foundry login credential.

## Running the Test

```bash
npm run test:states
```

## Test Scenarios

The test will guide you through the following scenarios:

### 1. Setup Mode Detection
- **Action**: Ensure Foundry is on the setup/world selection screen
- **Expected**: SheetDelver shows "No World Available" page
- **Verifies**: `status === 'setup'`

### 2. World Start Detection
- **Action**: Launch a world in Foundry
- **Expected**: SheetDelver shows "World Starting..." then transitions to login/dashboard
- **Verifies**: `status === 'startup'` → `status === 'connected'` or `'loggedIn'`

### 3. World Shutdown Detection
- **Action**: Click "Return to Setup" in Foundry
- **Expected**: SheetDelver returns to "No World Available" page
- **Verifies**: `status === 'setup'`

### 4. World Switching
- **Action**: Launch a different world
- **Expected**: SheetDelver detects the new world and shows its title
- **Verifies**: World title changes, status transitions correctly

### 5. Second Shutdown
- **Action**: Return to setup again
- **Expected**: SheetDelver shows "No World Available" page
- **Verifies**: Shutdown detection works consistently

### 6. Malformed URL Handling
- **Action**: Configure an invalid URL in `<DATA_DIR>/config/settings.yaml` and restart
- **Expected**: SheetDelver shows "No World Available" page with setup instructions
- **Verifies**: Graceful handling of connection failures

## Test Output

The script will output:
- ✅ for passing tests
- ❌ for failing tests
- A summary at the end with pass/fail counts

## Troubleshooting

### Test fails on Setup Mode Detection
- Ensure Foundry is actually on the setup screen (no world running)
- Check that `<DATA_DIR>/config/settings.yaml` has the correct Foundry URL
- Verify the dev server is running

### Test fails on World Start Detection
- The world may take longer than 45 seconds to start
- Check Foundry console for errors
- Ensure the world actually launched successfully

### Test fails on Shutdown Detection
- Wait a few seconds after clicking "Return to Setup"
- Check the browser console for errors
- Verify the socket connection and status checks are working

## Expected Results

All 6 tests should pass if the state machine is working correctly. If any tests fail, the output will show:
- Which test failed
- What was expected
- What was actually received

## Notes

- The test uses the `/api/session/connect` endpoint to check state
- Each test waits for state transitions with appropriate delays
- The malformed URL test requires manual verification
- Don't forget to restore your `<DATA_DIR>/config/settings.yaml` after the malformed URL test!
