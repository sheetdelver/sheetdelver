# Socket Client Tests

This directory contains tests for the `SocketFoundryClient` to validate that it can replace Playwright functionality for interacting with Foundry VTT.

## Test Structure

Tests are organized by functionality and numbered for execution order:

1. **01-connection.test.ts** - Basic connection and authentication
2. **02-system-info.test.ts** - System information retrieval
3. **03-actor-access.test.ts** - Actor data access
4. **04-users-compendia.test.ts** - User lists and compendium access
5. **05-write-operations.test.ts** - Safe CRUD/write operations
6. **09-rolling.test.ts** - Rolling operations
7. **10-batch-operations.test.ts** - Batch document operations

`run-all.ts` self-checks this directory: every root `*.test.ts` file must be registered in the runner. Exploratory, hard-coded, or interactive scripts belong in `manual/*.manual.ts`.

## Running Tests

### Run All Tests
```bash
npm run test:socket
```

### Run Individual Tests
```bash
npm run test:socket:connection  # Test 1: Connection
npm run test:socket:system      # Test 2: System Info
npm run test:socket:actors      # Test 3: Actor Access
npm run test:socket:users       # Test 4: Users & Compendia
npm run test:socket:write       # Test 5: Write operations
npm run test:socket:rolling     # Test 9: Rolling operations
npm run test:socket:batch       # Test 10: Batch operations
```

### Manual Probes

Manual socket probes live in `src/tests/socket/manual`. Run them directly with `npx tsx` when investigating a live Foundry instance:

```bash
npx tsx src/tests/socket/manual/03-world-transition.manual.ts
```

Manual probes may prompt for input, write debug output under `temp/`, or depend on hard-coded world/module data. They are not part of `npm run test:socket`.

## Prerequisites

1. **Environment Variable**: Set `FOUNDRY_PASSWORD` in your environment or `.env` file
2. **Foundry Server**: Ensure your target Foundry VTT server is running (configured in `settings.yaml`)
3. **Test User**: A valid user (e.g. Gamemaster or Assistant) must exist in the world
4. **Safety Check Disabled**: Tests will temporarily disable the safety check in `SocketClient.connect()`

Note: `security.service-token` / `APP_SERVICE_TOKEN` is for internal privileged API bearer flow and is not a replacement for Foundry user login credentials used by these socket tests.

## Test Categories

### Phase 1: Read-Only Operations (Safe)
- ✅ Connection and authentication
- ✅ System information retrieval
- ✅ Actor data access
- ✅ User lists
- ✅ Compendium indices

### Phase 2: Write Operations
- ✅ Actor creation
- ✅ Actor updates
- ✅ Item manipulation
- ✅ Batch document operations

## Safety Notes

> [!CAUTION]
> The socket connection is currently protected by a safety check that throws an error. Tests temporarily disable this check. **Monitor the Foundry server for stability during testing.**

## Expected Output

Each test will output:
- ✅ Success indicators for passing tests
- ❌ Failure indicators with error messages
- 📊 Summary with pass/fail counts

Example:
```
🧪 Test 1: Connection & Authentication

📡 Connecting...
✅ Connected successfully!
✅ Authentication successful (userId present in session)
📡 Disconnected

📊 1/1 tests passed
```

## Troubleshooting

### Connection Fails
- Verify Foundry server is running
- Check `FOUNDRY_PASSWORD` environment variable
- Ensure a valid user exists (as configured in settings.yaml)

### Server Crashes
- Re-enable the safety check in `SocketClient.ts`
- Report the issue with server logs
- Use passive connection mode only

### Tests Timeout
- Increase timeout in test files
- Check network connectivity
- Verify Foundry is not overloaded
