# Real sales checklist walkthrough

1. Start the upstream-only catalog fixture:

   ```powershell
   node admin/e2e/sales-real-ui-catalog/ledger-catalog-fixture.mjs
   ```

2. Set `LEDGER_PUBLIC_URL=http://127.0.0.1:5457`, `NESSIE_MODEL_BASE_URL=http://127.0.0.1:5457/v1/mock-llm`, and a local `NESSIE_MODEL_API_KEY`, then start Nessie on ports 5454/5455.

3. After bootstrapping the isolated UI database and creating the local agent/template/board/task through visible UI, run:

   ```powershell
   $env:NESSIE_UI_BOARD_PATH = '/projects/<project>/board?board=<board>'
   $env:NESSIE_UI_TASK_TITLE = 'Checklist persistence task'
   $env:NESSIE_UI_CHECKLIST_STEP = 'Confirm result'
   node admin/e2e/sales-real-ui-catalog/run.mjs
   ```

The driver toggles completion, saves a result, reloads and verifies both, then clears only the result and verifies completion remains set after a second reload.

The fixture implements that catalog contract only; no Nessie API route is intercepted.
