External cron ping (reliable every 10 minutes):

1) Create a GitHub PAT with scope: workflow
2) Use this curl command on any cron service:

curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR_PAT>" \
  https://api.github.com/repos/Mr-Destructive/flight-observatory/actions/workflows/ingest.yml/dispatches \
  -d '{"ref":"main"}'

You can also trigger by workflow ID if needed.
